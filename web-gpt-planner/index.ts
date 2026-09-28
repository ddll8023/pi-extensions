import { Type } from "typebox";
import { estimateTokens, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { checkTaskBudget, DEFAULT_TASK_TEXT_BUDGET } from "./context-budget.ts";
import { containsLikelySecret, createOutboundExchange, exchangeFingerprint, MAX_WEB_ROUNDS, validateSourcePath, type OutboundKind } from "./exchange-protocol.ts";
import { EdgeClient, type ExecLike } from "./edge-client.ts";
import { ActiveTaskError, PlannerTaskStore, type PlannerTaskState } from "./state-store.ts";
import { PlannerWorker } from "./worker.ts";

const MAX_TOOL_TEXT_CHARS = 100_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function estimateTaskText(text: string): number {
  const message = { role: "user", content: [{ type: "text", text }] } as Parameters<typeof estimateTokens>[0];
  return estimateTokens(message);
}

function parseKind(value: unknown): OutboundKind {
  if (value === "NEED_CONTEXT" || value === "PLAN" || value === "REPORT") return value;
  throw new Error("kind must be NEED_CONTEXT, PLAN, or REPORT");
}

function storeFor(cwd: string): PlannerTaskStore {
  return new PlannerTaskStore(cwd, getAgentDir());
}

function createEdgeClient(pi: ExtensionAPI): EdgeClient {
  const exec: ExecLike = (command, args, options) => pi.exec(command, args, options);
  return new EdgeClient({ exec });
}

async function validateSourceFiles(projectRoot: string, values: string[]): Promise<string[]> {
  const root = await realpath(projectRoot);
  const safe: string[] = [];
  for (const value of values) {
    const relativePath = validateSourcePath(value);
    const actualPath = await realpath(resolve(root, relativePath));
    const fromRoot = relative(root, actualPath);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`source path resolves outside the project: ${relativePath}`);
    }
    if (!(await stat(actualPath)).isFile()) throw new Error(`source path is not a file: ${relativePath}`);
    safe.push(relativePath);
  }
  return safe;
}

async function confirmNewContextFiles(
  ctx: ExtensionContext,
  state: PlannerTaskState,
  sourceFiles: string[],
  text: string,
  estimatedTokens: number,
): Promise<void> {
  const allowed = new Set(state.allowedSourceFiles ?? []);
  const additions = sourceFiles.filter((path) => !allowed.has(path));
  if (additions.length === 0) return;
  if (!ctx.hasUI) throw new Error("新增网页上下文文件需要交互确认；当前运行模式没有可用 UI");
  const preview = text.length > 800 ? `${text.slice(0, 800)}\n…（预览截断，完整文本不会在此弹窗展开）` : text;
  const accepted = await ctx.ui.confirm(
    "将文本上下文发送到 ChatGPT？",
    `新增白名单路径：\n${additions.map((path) => `- ${path}`).join("\n")}\n\n本次估算 ${estimatedTokens} token。\n\n文本预览：\n${preview}`,
  );
  if (!accepted) throw new Error("用户拒绝发送新增上下文");
  state.allowedSourceFiles = [...new Set([...allowed, ...additions])];
}

async function requireGitIgnored(pi: ExtensionAPI, cwd: string): Promise<void> {
  const gitRoot = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
  if (gitRoot.code !== 0) return;
  const root = resolve(gitRoot.stdout.trim());
  if (root !== resolve(cwd)) throw new Error(`请从项目根目录启动 Pi：${root}`);
  const ignored = await pi.exec("git", ["check-ignore", "-q", ".pi/sol-planner"], { cwd: root, timeout: 5_000 });
  if (ignored.code === 0) return;
  throw new Error(".pi/sol-planner 未被 Git 忽略；请先由用户批准并添加忽略规则，插件不会自动改 .gitignore");
}

function statusText(state: PlannerTaskState | undefined): string {
  if (!state) return "web-gpt-planner：无活动任务";
  const pending = state.pending ? `\n等待交互：${state.pending.exchangeId}` : "";
  const reason = state.pauseReason ? `\n暂停原因：${state.pauseReason}` : "";
  return [
    `任务：${state.taskId}`,
    `状态：${state.status}`,
    `阶段：${state.phaseId} / 计划 v${state.planVersion}`,
    `网页轮次：${state.roundsUsed}/${MAX_WEB_ROUNDS}`,
    `文本预算：${state.estimatedTokensUsed}/${DEFAULT_TASK_TEXT_BUDGET} 估算 token`,
    pending,
    reason,
  ].filter(Boolean).join("\n");
}

function resultText(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: undefined, ...(isError ? { isError: true } : {}) };
}

function sameConversationUrl(saved: string | undefined, current: string): boolean {
  if (!saved) return false;
  try {
    const previous = new URL(saved);
    const next = new URL(current);
    if (previous.origin !== next.origin) return false;
    const trimTrailingSlash = (path: string): string => path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
    return trimTrailingSlash(previous.pathname) === trimTrailingSlash(next.pathname);
  } catch {
    return false;
  }
}

async function rebindActivePage(client: EdgeClient, store: PlannerTaskStore, state: PlannerTaskState): Promise<void> {
  if (!state.browserPageId) throw new Error("任务没有已绑定的网页标签页；不会新建线程");
  const page = await client.findTabById(state.browserPageId);
  if (!page) throw new Error("已保存的 ChatGPT 标签页已不存在；不会自动另开线程，以免串话");
  if (!sameConversationUrl(state.chatUrl, page.url) && !(await provesSameThread(client, state))) {
    throw new Error("已保存的标签页不再指向原会话；不会重发消息");
  }
  if (state.chatUrl !== page.url) {
    state.chatUrl = page.url;
    await store.writeTask(state);
  }
}

/**
 * 会话 URL 会漂移（`/` → `/c/local-chatgpt:…` → `/c/<会话>`），单靠 URL 无法判定会话身份。
 * 因此 URL 不可比时，改用线程里是否出现本任务的信封（task_id）作为更强的证据。
 */
async function provesSameThread(client: EdgeClient, state: PlannerTaskState): Promise<boolean> {
  if (!state.browserPageId) return false;
  const evidence = await client.getTaskEvidence(state.browserPageId, state.taskId);
  return evidence.occurrences >= 1;
}

export default function webGptPlannerExtension(pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | undefined;
  let worker: PlannerWorker | undefined;
  let edgeClient: EdgeClient | undefined;

  const edgeFor = (): EdgeClient => (edgeClient ??= createEdgeClient(pi));

  const getWorker = (): PlannerWorker => {
    worker ??= new PlannerWorker({
      pi,
      storeFor,
      edgeFor: () => edgeFor(),
      getContext: () => activeContext,
    });
    return worker;
  };

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    const store = storeFor(ctx.cwd);
    const active = await store.readActive().catch(() => undefined);
    if (!active || active.projectRoot !== store.projectRoot) return;
    const state = await store.readTask(active.taskId).catch(() => undefined);
    if (!state || state.status !== "waiting" || !state.pending) return;
    try {
      await store.claimActiveForResume(active.taskId, pi.getSessionName());
      await rebindActivePage(edgeFor(), store, state);
      getWorker().start();
    } catch (error) {
      state.status = "paused";
      state.pauseReason = `恢复时无法确认原线程：${errorText(error)}；不会重新提交。`;
      await store.writeTask(state);
      ctx.ui.notify(state.pauseReason, "warning");
    }
  });

  pi.on("session_shutdown", () => {
    worker?.stop();
    worker = undefined;
    edgeClient?.dispose();
    edgeClient = undefined;
    activeContext = undefined;
  });

  pi.registerCommand("sol-plan", {
    description: "启动文本优先的 ChatGPT 网页协作任务",
    handler: async (args, ctx) => {
      const taskText = args.trim();
      if (!taskText) {
        ctx.ui.notify("用法：/sol-plan <任务>", "error");
        return;
      }
      const store = storeFor(ctx.cwd);
      try {
        await requireGitIgnored(pi, ctx.cwd);
        const task = await store.createTask({
          projectRoot: store.projectRoot,
          sessionName: pi.getSessionName(),
          taskText,
        });
        try {
          const edge = edgeFor();
          const ensured = await edge.ensureChatPage();
          const page = ensured.page;
          // 复用用户原有标签页时绝不导航，避免冲掉对方正在看的会话。
          const chatUrl = ensured.created ? await edge.startFreshChat(page.targetId) : page.url;
          task.browserPageId = page.targetId;
          task.createdTab = ensured.created;
          task.chatUrl = chatUrl || page.url;
          task.status = "preflight";
          await store.writeTask(task);
          const selection = await edge.preflight(page.targetId);
          task.selectedModel = selection.model;
          task.thinkingLevel = selection.thinkingLevel;
          task.composerMode = selection.mode;
          task.status = "gathering";
          await store.writeTask(task);
          activeContext = ctx;
          pi.sendUserMessage(`/skill:web-gpt-planner\n\nTask ID: ${task.taskId}\nOriginal task: ${taskText}`, {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          ctx.ui.notify(`已创建文本优先任务 ${task.taskId}；已绑定 Edge 专用实例的 ChatGPT 标签页（${edge.endpoint}）。`, "info");
        } catch (error) {
          task.status = "paused";
          task.pauseReason = `启动预检失败：${errorText(error)}`;
          await store.writeTask(task);
          ctx.ui.notify(`任务已保存并暂停：${task.pauseReason}`, "warning");
        }
      } catch (error) {
        const message = error instanceof ActiveTaskError ? error.message : errorText(error);
        ctx.ui.notify(`未启动协作任务：${message}`, "error");
      }
    },
  });

  pi.registerCommand("sol-status", {
    description: "查看当前网页协作任务状态",
    handler: async (_args, ctx) => {
      const store = storeFor(ctx.cwd);
      const active = await store.readActive().catch(() => undefined);
      const state = active?.projectRoot === store.projectRoot ? await store.readTask(active.taskId).catch(() => undefined) : undefined;
      ctx.ui.notify(statusText(state), "info");
    },
  });

  pi.registerCommand("sol-resume", {
    description: "核对并恢复等待中的网页协作任务",
    handler: async (_args, ctx) => {
      const store = storeFor(ctx.cwd);
      const active = await store.readActive();
      if (!active || active.projectRoot !== store.projectRoot) {
        ctx.ui.notify("当前项目没有可恢复的网页协作任务。", "warning");
        return;
      }
      const state = await store.readTask(active.taskId);
      if (!state) {
        ctx.ui.notify("活动索引存在但任务状态缺失；为避免误重发，已暂停。", "error");
        return;
      }
      if (state.stopRequested || state.status === "stopped") {
        ctx.ui.notify("该任务已停止；不会自动续跑。", "warning");
        return;
      }
      try {
        await store.claimActiveForResume(active.taskId, pi.getSessionName());
      } catch (error) {
        ctx.ui.notify(`无法接管活动任务：${errorText(error)}`, "warning");
        return;
      }
      if (state.status === "paused" && !state.pending && state.roundsUsed === 0 && state.browserPageId) {
        try {
          const edge = edgeFor();
          const ensured = await edge.ensureChatPage({ browserPageId: state.browserPageId });
          const page = ensured.page;
          if (state.chatUrl && !sameConversationUrl(state.chatUrl, page.url)) throw new Error("目标 ChatGPT 页面已改变");
          const freshChatUrl = state.createdTab === true ? await edge.startFreshChat(page.targetId) : page.url;
          const selection = await edge.preflight(page.targetId);
          state.browserPageId = page.targetId;
          state.createdTab = state.createdTab ?? ensured.created;
          state.chatUrl = freshChatUrl || page.url;
          state.selectedModel = selection.model;
          state.thinkingLevel = selection.thinkingLevel;
          state.composerMode = selection.mode;
          state.status = "gathering";
          state.pauseReason = undefined;
          await store.writeTask(state);
          activeContext = ctx;
          const brief = await store.readBrief(state.taskId);
          pi.sendUserMessage(`/skill:web-gpt-planner\n\nTask ID: ${state.taskId}\nOriginal task: ${brief.trim()}`, {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          ctx.ui.notify(`已恢复任务 ${state.taskId} 并通过网页预检。`, "info");
        } catch (error) {
          state.status = "paused";
          state.pauseReason = `恢复预检失败：${errorText(error)}`;
          await store.writeTask(state);
          ctx.ui.notify(state.pauseReason, "warning");
        }
        return;
      }
      // 已发过计划的暂停（如预检/提交异常）：重新预检后把任务交回本地会话续发下一轮，不重发上一轮。
      if (state.status === "paused" && !state.pending && state.browserPageId && state.roundsUsed > 0) {
        try {
          await rebindActivePage(edgeFor(), store, state);
          const selection = await edgeFor().preflight(state.browserPageId);
          state.selectedModel = selection.model;
          state.thinkingLevel = selection.thinkingLevel;
          state.composerMode = selection.mode;
          state.status = "plan_ready";
          state.pauseReason = undefined;
          await store.writeTask(state);
          activeContext = ctx;
          pi.sendUserMessage(`/skill:web-gpt-planner\n\nResume task ${state.taskId}. The saved phase plan is still active; submit the next exchange when ready. Current status: plan_ready, phase ${state.phaseId}, plan v${state.planVersion}.`, {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          ctx.ui.notify(`已通过网页预检，任务 ${state.taskId} 交回本地会话继续（不会重发上一轮）。`, "info");
        } catch (error) {
          state.status = "paused";
          state.pauseReason = `恢复预检失败：${errorText(error)}`;
          await store.writeTask(state);
          ctx.ui.notify(state.pauseReason, "warning");
        }
        return;
      }
      if (state.pending?.submissionState === "unknown") {
        try {
          await rebindActivePage(edgeFor(), store, state);
          const reply = await edgeFor().getReply(state.browserPageId!, state.pending!.exchangeId);
          const accepted = reply.occurrences >= 1;
          if (!accepted) {
            ctx.ui.notify("无法证明原交互是否已提交；保持暂停，不会重发。请核对同一聊天后再决定。", "warning");
            return;
          }
          state.pending.submissionState = "accepted";
          state.status = "waiting";
          state.pauseReason = undefined;
          await store.writeTask(state);
        } catch (error) {
          ctx.ui.notify(`原交互核对失败：${errorText(error)}；不会重发。`, "warning");
          return;
        }
      }
      // 超时等导致的暂停：只要原线程里仍能找到本次交互，就认作已提交并恢复等待（不重发）。
      if (state.status === "paused" && state.pending) {
        try {
          await rebindActivePage(edgeFor(), store, state);
          const reply = await edgeFor().getReply(state.browserPageId!, state.pending.exchangeId);
          if (reply.occurrences < 1) {
            ctx.ui.notify("原线程里找不到本次交互，没有发出任何内容；请用 /sol-stop 后重开任务。", "warning");
            return;
          }
          state.pending.submissionState = "accepted";
          state.status = "waiting";
          state.pauseReason = undefined;
          await store.writeTask(state);
          ctx.ui.notify(`已确认原交互已提交（线程中出现 ${reply.occurrences} 次），恢复等待回复：${state.pending.exchangeId}`, "info");
        } catch (error) {
          ctx.ui.notify(`原交互核对失败：${errorText(error)}；不会重发。`, "warning");
          return;
        }
      }
      if (state.status === "waiting" && state.pending) {
        try {
          await rebindActivePage(edgeFor(), store, state);
          activeContext = ctx;
          getWorker().start();
          ctx.ui.notify(`已恢复等待原交互 ${state.pending.exchangeId}；不会重新提交。`, "info");
        } catch (error) {
          state.status = "paused";
          state.pauseReason = `无法确认原线程：${errorText(error)}`;
          await store.writeTask(state);
          ctx.ui.notify(state.pauseReason, "warning");
        }
        return;
      }
      if (state.status === "completed") {
        await store.releaseActive(state.taskId);
        ctx.ui.notify("任务已完成；活动锁已释放。", "info");
        return;
      }
      if (["gathering", "plan_ready", "awaiting_approval", "executing", "report_ready"].includes(state.status)) {
        activeContext = ctx;
        pi.sendUserMessage(`/skill:web-gpt-planner\n\nResume task ${state.taskId}. Read the saved task state before taking any action. Current status: ${state.status}.`, {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        });
        ctx.ui.notify(`已请求本地 Pi 会话核对并恢复任务 ${state.taskId}；不会重发网页交互。`, "info");
        return;
      }
      ctx.ui.notify(statusText(state), "info");
    },
  });

  pi.registerCommand("sol-stop",  {
    description: "停止网页协作任务的后续派发",
    handler: async (_args, ctx) => {
      const store = storeFor(ctx.cwd);
      const active = await store.readActive();
      if (!active || active.projectRoot !== store.projectRoot) {
        ctx.ui.notify("当前项目没有活动任务。", "info");
        return;
      }
      const state = await store.readTask(active.taskId);
      if (!state) {
        ctx.ui.notify("任务状态缺失；没有执行进一步操作。", "error");
        return;
      }
      state.stopRequested = true;
      state.status = "stopped";
      state.pauseReason = "用户请求停止";
      await store.writeTask(state);
      worker?.stop();
      await store.releaseActive(state.taskId);
      let closeNote = "";
      if (state.browserPageId && state.createdTab !== false) {
        try {
          await edgeFor().closePage(state.browserPageId);
          closeNote = "\n已关闭该任务创建的 ChatGPT 标签页。";
        } catch (error) {
          closeNote = `\n标签页关闭失败：${errorText(error)}`;
        }
      } else if (state.browserPageId) {
        closeNote = "\n该标签页是复用你原有的，未关闭。";
      }
      ctx.ui.notify(`已停止后续网页派发；不会撤回已发送消息或回滚本地文件。${closeNote}`, "warning");
    },
  });

  pi.registerTool({
    name: "web_gpt_exchange",
    label: "Web GPT exchange",
    description: "Submit one text-only, whitelist-checked exchange to the active ChatGPT planner task. Never attach files or retry an uncertain submission.",
    promptSnippet: "Submit bounded text to the active ChatGPT web planner",
    executionMode: "sequential",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("NEED_CONTEXT"), Type.Literal("PLAN"), Type.Literal("REPORT")]),
      phaseId: Type.String({ minLength: 1 }),
      planVersion: Type.Integer({ minimum: 1 }),
      text: Type.String({ minLength: 1, maxLength: MAX_TOOL_TEXT_CHARS }),
      sourceFiles: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const store = storeFor(ctx.cwd);
      const active = await store.readActive();
      if (!active || active.projectRoot !== store.projectRoot) return resultText("No active web-gpt-planner task.", true);
      if (active.pid !== process.pid) return resultText("This task is owned by another Pi process; use /sol-resume only after that process exits.", true);
      const state = await store.readTask(active.taskId);
      if (!state || !state.browserPageId) return resultText("Active task state or bound ChatGPT page is unavailable.", true);
      if (state.stopRequested || state.status === "stopped" || state.status === "completed") return resultText(`Task is ${state.status}; exchange refused.`, true);
      if (params.phaseId !== state.phaseId || params.planVersion !== state.planVersion) return resultText("Phase or plan version does not match the active task.", true);
      if (state.pending) return resultText("An exchange is already pending; do not submit a duplicate.", true);
      if (state.roundsUsed >= MAX_WEB_ROUNDS) {
        state.status = "paused";
        state.pauseReason = "网页交互已达到六轮上限";
        await store.writeTask(state);
        return resultText(state.pauseReason, true);
      }
      if (typeof params.text !== "string" || params.text.length > MAX_TOOL_TEXT_CHARS) return resultText("Exchange text is invalid or too large.", true);

      const kind = parseKind(params.kind);
      if (containsLikelySecret(params.text)) return resultText("文本疑似包含凭据或私密值；已拒绝发送。", true);
      let sourceFiles: string[];
      try {
        sourceFiles = await validateSourceFiles(state.projectRoot, params.sourceFiles);
      } catch (error) {
        return resultText(`上下文路径拒绝：${errorText(error)}`, true);
      }
      const exchangeId = randomUUID();
      const request = createOutboundExchange({
        identity: { taskId: state.taskId, exchangeId, phaseId: params.phaseId, planVersion: params.planVersion },
        kind,
        text: params.text,
        sourceFiles,
      });
      const wrappedText = [
        "请严格按 web-gpt-planner 协议只返回一个 JSON 对象，不要省略任何关联标识字段，也不要附加解释文字。",
        "响应字段（区分大小写）：protocol_version 固定为 1；task_id、exchange_id、phase_id、plan_version 必须与下方请求逐字一致；kind 取 NEED_CONTEXT、PLAN 或 REVIEW；正文放在 body 字段（不要用 text 字段）。kind 为 REVIEW 时还需 decision（CONTINUE、REVISE、NEED_CONTEXT 或 COMPLETE），并给出更大的 next_plan_version（CONTINUE 另需 next_phase_id）。",
        JSON.stringify(request, null, 2),
      ].join("\n\n");
      if (containsLikelySecret(wrappedText)) return resultText("交接文本疑似包含凭据或私密值；已拒绝发送。", true);
      const budget = checkTaskBudget(state.estimatedTokensUsed, wrappedText, estimateTaskText);
      if (!budget.allowed) {
        state.status = "paused";
        state.pauseReason = `文本预算超限：已用 ${budget.usedTokens}，本次估算 ${budget.estimatedTokens}，上限 ${budget.limitTokens}。请缩小上下文；不会截断或上传附件。`;
        await store.writeTask(state);
        return resultText(state.pauseReason, true);
      }
      try {
        await confirmNewContextFiles(ctx, state, sourceFiles, params.text, budget.estimatedTokens);
        const selection = await edgeFor().preflight(state.browserPageId, signal);
        state.selectedModel = selection.model;
        state.thinkingLevel = selection.thinkingLevel;
        state.composerMode = selection.mode;
      } catch (error) {
        state.status = "paused";
        state.pauseReason = errorText(error);
        await store.writeTask(state);
        return resultText(`网页预检暂停：${state.pauseReason}`, true);
      }

      const fingerprint = exchangeFingerprint(wrappedText);
      state.status = "waiting";
      state.roundsUsed += 1;
      state.estimatedTokensUsed += budget.estimatedTokens;
      state.allowedSourceFiles = [...new Set([...(state.allowedSourceFiles ?? []), ...sourceFiles])];
      state.pending = {
        exchangeId,
        phaseId: params.phaseId,
        planVersion: params.planVersion,
        kind,
        text: wrappedText,
        fingerprint,
        estimatedTokens: budget.estimatedTokens,
        submittedAt: new Date().toISOString(),
        submissionState: "intent",
      };
      await store.writeTask(state);
      await store.writeExchange(state.taskId, exchangeId, { request, fingerprint, submissionState: "intent" });
      try {
        const submittedUrl = await edgeFor().fillAndSend(state.browserPageId, wrappedText, state.chatUrl, signal);
        state.chatUrl = submittedUrl || state.chatUrl;
        state.pending.submissionState = "accepted";
        await store.writeTask(state);
        activeContext = ctx;
        getWorker().start();
        return {
          content: [{ type: "text", text: `Submitted exchange ${exchangeId}; stop this turn and wait for the extension to deliver the web reply.` }],
          details: { exchangeId, round: state.roundsUsed },
          terminate: true,
        };
      } catch (error) {
        state.status = "paused";
        state.pending.submissionState = "unknown";
        state.pauseReason = `提交结果不确定：${errorText(error)}。先检查原线程，不要重发。`;
        await store.writeTask(state);
        return { content: [{ type: "text", text: state.pauseReason }], details: { exchangeId }, isError: true };
      }
    },
  });
}
