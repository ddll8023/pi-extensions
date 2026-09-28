/**
 * Edge CDP 客户端单测：全部使用注入的假传输，不接触真实 Edge、不发起网络请求。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EdgeClient, EdgeClientError, PAGE_STATE_SCRIPT, isNormalChatUrl, parseThinkingLevel, type CdpConnection, type ExecLike } from "../edge-client.ts";

const CHAT_URL = "https://chatgpt.com/";

interface FakePage {
  id: string;
  type?: string;
  url: string;
}

class FakeConnection implements CdpConnection {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(private readonly reply: (method: string, params: Record<string, unknown>) => unknown) {}

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    return this.reply(method, params);
  }

  close(): void {}
}

interface HarnessOptions {
  pages?: FakePage[];
  versionOk?: boolean;
  readyAfterLaunch?: boolean;
  state?: Record<string, unknown>;
  menu?: unknown;
  closeTargetFails?: boolean;
  closeTargetError?: string;
  closeHttpFails?: boolean;
  listThrows?: boolean;
  launcher?: boolean;
  onEvaluate?: (expression: string, state: Record<string, unknown>) => unknown;
}

interface Harness {
  client: EdgeClient;
  connection: FakeConnection;
  launched: string[][];
  fetched: string[];
  state: Record<string, unknown>;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const state: Record<string, unknown> = {
    href: CHAT_URL,
    pathname: "/",
    search: "",
    composerFound: true,
    composerLength: 0,
    triggerFound: true,
    triggerText: "思考强度 极高",
    hasSend: true,
    hasStop: false,
    ...(options.state ?? {}),
  };
  const launched: string[][] = [];
  let versionOk = options.versionOk ?? true;

  const connection = new FakeConnection((method, params) => {
    if (method === "Target.attachToTarget") return { sessionId: "session-1" };
    if (method === "Target.createTarget") return { targetId: "created-1" };
    if (method === "Target.closeTarget") {
      if (options.closeTargetFails) throw new Error(options.closeTargetError ?? "not attached to target");
      return {};
    }
    if (method === "Input.insertText") {
      state.composerLength = String(params.text ?? "").length;
      return {};
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression ?? "");
      const custom = options.onEvaluate?.(expression, state);
      if (custom !== undefined) return custom;
      if (expression.includes("composerFound")) return { result: { value: { ...state } } };
      if (expression.includes("menuitemradio")) return { result: { value: options.menu ?? { open: true, checked: ["最新"] } } };
      if (expression.includes(`role="menu"]').length > 0`)) return { result: { value: false } };
      return { result: { value: true } };
    }
    return {};
  });

  const fetched: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const respond = (body: unknown, ok: boolean, status = ok ? 200 : 500) => ({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
    if (url.endsWith("/json/version")) {
      return versionOk
        ? respond({ Browser: "Edg/154.0.4258.37", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }, true)
        : respond({}, false, 404);
    }
    if (url.endsWith("/json/list")) {
      if (options.listThrows) throw new TypeError("fetch failed");
      return respond(options.pages ?? [{ id: "saved", type: "page", url: CHAT_URL }], true);
    }
    if (url.includes("/json/close/")) return options.closeHttpFails ? respond({}, false, 500) : respond("Target is closing", true);
    return respond({}, false, 404);
  }) as unknown as typeof fetch;

  const exec: ExecLike = async (command, args) => {
    launched.push([command, ...args]);
    if (options.readyAfterLaunch) versionOk = true;
    return { code: 0, stdout: "", stderr: "" };
  };

  const clock = { value: 0 };
  const client = new EdgeClient({
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    launcherPath: options.launcher === false ? "C:\\definitely\\missing\\PiAgent-Edge.bat" : process.execPath,
    exec,
    fetchImpl,
    connect: async () => connection,
    sleep: async (ms) => { clock.value += ms; },
    now: () => clock.value,
  });

  return { client, connection, launched, fetched, state };
}

test("parseThinkingLevel 支持中文与英文标签", () => {
  assert.equal(parseThinkingLevel("思考强度 极高"), "极高");
  assert.equal(parseThinkingLevel("极高"), "极高");
  assert.equal(parseThinkingLevel("Thinking Extended"), "Extended");
  assert.equal(parseThinkingLevel("中"), "中");
});

test("isNormalChatUrl 只接受普通聊天页面", () => {
  assert.equal(isNormalChatUrl("https://chatgpt.com/"), true);
  assert.equal(isNormalChatUrl("https://chatgpt.com/c/abc"), true);
  assert.equal(isNormalChatUrl("https://chatgpt.com/g/g-123-x"), false);
  assert.equal(isNormalChatUrl("https://chatgpt.com/?temporary-chat=true"), false);
  assert.equal(isNormalChatUrl("https://example.com/"), false);
});

test("端点未就绪且没有启动脚本时给出可操作的错误", async () => {
  const { client } = makeHarness({ versionOk: false, launcher: false });
  await assert.rejects(() => client.ensureEndpoint(), (error: unknown) => {
    assert.ok(error instanceof EdgeClientError);
    assert.match((error as Error).message, /未检测到 Edge 调试端点 http:\/\/127\.0\.0\.1:9222/);
    assert.match((error as Error).message, /PiAgent-Edge\.bat/);
    return true;
  });
});

test("端点未就绪时按需启动脚本并等待就绪", async () => {
  const { client, launched } = makeHarness({ versionOk: false, readyAfterLaunch: true, launcher: true });
  const version = await client.ensureEndpoint();
  assert.equal(version.browser, "Edg/154.0.4258.37");
  assert.deepEqual(launched[0], ["cmd", "/c", "start", "", "/min", process.execPath]);
});

test("listPages 只保留 page 类型", async () => {
  const { client } = makeHarness({
    pages: [
      { id: "p1", type: "page", url: CHAT_URL },
      { id: "b1", type: "background_page", url: "chrome-extension://x" },
    ],
  });
  assert.deepEqual(await client.listPages(), [{ targetId: "p1", url: CHAT_URL }]);
});

test("ensureChatPage 复用已保存的标签页", async () => {
  const { client, connection } = makeHarness({ pages: [{ id: "saved", type: "page", url: "https://chatgpt.com/c/1" }] });
  const ensured = await client.ensureChatPage({ browserPageId: "saved" });
  assert.equal(ensured.created, false);
  assert.equal(ensured.page.targetId, "saved");
  assert.equal(connection.calls.some((call) => call.method === "Target.createTarget"), false);
});

test("ensureChatPage 在没有可用标签页时新建", async () => {
  const { client, connection } = makeHarness({ pages: [] });
  const ensured = await client.ensureChatPage();
  assert.equal(ensured.created, true);
  assert.equal(ensured.page.targetId, "created-1");
  const created = connection.calls.find((call) => call.method === "Target.createTarget");
  assert.deepEqual(created?.params, { url: CHAT_URL, background: true });
});

test("ensureChatPage 复用不带会话 ID 的首页标签页", async () => {
  const { client, connection } = makeHarness({ pages: [{ id: "home", type: "page", url: CHAT_URL }] });
  const ensured = await client.ensureChatPage();
  assert.equal(ensured.created, false);
  assert.equal(ensured.page.targetId, "home");
  assert.equal(connection.calls.some((call) => call.method === "Target.createTarget"), false);
});

test("preflight 在「最新 + 极高」时通过，并只点击一次触发控件", async () => {
  const { client, connection } = makeHarness();
  assert.deepEqual(await client.preflight("saved"), { model: "最新", thinkingLevel: "极高", mode: "chat" });
  const clicks = connection.calls.filter((call) => String(call.params.expression ?? "").includes("t.click()"));
  assert.equal(clicks.length, 1);
});

test("页面状态脚本只在输入框容器内查找触发控件", () => {
  assert.match(PAGE_STATE_SCRIPT, /scopeEl\.querySelectorAll/);
  // 不得再出现全局的按钮兜底：侧边栏「探索」也带 aria-haspopup，会被误选。
  assert.equal(PAGE_STATE_SCRIPT.includes('document.querySelector("button'), false);
  assert.match(PAGE_STATE_SCRIPT, /findTrigger/);
});

test("preflight 控件缺失时报出输入框区域的实际控件", async () => {
  const { client } = makeHarness({ state: { triggerFound: false, triggerText: "", controls: ["探索||menu"] } });
  await assert.rejects(() => client.preflight("saved"), /未找到思考强度控件.*输入框区域控件：探索\|\|menu/s);
});

test("preflight 在思考强度不符时抛错", async () => {
  const { client } = makeHarness({ state: { triggerText: "中" } });
  await assert.rejects(() => client.preflight("saved"), /思考强度不是「极高」（当前：中）/);
});

test("preflight 在模型不是最新时抛错", async () => {
  const { client } = makeHarness({ menu: { open: true, checked: ["GPT-5.6 Sol"] } });
  await assert.rejects(() => client.preflight("saved"), /模型不是「最新」（当前：GPT-5\.6 Sol）/);
});

test("preflight 拒绝非普通聊天页面", async () => {
  const { client } = makeHarness({ state: { href: "https://chatgpt.com/g/g-123-x", pathname: "/g/g-123-x" } });
  await assert.rejects(() => client.preflight("saved"), /当前不是普通聊天页面/);
});

test("fillAndSend 在输入框已有内容时拒绝发送", async () => {
  const { client, connection } = makeHarness({ state: { composerLength: 12 } });
  await assert.rejects(() => client.fillAndSend("saved", "hello"), /输入框里已有内容/);
  assert.equal(connection.calls.some((call) => call.method === "Input.insertText"), false);
});

test("fillAndSend 在页面已切换会话时拒绝发送", async () => {
  const { client } = makeHarness({ state: { href: "https://chatgpt.com/c/other", pathname: "/c/other" } });
  await assert.rejects(() => client.fillAndSend("saved", "hello", "https://chatgpt.com/c/expected"), /页面已切换到其他会话/);
});

test("fillAndSend 写入后点击发送并返回会话 URL", async () => {
  const { client, connection } = makeHarness({
    onEvaluate: (expression, state) => {
      if (!expression.includes("button.click()")) return undefined;
      state.href = "https://chatgpt.com/c/abc";
      state.pathname = "/c/abc";
      state.composerLength = 0;
      state.hasStop = true;
      return { result: { value: true } };
    },
  });
  const url = await client.fillAndSend("saved", "本文本会通过注入传输写入");
  assert.equal(url, "https://chatgpt.com/c/abc");
  assert.equal(connection.calls.some((call) => call.method === "Input.insertText"), true);
});

test("fillAndSend 在文本未写入时放弃", async () => {
  const { client } = makeHarness({
    onEvaluate: (expression, state) => {
      if (expression.includes("c.focus()")) return { result: { value: true } };
      if (expression.includes("c.innerText")) return { result: { value: 0 } };
      if (expression.includes("execCommand")) return { result: { value: true } };
      return undefined;
    },
  });
  await assert.rejects(() => client.fillAndSend("saved", "abc"), /未能写入 ChatGPT 输入框/);
});

test("getActiveTurns 与 isGenerating 读取页面状态", async () => {
  const { client } = makeHarness({
    state: { hasStop: true },
    onEvaluate: (expression) => (expression.includes("thread-scroll-container") ? { result: { value: { containerFound: true, turns: [{ text: "a" }, { text: "b" }] } } } : undefined),
  });
  assert.equal(await client.isGenerating("saved"), true);
  assert.deepEqual(await client.getActiveTurns("saved"), [{ text: "a" }, { text: "b" }]);
});

test("closePage 在目标已不存在时视为已关闭", async () => {
  const { client, fetched } = makeHarness({ closeTargetFails: true, closeTargetError: "No target with given id found" });
  await client.closePage("gone");
  assert.equal(fetched.some((url) => url.includes("/json/close/")), false);
});

test("listPages 在端点不可达时给出带启动脚本的报错", async () => {
  const { client } = makeHarness({ listThrows: true });
  await assert.rejects(() => client.listPages(), (error: unknown) => {
    assert.ok(error instanceof EdgeClientError);
    assert.match((error as Error).message, /无法连接 Edge 调试端点 http:\/\/127\.0\.0\.1:9222/);
    assert.match((error as Error).message, /PiAgent-Edge\.bat/);
    return true;
  });
});

test("ensureChatPage 在端点不可用时不再抛裸的 fetch 错误", async () => {
  const { client } = makeHarness({ versionOk: false, launcher: false });
  await assert.rejects(() => client.ensureChatPage(), /未检测到 Edge 调试端点/);
});

test("preflight 等到页面渲染出思考强度控件再判断", async () => {
  let reads = 0;
  const { client } = makeHarness({
    state: { triggerFound: false, triggerText: "" },
    onEvaluate: (expression, state) => {
      if (!expression.includes("composerFound")) return undefined;
      reads += 1;
      if (reads >= 3) {
        state.triggerFound = true;
        state.triggerText = "思考强度 极高";
      }
      return { result: { value: { ...state } } };
    },
  });
  assert.deepEqual(await client.preflight("saved"), { model: "最新", thinkingLevel: "极高", mode: "chat" });
  assert.ok(reads >= 3);
});

test("preflight 在思考强度控件始终缺失时报出控件缺失而不是未知", async () => {
  const { client } = makeHarness({ state: { triggerFound: false, triggerText: "" } });
  await assert.rejects(() => client.preflight("saved"), /未找到思考强度控件/);
});

test("fillAndSend 在发送按钮插入文本后才出现时仍能发送", async () => {
  const { client } = makeHarness({
    state: { hasSend: false },
    onEvaluate: (expression, state) => {
      if (!expression.includes("button.click()")) return undefined;
      state.href = "https://chatgpt.com/c/abc";
      state.pathname = "/c/abc";
      state.composerLength = 0;
      state.hasStop = true;
      return { result: { value: true } };
    },
  });
  const url = await client.fillAndSend("saved", "文本");
  assert.equal(url, "https://chatgpt.com/c/abc");
});

test("closePage 在 CDP 关闭失败时回退到 HTTP 接口", async () => {
  const { client } = makeHarness({ closeTargetFails: true });
  await client.closePage("saved");
});

test("closePage 两条路径都失败时抛错", async () => {
  const { client } = makeHarness({ closeTargetFails: true, closeHttpFails: true });
  await assert.rejects(() => client.closePage("saved"), /关闭标签页失败/);
});
