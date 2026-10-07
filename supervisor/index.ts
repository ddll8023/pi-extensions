/**
 * Pi 任务级旁路监督扩展。
 * 默认关闭，用户确认额外模型消耗后启用；只提示，不阻断、授权、回滚或自动续跑。
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	boundedText,
	buildReviewInput,
	findingKey,
	formatFindings,
	REVIEW_LIMITS,
	runReview,
	type ReviewOutcome,
} from "./review.ts";

const STATE_ENTRY = "task-supervisor-state";
const REMINDER_TYPE = "task-supervisor-reminder";
const UI_KEY = "task-supervisor";
const MAX_SEEN_FINDINGS = 64;

interface ModelReference {
	provider: string;
	id: string;
	api: string;
}

type ReviewStatus = "off" | "ready" | "reviewing" | "issues" | "clear" | "unavailable" | "limit";

interface SupervisorState {
	version: 1;
	enabled: boolean;
	approvedSessionId: string;
	model?: ModelReference;
	runId: string;
	runRequests: number;
	toolsSinceReview: number;
	failureRounds: number;
	failedInRun: boolean;
	lastBoundaryId: string;
	seenFindings: string[];
	status: ReviewStatus;
	note: string;
	requests: number;
	unknownUsageRequests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputChars: number;
	elapsedMs: number;
}

const STATUSES: ReviewStatus[] = ["off", "ready", "reviewing", "issues", "clear", "unavailable", "limit"];
const COUNTERS = [
	"runRequests", "toolsSinceReview", "failureRounds", "requests", "unknownUsageRequests",
	"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "inputChars", "elapsedMs",
] as const;

/** 创建没有启用授权的初始状态。 */
function initialState(): SupervisorState {
	return {
		version: 1, enabled: false, approvedSessionId: "", runId: "", runRequests: 0,
		toolsSinceReview: 0, failureRounds: 0, failedInRun: false, lastBoundaryId: "",
		seenFindings: [], status: "off", note: "", requests: 0, unknownUsageRequests: 0,
		inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
		inputChars: 0, elapsedMs: 0,
	};
}

/** 验证持久化状态，拒绝缺字段、非法计数及不受支持的版本。 */
function parseState(value: unknown): SupervisorState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<SupervisorState>;
	if (candidate.version !== 1 || typeof candidate.enabled !== "boolean" || typeof candidate.failedInRun !== "boolean") return undefined;
	if (!COUNTERS.every((key) => typeof candidate[key] === "number" && Number.isSafeInteger(candidate[key]) && (candidate[key] ?? -1) >= 0)) return undefined;
	if (![candidate.approvedSessionId, candidate.runId, candidate.lastBoundaryId, candidate.note].every((item) => typeof item === "string")) return undefined;
	if (!candidate.status || !STATUSES.includes(candidate.status)) return undefined;
	if (!Array.isArray(candidate.seenFindings) || !candidate.seenFindings.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))) return undefined;
	if (candidate.model && ![candidate.model.provider, candidate.model.id, candidate.model.api].every((item) => typeof item === "string" && item.length > 0)) return undefined;
	if (candidate.enabled && !candidate.model) return undefined;
	const state = candidate as SupervisorState;
	return { ...state, model: state.model ? { ...state.model } : undefined, note: boundedText(state.note, 3_000), seenFindings: state.seenFindings.slice(-MAX_SEEN_FINDINGS) };
}

/** 简洁显示实际计数，不将字符估计或缺失 token 冒充已报告用量。 */
function formatCount(count: number): string {
	return count < 1_000 ? String(count) : `${(count / 1_000).toFixed(1)}k`;
}

export default function supervisorExtension(pi: ExtensionAPI): void {
	let state = initialState();
	let projectRules = "";
	let generation = 0;
	let sessionActive = false;
	let activeController: AbortController | undefined;
	let reviewBusy = false;

	/** 取消旧审查并使旧上下文失效；实际模型调用还受 review.ts 的单飞锁保护。 */
	function invalidateReview(): void {
		generation += 1;
		activeController?.abort();
		activeController = undefined;
	}

	/** 使用非上下文 entry 保存当前分支状态，不把审查统计灌入主模型。 */
	function persistState(): void {
		pi.appendEntry<SupervisorState>(STATE_ENTRY, { ...state, model: state.model ? { ...state.model } : undefined, seenFindings: [...state.seenFindings] });
	}

	/** 更新独立状态槽和字符串 widget，兼容终端与 pigui 的 UI 桥。 */
	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const labels: Record<ReviewStatus, string> = {
			off: "关闭", ready: "待审查", reviewing: "审查中", issues: "有提醒",
			clear: "未发现有据问题", unavailable: "不可用", limit: "已达调用上限",
		};
		if (!state.enabled) {
			ctx.ui.setStatus(UI_KEY, undefined);
			ctx.ui.setWidget(UI_KEY, undefined);
			return;
		}
		const reportedInput = state.inputTokens + state.cacheReadTokens + state.cacheWriteTokens;
		const unknown = state.unknownUsageRequests ? ` · ${state.unknownUsageRequests}次用量未知` : "";
		ctx.ui.setStatus(UI_KEY, `监督 ${labels[state.status]} · ${state.requests}次 ↑${formatCount(reportedInput)} ↓${formatCount(state.outputTokens)}${unknown}`);
		const showNote = state.note && state.status !== "ready" && state.status !== "clear";
		ctx.ui.setWidget(UI_KEY, showNote ? ["旁路监督（仅建议，不产生授权）", ...state.note.split("\n")] : undefined);
	}

	/** 根据当前分支恢复状态；fork 不能继承原会话的消费授权。 */
	function restoreState(ctx: ExtensionContext): void {
		invalidateReview();
		sessionActive = true;
		projectRules = "";
		state = initialState();
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			state = parseState(entry.data) ?? initialState();
			break;
		}
		if (state.approvedSessionId !== ctx.sessionManager.getSessionId() || !ctx.hasUI) {
			// 新会话保留分支统计，但必须重新确认消费；无 UI 模式不自动继承开启状态。
			state.enabled = false;
			state.status = "off";
			state.note = "";
		} else if (state.status === "reviewing") {
			state.status = "unavailable";
			state.failedInRun = true;
			state.note = "此前审查被中断，未取得完整结果及用量；本轮不自动重试。";
		}
		updateUI(ctx);
	}

	/** 显示真实的独立审查开销与边界，不触发模型请求。 */
	function showStatus(ctx: ExtensionContext): void {
		const model = state.model ? `${state.model.provider}/${state.model.id}` : "未固定";
		ctx.ui.notify([
			`旁路监督：${state.enabled ? "开启" : "关闭"}；审查模型：${model}`,
			`当前用户输入已发起 ${state.runRequests}/${REVIEW_LIMITS.requestsPerRun} 次；当前分支累计 ${state.requests} 次。`,
			`提供方已报告：输入 ${state.inputTokens}，输出 ${state.outputTokens}，缓存读 ${state.cacheReadTokens}，缓存写 ${state.cacheWriteTokens} token。`,
			`用量未知请求：${state.unknownUsageRequests} 次（不代表免费）；累计等待 ${(state.elapsedMs / 1_000).toFixed(1)} 秒。`,
			`累计有界请求字符：${state.inputChars}（不是 token）；费用未核实，以提供方账单或额度记录为准。`,
			`触发：累积 ${REVIEW_LIMITS.toolsPerReview} 次工具结果、连续 ${REVIEW_LIMITS.failureRounds} 个含失败的工具回合或任务收尾。`,
			`每次输入最多 ${REVIEW_LIMITS.inputChars} 字符，输出请求上限 ${REVIEW_LIMITS.outputTokens} token，超时 ${REVIEW_LIMITS.timeoutMs / 1_000} 秒；失败后本轮不重试。`,
			"默认不阻断，不授权，不执行工具，不强制续跑；敏感文本过滤不能保证完全脱敏。",
			state.note ? `最近状态：${state.note}` : "尚无提醒。",
		].join("\n"), "info");
	}

	/** 开启前固定物理模型并明确确认额外消耗，等待期间不接受过期的会话或模型。 */
	async function enable(ctx: ExtensionCommandContext): Promise<void> {
		if (state.enabled) { showStatus(ctx); return; }
		if (!ctx.hasUI) return;
		if (!ctx.isIdle() || reviewBusy) {
			ctx.ui.notify("请先结束当前任务或等待旧审查退出，再开启旁路监督。", "warning");
			return;
		}
		const model = ctx.model;
		if (!model || model.api === "pi-virtual" || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			ctx.ui.notify("需要已配置认证的物理主模型；第一版不使用可能跨供应商路由的虚拟模型。", "warning");
			return;
		}
		const epoch = generation;
		const sessionId = ctx.sessionManager.getSessionId();
		const confirmed = await ctx.ui.confirm("开启任务级旁路监督？", [
			`审查模型固定为 ${model.provider}/${model.id}；切换主模型后不会自动更换。`,
			"会向该提供方额外发送有界的需求、项目规则、方案、确认记录与操作结果片段。",
			"过滤常见密钥格式不等于完全脱敏，请不要在包含机密的会话中开启。",
			`每条新的用户输入最多额外发起 ${REVIEW_LIMITS.requestsPerRun} 次审查，消耗 API 费用或订阅额度。`,
			"审查会增加回合等待时间；只提醒，不执行工具，也不会授权或自动续跑。",
			"是否允许在本会话开启上述审查？",
		].join("\n"));
		if (!confirmed || epoch !== generation || sessionId !== ctx.sessionManager.getSessionId()) return;
		if (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id || ctx.model?.api !== model.api || !ctx.isIdle()) {
			ctx.ui.notify("确认期间模型或任务状态已改变，未启用；请重新执行 /supervisor on。", "warning");
			return;
		}
		state.enabled = true;
		state.approvedSessionId = sessionId;
		state.model = { provider: model.provider, id: model.id, api: model.api };
		state.status = state.failedInRun ? "unavailable" : "ready";
		state.note = state.failedInRun ? "本轮此前审查失败；再次开关不会重置预算，新的用户输入才会重置。" : "";
		persistState();
		updateUI(ctx);
		ctx.ui.notify("旁路监督已开启；/supervisor off 关闭，/supervisor status 查看独立用量。", "info");
	}

	pi.registerCommand("supervisor", {
		description: "任务级旁路监督：on（确认额外模型消耗）/ off / status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") { await enable(ctx); return; }
			if (action === "status") { showStatus(ctx); return; }
			if (action !== "off") {
				ctx.ui.notify("用法：/supervisor [on|off|status]", "warning");
				return;
			}
			invalidateReview();
			state.enabled = false;
			state.status = "off";
			state.note = "";
			persistState();
			updateUI(ctx);
			ctx.ui.notify("旁路监督已关闭；已请求取消进行中的审查，已消耗的额度不能撤回。", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		invalidateReview();
		if (ctx.hasUI) {
			ctx.ui.setStatus(UI_KEY, undefined);
			ctx.ui.setWidget(UI_KEY, undefined);
		}
	});

	pi.on("before_agent_start", (event) => {
		invalidateReview();
		// 使用 Pi 已加载的规范，不另行读取文件，也不把完整系统提示发送给审查者。
		projectRules = event.systemPromptOptions.contextFiles.map((file) => `${file.path}\n${file.content}`).join("\n\n");
	});

	pi.on("model_select", (event, ctx) => {
		if (!state.enabled || !state.model) return;
		if (event.model.provider === state.model.provider && event.model.id === state.model.id) return;
		ctx.ui.notify(`主模型已切换；监督仍固定为 ${state.model.provider}/${state.model.id}。若要更换审查模型，先 off 再 on 并重新确认。`, "info");
	});

	/** 根据真实用户消息 ID 重置本轮预算；开关、自动重试与内部提示不能重置它。 */
	function enterRun(event: TurnEndEvent): void {
		const users = event.context.contextEntries.flatMap((entry) => entry.messages.flatMap((message) =>
			message.role === "user" ? [entry.sourceEntry.id] : [],
		));
		const runId = users[users.length - 1] ?? state.runId;
		if (runId === state.runId) return;
		state.runId = runId;
		state.runRequests = 0;
		state.toolsSinceReview = 0;
		state.failureRounds = 0;
		state.failedInRun = false;
		state.lastBoundaryId = "";
		state.seenFindings = [];
		state.note = "";
		state.status = "ready";
	}

	/** 合并已报告用量；未收到提供方数字的请求保留“用量未知”。 */
	function recordOutcome(result: ReviewOutcome, inputChars: number): void {
		state.elapsedMs += Math.round(result.elapsedMs);
		if (!result.requested) {
			state.requests = Math.max(0, state.requests - 1);
			state.runRequests = Math.max(0, state.runRequests - 1);
			state.unknownUsageRequests = Math.max(0, state.unknownUsageRequests - 1);
			state.inputChars = Math.max(0, state.inputChars - inputChars);
			return;
		}
		if (!result.usage) return;
		state.unknownUsageRequests = Math.max(0, state.unknownUsageRequests - 1);
		state.inputTokens += result.usage.input;
		state.outputTokens += result.usage.output;
		state.cacheReadTokens += result.usage.cacheRead;
		state.cacheWriteTokens += result.usage.cacheWrite;
	}

	pi.on("turn_end", async (event, ctx) => {
		if (!state.enabled || event.outcome !== "completed" || event.message.role !== "assistant") return;
		if (event.messageEntryId === state.lastBoundaryId || reviewBusy) return;
		enterRun(event);
		state.lastBoundaryId = event.messageEntryId;
		state.toolsSinceReview += event.toolResults.length;
		if (event.toolResults.length) {
			state.failureRounds = event.toolResults.some((result) => result.isError) ? state.failureRounds + 1 : 0;
		}
		const finishing = !event.message.content.some((block) => block.type === "toolCall");
		const shouldReview = finishing || state.toolsSinceReview >= REVIEW_LIMITS.toolsPerReview || state.failureRounds >= REVIEW_LIMITS.failureRounds;
		if (!shouldReview || ctx.hasPendingMessages() || state.failedInRun) {
			persistState();
			updateUI(ctx);
			return;
		}
		if (state.runRequests >= REVIEW_LIMITS.requestsPerRun) {
			state.status = "limit";
			state.note = "当前用户输入已达到审查调用上限；继续主任务不代表已经通过审查。";
			persistState();
			updateUI(ctx);
			return;
		}
		const reference = state.model;
		const model = reference ? ctx.modelRegistry.find(reference.provider, reference.id) : undefined;
		if (!model || model.api !== reference?.api || model.api === "pi-virtual" || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			state.status = "unavailable";
			state.failedInRun = true;
			state.note = "固定审查模型不可用或配置已改变；未调用其他模型，本轮不重试。";
			persistState();
			updateUI(ctx);
			return;
		}
		const epoch = generation;
		const sessionId = ctx.sessionManager.getSessionId();
		let input: ReturnType<typeof buildReviewInput>;
		try {
			input = buildReviewInput(ctx, projectRules);
		} catch {
			state.status = "unavailable";
			state.failedInRun = true;
			state.note = "无法整理当前审查材料，未发起模型请求，本轮不重试。";
			persistState();
			updateUI(ctx);
			return;
		}
		if (!input.evidence.some((item) => item.kind === "user")) {
			state.status = "unavailable";
			state.failedInRun = true;
			state.note = "当前投影缺少真实用户需求，未发起审查；无法凭操作片段推断授权。";
			persistState();
			updateUI(ctx);
			return;
		}
		const requestedState = state;
		const controller = new AbortController();
		activeController = controller;
		const parentSignal = ctx.signal;
		const cancel = (): void => { controller.abort(); };
		parentSignal?.addEventListener("abort", cancel, { once: true });
		if (parentSignal?.aborted) controller.abort();
		reviewBusy = true;
		state.runRequests += 1;
		state.requests += 1;
		state.unknownUsageRequests += 1;
		state.inputChars += input.chars;
		state.toolsSinceReview = 0;
		state.failureRounds = 0;
		state.status = "reviewing";
		state.note = "正在等待独立上下文审查；不执行工具，不产生授权。";
		persistState();
		updateUI(ctx);
		try {
			const result = await runReview(ctx, model, input, controller);
			// 原分支仍在时，即使用户关闭也记录收到的实际消耗；不能写进替换后的分支。
			if (!sessionActive || state !== requestedState || sessionId !== ctx.sessionManager.getSessionId()) return;
			recordOutcome(result, input.chars);
			if (epoch !== generation || !state.enabled) {
				persistState();
				updateUI(ctx);
				return;
			}
			if (ctx.hasPendingMessages() && result.status === "ok") {
				state.status = "ready";
				state.note = "新输入已排队，旧目标的审查结果已丢弃，消耗仍计入。";
				persistState();
				updateUI(ctx);
				return;
			}
			if (result.status !== "ok") {
				state.status = "unavailable";
				state.failedInRun = true;
				state.note = result.reason ?? "本轮审查不可用，不自动重试。";
				persistState();
				updateUI(ctx);
				return;
			}
			const fresh = result.findings.filter((finding) => !state.seenFindings.includes(findingKey(finding)));
			state.seenFindings = [...new Set([...state.seenFindings, ...fresh.map(findingKey)])].slice(-MAX_SEEN_FINDINGS);
			state.status = result.findings.length ? "issues" : "clear";
			state.note = result.findings.length
				? boundedText(formatFindings(result.findings), 3_000)
				: "本次有界材料中未发现有据问题，不代表代码正确或获得任何授权。";
			persistState();
			updateUI(ctx);
			if (finishing || fresh.length === 0) return;
			// 只给自然继续的工具回合追加提醒，不返回 continue，不伪造用户指令。
			return {
				entries: [{
					type: "custom_message" as const,
					customType: REMINDER_TYPE,
					display: false,
					content: `旁路审查建议（不产生授权，不要求自动重做；以真实用户要求为准）：\n${boundedText(formatFindings(fresh), 2_400)}`,
				}],
			};
		} catch {
			if (epoch !== generation || !state.enabled) return;
			state.status = "unavailable";
			state.failedInRun = true;
			state.note = "旁路审查处理失败，未改变工具结果，本轮不自动重试。";
			persistState();
			updateUI(ctx);
		} finally {
			parentSignal?.removeEventListener("abort", cancel);
			if (activeController === controller) activeController = undefined;
			reviewBusy = false;
		}
	});
}
