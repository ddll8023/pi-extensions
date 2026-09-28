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

export interface EdgeTurn {
  text: string;
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
        }, READY_TIMEOUT_MS);
      });
    },
    close() {
      try { socket.close(); } catch { /* 已关闭 */ }
    },
  };
}

/** 页面侧脚本：只读取状态，不做任何点击。 */
export const PAGE_STATE_SCRIPT = `(() => {
  const composer = document.querySelector("form div[role='textbox'][contenteditable='true'], div[role='textbox'][contenteditable='true']");
  const form = composer ? composer.closest("form") : null;
  const buttons = form ? [...form.querySelectorAll("button")] : [];
  const aria = (el) => el.getAttribute("aria-label") || "";
  const trigger = document.querySelector("[data-codex-intelligence-trigger]")
    || document.querySelector("button[aria-label*='模型'], button[aria-label*='model']");
  return {
    href: location.href,
    pathname: location.pathname,
    search: location.search,
    composerFound: !!composer,
    composerLength: composer ? (composer.innerText || "").length : 0,
    triggerFound: !!trigger,
    triggerText: trigger ? (trigger.innerText || "").replace(/\\s+/g, " ").trim() : "",
    hasSend: buttons.some((b) => /^(发送|Send)/i.test(aria(b))),
    hasStop: buttons.some((b) => /^(停止|Stop)/i.test(aria(b))),
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

/** 页面侧脚本：对话回合文本（回合元素本身没有任何属性，因此按顺序返回）。 */
export const PAGE_TURNS_SCRIPT = `(() => {
  const container = document.querySelector('[class*="thread-scroll-container"]');
  if (!container) return { containerFound: false, turns: [] };
  const list = container.querySelector("div.relative.flex.flex-1 > div.flex.min-h-full.flex-1 > div.relative.shrink-0 > div.flex.flex-col")
    || container.querySelector("div.flex.flex-col");
  if (!list) return { containerFound: true, turns: [] };
  const turns = [...list.children]
    .map((el) => (el.innerText || "").trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text: text.slice(0, 200000) }));
  return { containerFound: true, turns };
})()`;

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
    this.connection = await this.connect(version.webSocketDebuggerUrl);
    return this.connection;
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

  async listPages(signal?: AbortSignal): Promise<EdgePage[]> {
    const response = await this.fetchImpl(`${this.endpoint}/json/list`, { signal });
    if (!response.ok) throw new EdgeClientError(`读取标签页列表失败（HTTP ${response.status}）`);
    const parsed = await response.json() as Array<{ id?: string; type?: string; url?: string }>;
    return parsed
      .filter((target) => target.type === "page" && typeof target.id === "string" && typeof target.url === "string")
      .map((target) => ({ targetId: target.id as string, url: target.url as string }));
  }

  private async createTab(url: string): Promise<EdgePage> {
    const browser = await this.browser();
    const created = await browser.send("Target.createTarget", { url, background: true }) as { targetId?: string };
    if (!created?.targetId) throw new EdgeClientError("Edge 未返回新建标签页的 targetId");
    return { targetId: created.targetId, url };
  }

  async findTabById(targetId: string, signal?: AbortSignal): Promise<EdgePage | undefined> {
    return (await this.listPages(signal)).find((page) => page.targetId === targetId);
  }

  /** 复用已保存的标签页；没有就新建一个（只认 ChatGPT 页面）。 */
  async ensureChatPage(input: { browserPageId?: string; signal?: AbortSignal } = {}): Promise<{ page: EdgePage; created: boolean }> {
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

  /** 页面状态（只读）。 */
  async readState(targetId: string, signal?: AbortSignal): Promise<PageState | undefined> {
    const value = await this.evaluate(targetId, PAGE_STATE_SCRIPT, signal);
    return typeof value === "object" && value !== null ? value as PageState : undefined;
  }

  /** 只读预检：聊天模式 + 最新 + 极高；任一项不符即抛错（不自动点选）。 */
  async preflight(targetId: string, signal?: AbortSignal): Promise<EdgeSelection> {
    const state = await this.readState(targetId, signal);
    if (!state) throw new EdgeClientError("无法读取 ChatGPT 页面状态");
    if (!isNormalChatUrl(state.href)) throw new EdgeClientError("当前不是普通聊天页面（可能位于 GPT、项目或临时聊天）；请切换到普通聊天后重试");
    if (!state.composerFound) throw new EdgeClientError("当前页面没有可用的输入框；请在该标签页登录 ChatGPT 后重试");
    const thinkingLevel = parseThinkingLevel(state.triggerText);
    if (!EXPECTED_THINKING_LEVELS.includes(thinkingLevel)) {
      throw new EdgeClientError(`网页思考强度不是「极高」（当前：${thinkingLevel || "未知"}）；请在网页里手动设置后重试`);
    }
    const model = await this.readCheckedModel(targetId, signal);
    if (!EXPECTED_MODELS.includes(model)) {
      throw new EdgeClientError(`网页模型不是「最新」（当前：${model || "未知"}）；请在网页里手动选择「最新」后重试`);
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

  /** 打开模型菜单读出被勾选的模型，然后按 Esc 关闭（不改变选择）。 */
  async readCheckedModel(targetId: string, signal?: AbortSignal): Promise<string> {
    const opened = await this.evaluate(targetId, `(() => { const t = document.querySelector("[data-codex-intelligence-trigger]") || document.querySelector("button[aria-label*='模型'], button[aria-label*='model']"); if (!t) return false; t.click(); return true; })()`, signal);
    if (opened !== true) throw new EdgeClientError("未找到模型选择控件，无法读回当前模型");
    try {
      const deadline = this.now() + 8_000;
      while (this.now() < deadline) {
        await this.sleep(400, signal);
        const menu = await this.evaluate(targetId, MENU_MODELS_SCRIPT, signal) as { open?: boolean; checked?: string[] } | undefined;
        if (menu?.open) return menu.checked?.[0] ?? "";
      }
      throw new EdgeClientError("模型菜单未打开，无法读回当前模型");
    } finally {
      await this.closeModelMenu(targetId).catch(() => undefined);
    }
  }

  private async closeModelMenu(targetId: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stillOpen = await this.evaluate(targetId, `(() => document.querySelectorAll('[role="menu"]').length > 0)()`);
      if (stillOpen !== true) return;
      await this.evaluate(targetId, `(() => { const t = document.querySelector("[data-codex-intelligence-trigger]"); if (t) t.click(); return true; })()`);
      await this.sleep(200);
    }
  }

  async isGenerating(targetId: string, signal?: AbortSignal): Promise<boolean> {
    const state = await this.readState(targetId, signal);
    return state?.hasStop === true;
  }

  async getActiveTurns(targetId: string, signal?: AbortSignal): Promise<EdgeTurn[]> {
    const value = await this.evaluate(targetId, PAGE_TURNS_SCRIPT, signal) as { turns?: EdgeTurn[] } | undefined;
    return Array.isArray(value?.turns) ? value.turns : [];
  }

  /** 写入一段文本并发送；任何一步无法确认即抛错，绝不盲目重发。 */
  async fillAndSend(targetId: string, text: string, expectedUrl?: string, signal?: AbortSignal): Promise<string> {
    const state = await this.readState(targetId, signal);
    if (!state) throw new EdgeClientError("无法读取 ChatGPT 页面状态");
    if (!isNormalChatUrl(state.href)) throw new EdgeClientError("提交前页面已不是普通聊天页面；已放弃发送");
    if (expectedUrl && new URL(expectedUrl).pathname !== new URL(state.href).pathname) {
      throw new EdgeClientError("提交前页面已切换到其他会话；已放弃发送");
    }
    if (state.composerLength > 0) throw new EdgeClientError("ChatGPT 输入框里已有内容，不会覆盖；请清空后重试");
    if (!state.hasSend) throw new EdgeClientError("未找到发送按钮；请确认页面已加载且思考强度设置为「极高」");

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
    if (clicked !== true) throw new EdgeClientError("未能点击发送按钮；已放弃发送");

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

  /** 关闭标签页（仅用于我们自己创建的那个）。 */
  async closePage(targetId: string, signal?: AbortSignal): Promise<void> {
    const browser = await this.browser();
    try {
      await browser.send("Target.closeTarget", { targetId });
    } catch (error) {
      const response = await this.fetchImpl(`${this.endpoint}/json/close/${targetId}`, { signal });
      if (!response.ok) throw new EdgeClientError(`关闭标签页失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.sessions.delete(targetId);
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
  triggerFound: boolean;
  triggerText: string;
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
