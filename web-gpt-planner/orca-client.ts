import { existsSync } from "node:fs";
import { join } from "node:path";

export interface OrcaExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type OrcaExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<OrcaExecResult>;

export interface OrcaPage {
  browserPageId: string;
  url: string;
  profileId?: string;
  worktreeId?: string;
}

export interface OrcaProfile {
  id: string;
  label?: string;
}

export interface OrcaWorktree {
  id: string;
  path: string;
}

/** Overrides the Orca browser profile used for new ChatGPT tabs; accepts a profile id or label. */
export const PROFILE_ENV_VAR = "WEB_GPT_PLANNER_ORCA_PROFILE";

export interface OrcaSnapshot {
  origin?: string;
  browserPageId: string;
  refs: Record<string, { name?: string; role?: string }>;
  snapshot: string;
}

export class OrcaClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrcaClientError";
  }
}

export function resolveOrcaCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCA_CLI_COMMAND?.trim()) return env.ORCA_CLI_COMMAND.trim();
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) {
    const installed = join(localAppData, "Programs", "orca", "resources", "bin", "orca.exe");
    if (existsSync(installed)) return installed;
  }
  return "orca";
}

function unwrapJson<T>(stdout: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new OrcaClientError("Orca returned non-JSON output");
  }
  if (typeof parsed !== "object" || parsed === null) throw new OrcaClientError("Orca returned an invalid response");
  const response = parsed as { ok?: unknown; error?: { message?: unknown }; result?: unknown };
  if (response.ok !== true) throw new OrcaClientError(typeof response.error?.message === "string" ? response.error.message : "Orca command failed");
  return response.result as T;
}

function pageFields(value: unknown): OrcaPage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const id = row.browserPageId ?? row.pageId ?? row.id;
  const url = row.url ?? row.href ?? row.currentUrl;
  const profileId = row.profileId ?? row.browserProfileId ?? row.sessionProfileId;
  const worktreeId = row.worktreeId ?? row.worktree_id;
  if (typeof id !== "string" || typeof url !== "string") return undefined;
  return {
    browserPageId: id,
    url,
    ...(typeof profileId === "string" ? { profileId } : {}),
    ...(typeof worktreeId === "string" ? { worktreeId } : {}),
  };
}

function rowsOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>)[key])) {
    return (value as Record<string, unknown[]>)[key];
  }
  return [];
}

function isChatGptUrl(url: string): boolean {
  return /^https:\/\/chatgpt\.com(?:\/|$)/i.test(url);
}

function profileFields(value: unknown): OrcaProfile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string") return undefined;
  return { id: row.id, ...(typeof row.label === "string" ? { label: row.label } : {}) };
}

function worktreeFields(value: unknown): OrcaWorktree | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.path !== "string") return undefined;
  return { id: row.id, path: row.path };
}

/** Orca reports either slash style; compare on a normalized key instead of raw strings. */
function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

export class OrcaClient {
  private readonly exec: OrcaExec;
  private readonly command: string;
  private readonly cwd: string;

  constructor(exec: OrcaExec, command: string, cwd: string) {
    this.exec = exec;
    this.command = command;
    this.cwd = cwd;
  }

  private async run<T>(args: string[], signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new OrcaClientError("Orca operation cancelled");
    const result = await this.exec(this.command, [...args, "--json"], { cwd: this.cwd, timeout: 30_000, signal });
    if (result.killed || result.code !== 0) {
      const detail = result.stderr.trim().slice(0, 500);
      throw new OrcaClientError(detail || `Orca command failed with exit code ${result.code}`);
    }
    return unwrapJson<T>(result.stdout);
  }

  /** Worktree-scoped tab listing; titles are never surfaced. */
  private async listTabs(worktreeSelector: string, signal?: AbortSignal): Promise<OrcaPage[]> {
    const result = await this.run<unknown>(["tab", "list", "--show-profile", "--worktree", worktreeSelector], signal);
    return rowsOf(result, "tabs").map(pageFields).filter((page): page is OrcaPage => Boolean(page));
  }

  /** ChatGPT pages registered in the Pi working directory's Orca worktree. */
  async findChatPages(signal?: AbortSignal): Promise<OrcaPage[]> {
    return (await this.listTabs(`path:${this.cwd}`, signal)).filter((page) => isChatGptUrl(page.url));
  }

  /** Locate a previously bound tab by its saved id, across worktrees. */
  async findTabById(pageId: string, signal?: AbortSignal): Promise<OrcaPage | undefined> {
    return (await this.listTabs("all", signal)).find((page) => page.browserPageId === pageId);
  }

  /** The current directory must already be an Orca workspace; the plugin never registers one. */
  async resolveWorktree(signal?: AbortSignal): Promise<OrcaWorktree> {
    const result = await this.run<unknown>(["worktree", "list"], signal);
    const wanted = normalizePathKey(this.cwd);
    const match = rowsOf(result, "worktrees")
      .map(worktreeFields)
      .filter((row): row is OrcaWorktree => Boolean(row))
      .find((row) => normalizePathKey(row.path) === wanted);
    if (!match) {
      throw new OrcaClientError(`当前目录不是 Orca 已登记的工作区（${this.cwd}）；请先在 Orca 中打开该目录，再执行 /sol-plan`);
    }
    return match;
  }

  async listProfiles(signal?: AbortSignal): Promise<OrcaProfile[]> {
    const result = await this.run<unknown>(["tab", "profile", "list"], signal);
    return rowsOf(result, "profiles").map(profileFields).filter((row): row is OrcaProfile => Boolean(row));
  }

  /** Env override, then the profile of an existing ChatGPT tab, then Orca's default. Never a hardcoded id. */
  async resolveProfileId(signal?: AbortSignal): Promise<string> {
    const preferred = (process.env[PROFILE_ENV_VAR] ?? "").trim();
    if (preferred) {
      const profiles = await this.listProfiles(signal);
      const match = profiles.find((profile) => profile.id === preferred)
        ?? profiles.find((profile) => (profile.label ?? "").toLowerCase() === preferred.toLowerCase());
      if (!match) {
        const available = profiles.map((profile) => profile.label ?? profile.id).join("、") || "无";
        throw new OrcaClientError(`${PROFILE_ENV_VAR}="${preferred}" 未匹配任何 Orca profile；可用：${available}`);
      }
      return match.id;
    }
    const existing = (await this.findChatPages(signal)).find((page) => page.profileId);
    return existing?.profileId ?? "default";
  }

  /** Reuse the saved tab when it still exists, otherwise create one in the current worktree. */
  async ensureChatPage(input: { browserPageId?: string; signal?: AbortSignal } = {}): Promise<{ page: OrcaPage; worktree: OrcaWorktree; created: boolean }> {
    const worktree = await this.resolveWorktree(input.signal);
    if (input.browserPageId) {
      const existing = await this.findTabById(input.browserPageId, input.signal);
      if (existing && isChatGptUrl(existing.url)) return { page: existing, worktree, created: false };
    }
    const profileId = await this.resolveProfileId(input.signal);
    const created = pageFields(await this.run<unknown>([
      "tab", "create", "--url", "https://chatgpt.com/", "--worktree", `path:${this.cwd}`, "--profile", profileId,
    ], input.signal));
    if (!created || !isChatGptUrl(created.url)) throw new OrcaClientError("Orca 未返回可用的 ChatGPT 标签页");
    return { page: created, worktree, created: true };
  }

  async closePage(pageId: string, signal?: AbortSignal): Promise<void> {
    await this.run(["tab", "close", "--page", pageId], signal);
  }

  async snapshot(pageId: string, signal?: AbortSignal): Promise<OrcaSnapshot> {
    const result = await this.run<Record<string, unknown>>(["snapshot", "--page", pageId], signal);
    const refsValue = result.refs;
    const refs: OrcaSnapshot["refs"] = {};
    if (typeof refsValue === "object" && refsValue !== null) {
      for (const [key, value] of Object.entries(refsValue)) {
        if (typeof value !== "object" || value === null) continue;
        const ref = value as Record<string, unknown>;
        refs[key] = {
          ...(typeof ref.name === "string" ? { name: ref.name } : {}),
          ...(typeof ref.role === "string" ? { role: ref.role } : {}),
        };
      }
    }
    return {
      ...(typeof result.origin === "string" ? { origin: result.origin } : {}),
      browserPageId: typeof result.browserPageId === "string" ? result.browserPageId : pageId,
      refs,
      snapshot: typeof result.snapshot === "string" ? result.snapshot : "",
    };
  }

  private findRef(snapshot: OrcaSnapshot, role: string, names: RegExp): string | undefined {
    return Object.entries(snapshot.refs).find(([, ref]) => ref.role === role && names.test(ref.name ?? ""))?.[0];
  }

  private async clickRef(pageId: string, ref: string, signal?: AbortSignal): Promise<void> {
    await this.run(["click", "--page", pageId, "--element", `@${ref}`], signal);
  }

  private async modelAndEffort(pageId: string, signal?: AbortSignal): Promise<void> {
    let snapshot = await this.snapshot(pageId, signal);
    const modelButton = this.findRef(snapshot, "button", /^(选择 ChatGPT 模型|Select ChatGPT model)$/i);
    if (!modelButton) throw new OrcaClientError("ChatGPT model selector is not visible");
    await this.clickRef(pageId, modelButton, signal);
    snapshot = await this.snapshot(pageId, signal);
    const chooseModel = this.findRef(snapshot, "menuitem", /^(选择模型|Select model)$/i);
    if (!chooseModel) throw new OrcaClientError("ChatGPT model menu is not accessible");
    await this.clickRef(pageId, chooseModel, signal);
    snapshot = await this.snapshot(pageId, signal);

    const latestRef = this.findRef(snapshot, "menuitemradio", /^(最新|Latest)$/i);
    if (!latestRef) throw new OrcaClientError("Latest model option is not visible");
    const latestLine = snapshot.snapshot.split(/\r?\n/).find((line) => line.includes(`ref=${latestRef}`)) ?? "";
    if (!/checked=true/i.test(latestLine)) throw new OrcaClientError("Latest is not selected; select it manually and retry");
    await this.run(["keypress", "--page", pageId, "--key", "Escape"], signal);
    snapshot = await this.snapshot(pageId, signal);

    const strengthRef = this.findRef(snapshot, "menuitem", /^(强度|Thinking intensity)$/i);
    if (!strengthRef) throw new OrcaClientError("Thinking intensity control is not visible");
    await this.run(["focus", "--page", pageId, "--element", `@${strengthRef}`], signal);
    snapshot = await this.snapshot(pageId, signal);
    if (!/极高[，,]?\s*第\s*4\s*项，共\s*5\s*项/.test(snapshot.snapshot)) {
      throw new OrcaClientError("极高思考强度未被读回；请手动选择后重试");
    }
    await this.run(["keypress", "--page", pageId, "--key", "Escape"], signal);
  }

  private async verifyChatMode(pageId: string, signal?: AbortSignal): Promise<void> {
    const expression = `JSON.stringify(Array.from(document.querySelectorAll("button")).filter(b => ["聊天","工作","Chat","Work"].includes((b.innerText || "").trim())).map(b => ({label:(b.innerText || "").trim(),pressed:b.getAttribute("aria-pressed"),selected:b.getAttribute("aria-selected"),state:b.getAttribute("data-state")})))`;
    const readStates = async (): Promise<Array<Record<string, unknown>>> => {
      const raw = await this.run<unknown>(["eval", "--page", pageId, "--expression", expression], signal);
      let value: unknown = raw;
      if (typeof value === "object" && value !== null && "value" in value && typeof value.value === "string") value = value.value;
      if (typeof value === "string") {
        try { value = JSON.parse(value) as unknown; } catch { throw new OrcaClientError("Chat/Work mode state is not readable"); }
      }
      if (!Array.isArray(value)) throw new OrcaClientError("Chat/Work mode state is not readable");
      return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
    };
    const selected = (item: Record<string, unknown> | undefined): boolean | undefined => {
      if (!item) return undefined;
      if (item.pressed === "true" || item.selected === "true" || item.state === "active" || item.state === "on") return true;
      if (item.pressed === "false" || item.selected === "false" || item.state === "inactive" || item.state === "off") return false;
      return undefined;
    };
    const items = await readStates();
    const chat = items.find((item) => item.label === "聊天" || item.label === "Chat");
    const work = items.find((item) => item.label === "工作" || item.label === "Work");
    if (selected(chat) !== true || selected(work) !== false) throw new OrcaClientError("Chat/Work 选中态无法确认；请手动选择聊天模式，网页提交已阻止");
  }

  async preflight(pageId: string, signal?: AbortSignal): Promise<{ model: string; thinkingLevel: string; mode: "chat" }> {
    const snapshot = await this.snapshot(pageId, signal);
    if (snapshot.origin?.includes("temporary-chat=true")) throw new OrcaClientError("Temporary chat is active; switch to a normal saved chat and retry");
    await this.modelAndEffort(pageId, signal);
    await this.verifyChatMode(pageId, signal);
    return { model: "latest", thinkingLevel: "extreme-high", mode: "chat" };
  }

  async startFreshChat(pageId: string, signal?: AbortSignal): Promise<string> {
    const snapshot = await this.snapshot(pageId, signal);
    const currentUrl = snapshot.origin ?? "https://chatgpt.com/";
    if (currentUrl.includes("temporary-chat=true")) throw new OrcaClientError("Temporary chat is active; switch to a normal saved chat and retry");
    if (!new URL(currentUrl).pathname.startsWith("/c/")) return currentUrl;
    const newChat = this.findRef(snapshot, "button", /^(新聊天|New chat)$/i) ?? this.findRef(snapshot, "link", /^(新聊天|New chat)$/i);
    if (!newChat) throw new OrcaClientError("New chat control is not visible; refusing to reuse an unknown thread");
    await this.clickRef(pageId, newChat, signal);
    const after = await this.snapshot(pageId, signal);
    if (after.origin?.includes("temporary-chat=true")) throw new OrcaClientError("New chat opened in temporary mode");
    if (!after.origin || after.origin === currentUrl) throw new OrcaClientError("Could not verify a fresh ChatGPT thread");
    return after.origin;
  }

  async fillAndSend(pageId: string, text: string, expectedUrl?: string, signal?: AbortSignal): Promise<string> {
    const before = await this.snapshot(pageId, signal);
    if (expectedUrl) {
      const expectedPath = new URL(expectedUrl).pathname;
      const currentPath = new URL(before.origin ?? "https://chatgpt.com/").pathname;
      if (expectedPath.startsWith("/c/") && currentPath !== expectedPath) throw new OrcaClientError("ChatGPT thread changed; refusing to submit to another conversation");
    }
    const textbox = Object.entries(before.refs).find(([, ref]) => ref.role === "textbox" && /(?:询问 ChatGPT|与 ChatGPT 聊天|Ask ChatGPT|Message ChatGPT)/i.test(ref.name ?? ""));
    if (!textbox) throw new OrcaClientError("ChatGPT composer textbox is not available");
    await this.run(["fill", "--page", pageId, "--element", `@${textbox[0]}`, "--value", text], signal);

    const afterFill = await this.snapshot(pageId, signal);
    const send = Object.entries(afterFill.refs).find(([, ref]) => ref.role === "button" && /^(发送|发送消息|Send)$/i.test(ref.name ?? ""));
    if (!send) throw new OrcaClientError("ChatGPT send button is unavailable; message was not submitted");
    await this.run(["click", "--page", pageId, "--element", `@${send[0]}`], signal);
    const afterSend = await this.snapshot(pageId, signal);
    const messages = await this.getActiveMessages(pageId, signal);
    const lastUser = messages.findLast((message) => message.role === "user");
    const exchangeId = text.match(/"exchange_id"\s*:\s*"([^"]+)"/)?.[1];
    if (!lastUser || (exchangeId && !lastUser.text.includes(exchangeId))) throw new OrcaClientError("Could not confirm the original exchange in the target thread; do not retry");
    return afterSend.origin ?? before.origin ?? "";
  }

  async isGenerating(pageId: string, signal?: AbortSignal): Promise<boolean> {
    const snapshot = await this.snapshot(pageId, signal);
    return /button \"(?:停止生成|Stop generating)\"/i.test(snapshot.snapshot);
  }

  /** Returns only active conversation message blocks; it never returns the full sidebar snapshot. */
  async getActiveMessages(pageId: string, signal?: AbortSignal): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
    const snapshot = await this.snapshot(pageId, signal);
    const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
    let role: "user" | "assistant" | undefined;
    let lines: string[] = [];
    const flush = () => {
      if (role && lines.length) messages.push({ role, text: lines.join("\n").trim() });
      lines = [];
    };
    for (const line of snapshot.snapshot.split(/\r?\n/)) {
      if (line.includes('heading "你说："') || line.includes('heading "You said:"')) {
        flush();
        role = "user";
        continue;
      }
      if (line.includes('heading "ChatGPT 说："') || line.includes('heading "ChatGPT said:"')) {
        flush();
        role = "assistant";
        continue;
      }
      if (!role || !line.includes("StaticText ")) continue;
      const match = line.match(/StaticText ("(?:\\.|[^"\\])*")/);
      if (match) {
        try { lines.push(JSON.parse(match[1]) as string); } catch { /* skip malformed accessibility text */ }
      }
    }
    flush();
    return messages;
  }
}
