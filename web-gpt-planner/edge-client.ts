/**
 * Edge CDP 客户端。
 *
 * 通过固定的本机调试端口直连专用的 Edge 实例（默认 127.0.0.1:9222），
 * 只操作我们自己创建/绑定的 chatgpt.com 标签页，不触碰其他标签页。
 * 端口可用环境变量覆盖，不依赖 edge://inspect 的人工授权开关。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 专用 Edge 实例的 CDP 端口；可用环境变量覆盖。 */
export const DEFAULT_EDGE_PORT = 9222;
export const EDGE_PORT_ENV_VAR = "WEB_GPT_PLANNER_EDGE_PORT";
export const EDGE_LAUNCHER_ENV_VAR = "WEB_GPT_PLANNER_EDGE_LAUNCHER";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const EXPECTED_MODELS = ["最新", "Latest"];
const EXPECTED_THINKING_LEVELS = ["极高", "Extended", "Extreme", "extreme-high"];
const READY_TIMEOUT_MS = 20_000;
const LAUNCH_WAIT_MS = 40_000;
/** 冷启动后这些命令可能要等几十秒（建标签页、导航）。 */
const SLOW_COMMAND_TIMEOUT_MS = 60_000;
const SLOW_COMMANDS = new Set(["Target.createTarget", "Page.navigate"]);
const CDP_READY_TIMEOUT_MS = 60_000;

function commandTimeoutMs(method: string): number {
  return SLOW_COMMANDS.has(method) ? SLOW_COMMAND_TIMEOUT_MS : READY_TIMEOUT_MS;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EdgeClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeClientError";
  }
}

export interface EdgePage {
  targetId: string;
  url: string;
}

export interface ThreadReply {
  containerFound: boolean;
  textLength: number;
  occurrences: number;
  lastRaw: string;
}

export interface EdgeSelection {
  model: string;
  thinkingLevel: string;
  mode: "chat" | "unknown";
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  close(): void;
}

export interface ExecLike {
  (command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;
}

export interface EdgeClientOptions {
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** 默认取 WEB_GPT_PLANNER_EDGE_LAUNCHER，否则 %LOCALAPPDATA%\PiAgent\PiAgent-Edge.bat。 */
  launcherPath?: string;
  exec?: ExecLike;
  fetchImpl?: typeof fetch;
  connect?: (webSocketDebuggerUrl: string) => Promise<CdpConnection>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** 浏览器级 WS：Node 22+ 自带 WebSocket，无需额外依赖。 */
async function connectDefault(webSocketDebuggerUrl: string): Promise<CdpConnection> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const payload = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new EdgeClientError(message.error.message ?? "CDP 命令失败"));
    else waiter.resolve(message.result);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (event: Event): void => reject(new EdgeClientError(`无法连接 Edge 调试端点：${(event as ErrorEvent).message ?? "WebSocket 错误"}`));
    socket.addEventListener("open", () => {
      socket.removeEventListener("error", onError);
      resolve();
    }, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => {
          if (pending.delete(id)) reject(new EdgeClientError(`CDP 命令超时：${method}`));
        }, commandTimeoutMs(method));
      });
    },
    close() {
      try { socket.close(); } catch { /* 已关闭 */ }
    },
  };
}

/** 思考强度的可选值（中英文）；用于把输入框容器里的强度控件从其他按钮中认出来。 */
const LEVEL_NAMES = ["极高", "高", "中", "轻", "轻度", "极速", "低", "Extended", "Extreme", "High", "Medium", "Low", "Minimal"];

/**
 * 页面脚本共用的前置片段：把控件查找限定在输入框所在的 form（无 form 时用输入框的上层容器）内。
 * 绝不全局扫描按钮：侧边栏的「探索」等控件也带 aria-haspopup，全局兜底会误选。
 */
const TRIGGER_PREAMBLE = `
  const LEVELS = ${JSON.stringify(LEVEL_NAMES)};
  const composerEl = document.querySelector("form div[role='textbox'][contenteditable='true'], div[role='textbox'][contenteditable='true']");
  const formEl = composerEl ? composerEl.closest("form") : null;
  const scopeEl = formEl || (composerEl && composerEl.parentElement ? (composerEl.parentElement.parentElement || composerEl.parentElement) : null);
  const controlEls = scopeEl ? [...scopeEl.querySelectorAll("button, [role='button']")] : [];
  const ariaOf = (el) => el.getAttribute("aria-label") || "";
  const textOf = (el) => (el.innerText || "").replace(/\\s+/g, " ").trim();
  const isLevel = (value) => LEVELS.some((level) => value === level || value === "思考强度 " + level || value.endsWith(" " + level));
  const describedOf = (el) => ariaOf(el) + " " + (el.getAttribute("data-testid") || "") + " " + (el.getAttribute("data-codex-intelligence-trigger") || "");
  const findTrigger = () => controlEls.find((el) => el.hasAttribute("data-codex-intelligence-trigger"))
    || controlEls.find((el) => /模型|思考强度|model|thinking|effort|intelligence/i.test(describedOf(el)))
    || controlEls.find((el) => isLevel(textOf(el)))
    || controlEls.find((el) => el.getAttribute("aria-haspopup") === "menu")
    || null;
  const describeControls = () => controlEls.slice(0, 8).map((el) => ariaOf(el) + "|" + textOf(el) + "|" + (el.getAttribute("aria-haspopup") || ""));
`;

/** 页面侧脚本：只读取状态，不做任何点击。 */
export const PAGE_STATE_SCRIPT = `(() => {${TRIGGER_PREAMBLE}
  const trigger = findTrigger();
  return {
    href: location.href,
    pathname: location.pathname,
    search: location.search,
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    composerFound: !!composerEl,
    composerLength: composerEl ? (composerEl.innerText || "").trim().length : 0,
    composerEmpty: composerEl ? !(composerEl.innerText || "").trim() : false,
    triggerFound: !!trigger,
    triggerText: trigger ? (textOf(trigger) || ariaOf(trigger).replace(/\\s+/g, " ").trim()) : "",
    triggerLabel: trigger ? ariaOf(trigger) : "",
    triggerSelector: !trigger ? "none" : trigger.hasAttribute("data-codex-intelligence-trigger") ? "intelligence" : /模型|model|thinking|effort|intelligence/i.test(describedOf(trigger)) ? "label" : isLevel(textOf(trigger)) ? "level" : "menu",
    controls: describeControls(),
    hasSend: controlEls.some((el) => /(发送|send)/i.test(ariaOf(el))),
    hasStop: controlEls.some((el) => /(停止|stop)/i.test(ariaOf(el))),
  };
})()`;

/** 页面侧脚本：读出模型菜单里被勾选的模型（只读，不改变选择）。 */
export const MENU_MODELS_SCRIPT = `(() => {
  const items = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitemcheckbox"]')];
  return {
    open: document.querySelectorAll('[role="menu"]').length > 0,
    checked: items.filter((el) => el.getAttribute("aria-checked") === "true")
      .map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim()),
    all: items.map((el) => (el.innerText || "").replace(/\\s+/g, " ").trim()),
  };
})()`;

/**
 * 页面侧脚本：从线程文本里按协议信封提取回复。
 * 回合元素不带任何属性（data-message-id / role / article 均为 0），因此不依赖角色、顺序或深链选择器：
 * 扫描括号配平且能 JSON.parse 的对象，取 exchange_id 匹配的最后一个（第一个必定是我们自己发出的请求）。
 */
export function threadReplyScript(exchangeId: string): string {
  return `(() => {
  const container = document.querySelector('[class*="thread-scroll-container"]');
  const text = container ? (container.innerText || "") : "";
  const wanted = ${JSON.stringify(exchangeId)};
  const found = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const char = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === String.fromCharCode(92)) escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const raw = text.slice(i, j + 1);
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && parsed.exchange_id === wanted) found.push(raw);
          } catch { /* 不是完整 JSON 对象，跳过 */ }
          i = j;
          break;
        }
      }
    }
  }
  return {
    containerFound: !!container,
    textLength: text.length,
    occurrences: found.length,
    lastRaw: found.length > 0 ? found[found.length - 1].slice(0, 200000) : "",
  };
})()`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** 触发按钮文本形如「思考强度 极高」或「极高」，取其中的强度词。 */
export function parseThinkingLevel(triggerText: string): string {
  const stripped = triggerText.replace(/(思考强度|Thinking|Effort)/gi, " ").replace(/\s+/g, " ").trim();
  return stripped.split(" ").filter(Boolean).at(-1) ?? "";
}

/** 判断是否为普通聊天页面（排除 GPT、项目、临时聊天）。 */
export function isNormalChatUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== CHATGPT_ORIGIN) return false;
    if (/temporary|temp-chat/i.test(parsed.search)) return false;
    return parsed.pathname === "/" || parsed.pathname.startsWith("/c/");
  } catch {
    return false;
  }
}

export class EdgeClient {
  readonly port: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly launcherPath: string;
  private readonly exec: ExecLike | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly connect: (webSocketDebuggerUrl: string) => Promise<CdpConnection>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private connection: CdpConnection | undefined;
  private readonly sessions = new Map<string, string>();

  constructor(options: EdgeClientOptions = {}) {
    this.env = options.env ?? process.env;
    const configured = Number(options.port ?? this.env[EDGE_PORT_ENV_VAR] ?? DEFAULT_EDGE_PORT);
    this.port = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_EDGE_PORT;
    const localAppData = this.env.LOCALAPPDATA ?? join(this.env.USERPROFILE ?? "", "AppData", "Local");
    this.launcherPath = options.launcherPath ?? this.env[EDGE_LAUNCHER_ENV_VAR] ?? join(localAppData, "PiAgent", "PiAgent-Edge.bat");
    this.exec = options.exec;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connect = options.connect ?? connectDefault;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? Date.now;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 读取 /json/version；未就绪时返回 undefined。 */
  async readVersion(signal?: AbortSignal): Promise<{ browser: string; webSocketDebuggerUrl: string } | undefined> {
    try {
      const response = await this.fetchImpl(`${this.endpoint}/json/version`, { signal });
      if (!response.ok) return undefined;
      const parsed = await response.json() as { Browser?: string; webSocketDebuggerUrl?: string };
      if (typeof parsed.webSocketDebuggerUrl !== "string") return undefined;
      return { browser: parsed.Browser ?? "unknown", webSocketDebuggerUrl: parsed.webSocketDebuggerUrl };
    } catch {
      return undefined;
    }
  }

  /** 端点未就绪时按需启动专用 Edge（调用启动脚本，不引入常驻服务）。 */
  async ensureEndpoint(signal?: AbortSignal): Promise<{ browser: string; webSocketDebuggerUrl: string }> {
    const ready = await this.readVersion(signal);
    if (ready) return ready;
    if (this.exec && existsSync(this.launcherPath)) {
      await this.exec("cmd", ["/c", "start", "", "/min", this.launcherPath], { timeout: 30_000 });
      const deadline = this.now() + LAUNCH_WAIT_MS;
      while (this.now() < deadline) {
        await this.sleep(1_000, signal);
        const started = await this.readVersion(signal);
        if (started) return started;
      }
    }
    throw new EdgeClientError(
      `未检测到 Edge 调试端点 ${this.endpoint}。请先运行 ${this.launcherPath}（或手动启动带 --remote-debugging-port=${this.port} 的专用 Edge）后重试。`,
    );
  }

  private async browser(): Promise<CdpConnection> {
    if (this.connection) return this.connection;
    const version = await this.ensureEndpoint();
    const connection = await this.connect(version.webSocketDebuggerUrl);
    this.connection = connection;
    await this.waitForCommands(connection);
    return connection;
  }

  /**
   * 冷启动时 /json/version 会先就绪，但命令仍可能长时间不返回（实测 Target.createTarget 会挂住）。
   * 先用一个便宜的命令确认真能应答，再交给上层。
   */
  private async waitForCommands(connection: CdpConnection, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + CDP_READY_TIMEOUT_MS;
    for (;;) {
      try {
        await connection.send("Target.getTargets");
        return;
      } catch (error) {
        if (this.now() >= deadline) {
          throw new EdgeClientError(`Edge 调试端点已响应，但命令在 ${CDP_READY_TIMEOUT_MS / 1000} 秒内不可用（${errorText(error)}）；请稍后重试`);
        }
        await this.sleep(1_000, signal);
      }
    }
  }

  private async sessionFor(targetId: string): Promise<string> {
    const cached = this.sessions.get(targetId);
    if (cached) return cached;
    const browser = await this.browser();
    const attached = await browser.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId?: string };
    if (!attached?.sessionId) throw new EdgeClientError("无法附加到目标标签页");
    this.sessions.set(targetId, attached.sessionId);
    return attached.sessionId;
  }

  /** 读取 JSON 接口；任何连接层失败都转换成带启动脚本提示的错误。 */
  private async requestJson(url: string, signal: AbortSignal | undefined, action: string): Promise<unknown> {
    try {
      const response = await this.fetchImpl(url, { signal });
      if (!response.ok) throw new EdgeClientError(`${action}失败（HTTP ${response.status}）；端点 ${this.endpoint} 可能不是可用的 CDP 接口`);
      return await response.json();
    } catch (error) {
      if (error instanceof EdgeClientError) throw error;
      if (signal?.aborted) throw new EdgeClientError(`${action}已取消`);
      throw new EdgeClientError(`无法连接 Edge 调试端点 ${this.endpoint}（${action}）；请先运行 ${this.launcherPath} 后重试`);
    }
  }

  async listPages(signal?: AbortSignal): Promise<EdgePage[]> {
    const parsed = await this.requestJson(`${this.endpoint}/json/list`, signal, "读取标签页列表");
    if (!Array.isArray(parsed)) throw new EdgeClientError("读取标签页列表失败：端点返回的不是标签页数组");
    return parsed
      .filter((target) => target.type === "page" && typeof target.id === "string" && typeof target.url === "string")
      .map((target) => ({ targetId: target.id as string, url: target.url as string }));
  }

  private async createTab(url: string): Promise<EdgePage> {
    const browser = await this.browser();
    let failure = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const created = await browser.send("Target.createTarget", { url, background: false }) as { targetId?: string };
        if (!created?.targetId) throw new EdgeClientError("Edge 未返回新建标签页的 targetId");
        return { targetId: created.targetId, url };
      } catch (error) {
        failure = errorText(error);
        if (attempt < 3) await this.sleep(2_000);
      }
    }
    throw new EdgeClientError(`新建标签页失败（已重试 3 次）：${failure}`);
  }

  async findTabById(targetId: string, signal?: AbortSignal): Promise<EdgePage | undefined> {
    return (await this.listPages(signal)).find((page) => page.targetId === targetId);
  }

  /** 复用已保存的标签页；没有就新建一个（只认 ChatGPT 页面）。 */
  async ensureChatPage(input: { browserPageId?: string; signal?: AbortSignal } = {}): Promise<{ page: EdgePage; created: boolean }> {
    await this.ensureEndpoint(input.signal);
    const pages = await this.listPages(input.signal);
    if (input.browserPageId) {
      const saved = pages.find((page) => page.targetId === input.browserPageId);
      if (saved && isChatGptPage(saved.url)) return { page: saved, created: false };
    }
    const reusable = pages.find((page) => isChatGptPage(page.url) && isNormalChatUrl(page.url) && new URL(page.url).pathname === "/");
    if (reusable) return { page: reusable, created: false };
    return { page: await this.createTab(`${CHATGPT_ORIGIN}/`), created: true };
  }

  /** 让目标标签页回到干净的聊天首页，返回实际 URL。 */
  async startFreshChat(targetId: string, signal?: AbortSignal): Promise<string> {
    const browser = await this.browser();
    const sessionId = await this.sessionFor(targetId);
    await browser.send("Page.navigate", { url: `${CHATGPT_ORIGIN}/` }, sessionId);
    const deadline = this.now() + READY_TIMEOUT_MS;
    while (this.now() < deadline) {
      await this.sleep(500, signal);
      const state = await this.readState(targetId, signal);
      if (state && state.composerFound && new URL(state.href).pathname === "/") return state.href;
    }
    throw new EdgeClientError("ChatGPT 首页未在预期时间内就绪");
  }

  /** 激活标签页；后台标签页下焦点、弹层与输入都不可靠（实测菜单关不掉、输入无效）。 */
  async activatePage(targetId: string, signal?: AbortSignal): Promise<boolean> {
    const browser = await this.browser();
    try {
      await browser.send("Target.activateTarget", { targetId });
    } catch {
      try {
        await browser.send("Page.bringToFront", {}, await this.sessionFor(targetId));
      } catch {
        return false;
      }
    }
    await this.sleep(300, signal);
    return true;
  }

  /** 不可见或没有焦点时激活：无焦点页面下弹层开关与键盘事件都不可靠（实测菜单关不掉）。 */
  async ensureVisible(targetId: string, signal?: AbortSignal): Promise<boolean> {
    const state = await this.readState(targetId, signal);
    if (state?.visible && state.focused) return false;
    return this.activatePage(targetId, signal);
  }

  /** 页面状态（只读）。 */
  async readState(targetId: string, signal?: AbortSignal): Promise<PageState | undefined> {
    const value = await this.evaluate(targetId, PAGE_STATE_SCRIPT, signal);
    return typeof value === "object" && value !== null ? value as PageState : undefined;
  }

  /** 等页面渲染出输入框与思考强度控件（新建标签页后需要时间）；超时返回最后一次状态，由调用方判断。 */
  async waitReady(targetId: string, signal?: AbortSignal): Promise<PageState | undefined> {
    const deadline = this.now() + READY_TIMEOUT_MS;
    let state = await this.readState(targetId, signal);
    while (this.now() < deadline && !(state?.composerFound && state.triggerFound)) {
      await this.sleep(500, signal);
      state = await this.readState(targetId, signal);
    }
    return state;
  }

  /** 只读预检：聊天模式 + 最新 + 极高；任一项不符即抛错（不自动点选）。 */
  async preflight(targetId: string, signal?: AbortSignal): Promise<EdgeSelection> {
    await this.ensureVisible(targetId, signal);
    const state = await this.waitReady(targetId, signal);
    if (!state) throw new EdgeClientError("无法读取 ChatGPT 页面状态");
    if (!isNormalChatUrl(state.href)) throw new EdgeClientError("当前不是普通聊天页面（可能位于 GPT、项目或临时聊天）；请切换到普通聊天后重试");
    if (!state.composerFound) throw new EdgeClientError(`当前页面没有可用的输入框（URL：${state.href}）；请在该标签页登录 ChatGPT 后重试`);
    if (!state.triggerFound) {
      const seen = state.controls && state.controls.length > 0 ? `；输入框区域控件：${state.controls.join(" / ")}` : "";
      throw new EdgeClientError(`未找到思考强度控件（URL：${state.href}，输入框：有${seen}）；请确认该标签页是已登录的普通 ChatGPT 聊天页后重试`);
    }
    const reading = state.triggerText;
    const thinkingLevel = parseThinkingLevel(reading);
    if (!EXPECTED_THINKING_LEVELS.includes(thinkingLevel)) {
      throw new EdgeClientError(`网页思考强度不是「极高」（当前：${thinkingLevel || `未识别，控件文本为「${reading || "空"}」`}）；请在网页里手动设置后重试`);
    }
    const { model, items, menuClosed } = await this.readCheckedModel(targetId, signal);
    if (!menuClosed) {
      throw new EdgeClientError("模型菜单读取后未能关闭（页面可能不在前台）；请将该 ChatGPT 标签页切到前台后重试");
    }
    if (!EXPECTED_MODELS.includes(model)) {
      const seen = items.length > 0 ? `；菜单项：${items.slice(0, 8).join(" / ")}` : "";
      throw new EdgeClientError(`网页模型不是「最新」（当前：${model || "未知"}${seen}）；请在网页里手动选择「最新」后重试`);
    }
    return { model, thinkingLevel, mode: "chat" };
  }

  private async evaluate(targetId: string, expression: string, signal?: AbortSignal): Promise<unknown> {
    const browser = await this.browser();
    const sessionId = await this.sessionFor(targetId);
    if (signal?.aborted) throw new EdgeClientError("操作已取消");
    const result = await browser.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string } };
    };
    if (result?.exceptionDetails) {
      throw new EdgeClientError(`页面脚本执行失败：${result.exceptionDetails.exception?.description?.split("\n")[0] ?? "未知错误"}`);
    }
    return result?.result?.value;
  }

  /** 打开模型菜单读出被勾选的模型与菜单项，然后关闭菜单（不改变选择）。 */
  async readCheckedModel(targetId: string, signal?: AbortSignal): Promise<{ model: string; items: string[]; menuClosed: boolean }> {
    // 点击前先归位：若已有菜单开着，先按 Escape，避免这次点击变成「关闭」。
    if (await this.isMenuOpen(targetId)) {
      await this.pressKey(targetId, "Escape").catch(() => undefined);
      await this.sleep(400, signal);
    }
    let clicks = 0;
    try {
      const deadline = this.now() + 8_000;
      let nextClickAt = 0;
      while (this.now() < deadline) {
        // 无焦点的页面上单击可能被丢或只能切换菜单，因此 2.5 秒未开就再点一次。
        if (clicks < 2 && this.now() >= nextClickAt) {
          if ((await this.clickTrigger(targetId, signal)) !== true) {
            throw new EdgeClientError("未找到模型选择控件，无法读回当前模型");
          }
          clicks += 1;
          nextClickAt = this.now() + 2_500;
        }
        await this.sleep(400, signal);
        const menu = await this.evaluate(targetId, MENU_MODELS_SCRIPT, signal) as { open?: boolean; checked?: string[]; all?: string[] } | undefined;
        if (menu?.open) {
          return { model: menu.checked?.[0] ?? "", items: menu.all ?? [], menuClosed: await this.closeModelMenu(targetId) };
        }
      }
      const state = await this.readState(targetId, signal);
      throw new EdgeClientError(
        `模型菜单未打开，无法读回当前模型（点击 ${clicks} 次后仍未打开；visible=${state?.visible}，focused=${state?.focused}）`,
      );
    } catch (error) {
      await this.closeModelMenu(targetId).catch(() => undefined);
      throw error;
    }
  }

  private async clickTrigger(targetId: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.evaluate(targetId, `(() => {${TRIGGER_PREAMBLE}
      const t = findTrigger();
      if (!t) return false;
      t.click();
      return true;
    })()`, signal)) === true;
  }

  /** 关闭模型菜单：先再点一次触发器，再用真实 Escape 键；返回是否已确认关闭。 */
  private async closeModelMenu(targetId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.isMenuOpen(targetId))) return true;
      if (attempt === 0) {
        await this.evaluate(targetId, `(() => {${TRIGGER_PREAMBLE}
          const t = findTrigger();
          if (!t) return false;
          t.click();
          return true;
        })()`).catch(() => undefined);
      } else {
        await this.pressKey(targetId, "Escape").catch(() => undefined);
      }
      await this.sleep(300);
    }
    return !(await this.isMenuOpen(targetId));
  }

  private async isMenuOpen(targetId: string): Promise<boolean> {
    return (await this.evaluate(targetId, `(() => document.querySelectorAll('[role="menu"]').length > 0)()`)) === true;
  }

  /** 发送真实按键事件；后台标签页收不到，所以调用前需保证页面在前台。 */
  private async pressKey(targetId: string, key: string): Promise<void> {
    const browser = await this.browser();
    const sessionId = await this.sessionFor(targetId);
    const code = key === "Escape" ? 27 : 0;
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
  }

  async isGenerating(targetId: string, signal?: AbortSignal): Promise<boolean> {
    const state = await this.readState(targetId, signal);
    return state?.hasStop === true;
  }

  async getReply(targetId: string, exchangeId: string, signal?: AbortSignal): Promise<ThreadReply> {
    const value = await this.evaluate(targetId, threadReplyScript(exchangeId), signal) as Partial<ThreadReply> | undefined;
    return {
      containerFound: value?.containerFound === true,
      textLength: typeof value?.textLength === "number" ? value.textLength : 0,
      occurrences: typeof value?.occurrences === "number" ? value.occurrences : 0,
      lastRaw: typeof value?.lastRaw === "string" ? value.lastRaw : "",
    };
  }

  /** 写入一段文本并发送；任何一步无法确认即抛错，绝不盲目重发。 */
  async fillAndSend(targetId: string, text: string, expectedUrl?: string, signal?: AbortSignal): Promise<string> {
    const state = await this.readState(targetId, signal);
    if (!state) throw new EdgeClientError("无法读取 ChatGPT 页面状态");
    if (!isNormalChatUrl(state.href)) throw new EdgeClientError("提交前页面已不是普通聊天页面；已放弃发送");
    if (expectedUrl && new URL(expectedUrl).pathname !== new URL(state.href).pathname) {
      throw new EdgeClientError("提交前页面已切换到其他会话；已放弃发送");
    }
    // 空输入框里有一个占位段落，innerText 可能是换行符，所以按去空白后的长度判断。
    if (state.composerLength > 0 || state.composerEmpty === false) {
      throw new EdgeClientError(`ChatGPT 输入框里已有 ${state.composerLength ?? 0} 个字符的内容，不会覆盖；请清空后重试`);
    }
    if (!state.composerFound) throw new EdgeClientError("当前页面没有可用的输入框；已放弃发送");

    // 后台标签页里输入不会生效（visibilityState=hidden、hasFocus=false），必须先激活。
    await this.ensureVisible(targetId, signal);
    const browser = await this.browser();
    const sessionId = await this.sessionFor(targetId);
    await this.evaluate(targetId, `(() => { const c = document.querySelector("form div[role='textbox'][contenteditable='true'], div[role='textbox'][contenteditable='true']"); if (!c) return false; c.focus(); return true; })()`, signal);
    await browser.send("Input.insertText", { text }, sessionId);
    let inserted = await this.composerLength(targetId, signal);
    if (inserted < text.length - 5) {
      await this.evaluate(targetId, `(() => { const c = document.querySelector("form div[role='textbox'][contenteditable='true'], div[role='textbox'][contenteditable='true']"); if (!c) return false; c.focus(); document.execCommand("insertText", false, ${JSON.stringify(text)}); return true; })()`, signal);
      inserted = await this.composerLength(targetId, signal);
    }
    if (inserted <= 0) throw new EdgeClientError("文本未能写入 ChatGPT 输入框；已放弃发送");

    const clicked = await this.evaluate(targetId, `(() => { const form = document.querySelector("form"); if (!form) return false; const button = [...form.querySelectorAll("button")].find((b) => /^(发送|Send)/i.test(b.getAttribute("aria-label") || "")); if (!button) return false; button.click(); return true; })()`, signal);
    if (clicked !== true) throw new EdgeClientError(`未能点击发送按钮（已写入 ${inserted} 字符）；已放弃发送，请核对网页状态后重试`);

    const deadline = this.now() + 15_000;
    while (this.now() < deadline) {
      await this.sleep(500, signal);
      const current = await this.readState(targetId, signal);
      if (!current) continue;
      if (current.composerLength === 0 && current.hasStop) return current.href;
      if (current.composerLength === 0 && current.hasSend && new URL(current.href).pathname.startsWith("/c/")) return current.href;
    }
    throw new EdgeClientError("发送后未在预期时间内观察到提交生效；请核对原线程，不要重发");
  }

  private async composerLength(targetId: string, signal?: AbortSignal): Promise<number> {
    const value = await this.evaluate(targetId, `(() => { const c = document.querySelector("form div[role='textbox'][contenteditable='true'], div[role='textbox'][contenteditable='true']"); return c ? (c.innerText || "").trim().length : -1; })()`, signal);
    return typeof value === "number" ? value : -1;
  }

  /** 关闭标签页（仅用于我们自己创建的那个）；目标已经不存在时视为已关闭。 */
  async closePage(targetId: string, signal?: AbortSignal): Promise<void> {
    const browser = await this.browser();
    let failure = "";
    try {
      await browser.send("Target.closeTarget", { targetId });
      this.sessions.delete(targetId);
      return;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (/no target|not found|no session/i.test(failure)) {
      this.sessions.delete(targetId);
      return;
    }
    try {
      const response = await this.fetchImpl(`${this.endpoint}/json/close/${targetId}`, { signal });
      if (response.ok) {
        this.sessions.delete(targetId);
        return;
      }
    } catch { /* 连接层失败：落到下面的报错 */ }
    throw new EdgeClientError(`关闭标签页失败：${failure}`);
  }

  dispose(): void {
    this.connection?.close();
    this.connection = undefined;
    this.sessions.clear();
  }
}

export interface PageState {
  href: string;
  pathname: string;
  search: string;
  composerFound: boolean;
  composerLength: number;
  composerEmpty: boolean;
  triggerFound: boolean;
  triggerText: string;
  triggerLabel: string;
  triggerSelector: string;
  controls: string[];
  visible: boolean;
  focused: boolean;
  hasSend: boolean;
  hasStop: boolean;
}

function isChatGptPage(url: string): boolean {
  try {
    return new URL(url).origin === CHATGPT_ORIGIN;
  } catch {
    return false;
  }
}
