/**
 * Edge CDP 客户端单测：全部使用注入的假传输，不接触真实 Edge、不发起网络请求。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EdgeClient, EdgeClientError, PAGE_STATE_SCRIPT, isNormalChatUrl, isPersistedChatUrl, parseThinkingLevel, threadReplyScript, threadTaskScript, type CdpConnection, type ExecLike } from "../edge-client.ts";

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
  menuStaysOpen?: boolean;
  menuOpensAfterClicks?: number;
  createTargetFailures?: number;
  getTargetsFailures?: number;
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
    visible: true,
    composerFound: true,
    composerLength: 0,
    composerEmpty: true,
    focused: true,
    triggerFound: true,
    triggerText: "思考强度 极高",
    hasSend: true,
    hasStop: false,
    ...(options.state ?? {}),
  };
  const launched: string[][] = [];
  let versionOk = options.versionOk ?? true;
  let menuClicks = 0;
  const menuOpensAfter = options.menuOpensAfterClicks ?? 1;
  const menuVisible = () => menuClicks >= menuOpensAfter;
  let createTargetFailures = options.createTargetFailures ?? 0;
  let getTargetsFailures = options.getTargetsFailures ?? 0;

  const connection = new FakeConnection((method, params) => {
    if (method === "Target.attachToTarget") return { sessionId: "session-1" };
    if (method === "Target.getTargets") {
      if (getTargetsFailures > 0) { getTargetsFailures -= 1; throw new Error("CDP 命令超时：Target.getTargets"); }
      return { targetInfos: [] };
    }
    if (method === "Target.createTarget") {
      if (createTargetFailures > 0) { createTargetFailures -= 1; throw new Error("CDP 命令超时：Target.createTarget"); }
      return { targetId: "created-1" };
    }
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
      if (expression.includes("t.click()")) { menuClicks += 1; return { result: { value: true } }; }
      if (expression.includes("menuitemradio")) {
        return { result: { value: menuVisible() ? (options.menu ?? { open: true, checked: ["最新"] }) : { open: false, checked: [], all: [] } } };
      }
      if (expression.includes(`role="menu"]').length > 0`)) {
        return { result: { value: menuVisible() && options.menuStaysOpen === true } };
      }
      // composerLength() 助手使用的表达式单独回放输入框长度，否则写入校验永远拿不到数字。
      if (expression.includes("c.innerText")) return { result: { value: state.composerLength } };
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
  assert.deepEqual(created?.params, { url: CHAT_URL, background: false });
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
  const { client, connection } = makeHarness({ state: { composerLength: 12, composerEmpty: false } });
  await assert.rejects(() => client.fillAndSend("saved", "hello"), /已有 12 个字符的内容/);
  assert.equal(connection.calls.some((call) => call.method === "Input.insertText"), false);
});

test("页面状态脚本按去空白后的长度判断输入框是否为空", () => {
  assert.match(PAGE_STATE_SCRIPT, /composerLength: composerEl \? \(composerEl\.innerText \|\| ""\)\.trim\(\)\.length/);
  assert.match(PAGE_STATE_SCRIPT, /composerEmpty:/);
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

test("getReply 与 isGenerating 读取页面状态", async () => {
  const { client } = makeHarness({
    state: { hasStop: true },
    onEvaluate: (expression) =>
      expression.includes("thread-scroll-container")
        ? { result: { value: { containerFound: true, textLength: 900, occurrences: 2, lastRaw: '{"exchange_id":"x"}' } } }
        : undefined,
  });
  assert.equal(await client.isGenerating("saved"), true);
  const reply = await client.getReply("saved", "x");
  assert.equal(reply.occurrences, 2);
  assert.equal(reply.lastRaw, '{"exchange_id":"x"}');
});

test("getReply 在只有自己的请求时返回 lastRaw 为空", async () => {
  const { client } = makeHarness({
    onEvaluate: (expression) =>
      expression.includes("thread-scroll-container")
        ? { result: { value: { containerFound: true, textLength: 300, occurrences: 1, lastRaw: "" } } }
        : undefined,
  });
  const reply = await client.getReply("saved", "x");
  assert.equal(reply.occurrences, 1);
  assert.equal(reply.lastRaw, "");
});

test("回复提取脚本按括号配平与 exchange_id 匹配，不依赖回合结构", () => {
  const script = threadReplyScript("abc-123");
  assert.match(script, /thread-scroll-container/);
  assert.match(script, /JSON\.parse/);
  assert.match(script, /parsed\.exchange_id === wanted/);
  assert.equal(script.includes("data-message-author-role"), false);
  assert.equal(script.includes("div.relative.flex.flex-1"), false);
  assert.match(threadTaskScript("task-1"), /parsed\.task_id === wanted/);
});

test("isPersistedChatUrl 只认已持久化的会话地址", () => {
  assert.equal(isPersistedChatUrl("https://chatgpt.com/c/6aba965e-7d04-83ea-9dfd-ce571652eb2c"), true);
  assert.equal(isPersistedChatUrl("https://chatgpt.com/"), false);
  assert.equal(isPersistedChatUrl("https://chatgpt.com/c/local-chatgpt%3A489e1e97-94a3-4f0f-995e-55c29d564117"), false);
  assert.equal(isPersistedChatUrl("https://example.com/c/abc"), false);
});

test("中间形态的会话地址不做路径比对", async () => {
  const { client, connection } = makeHarness({
    state: { pathname: "/c/local-chatgpt%3A489e1e97", href: "https://chatgpt.com/c/local-chatgpt%3A489e1e97" },
    onEvaluate: (expression, state) => {
      if (!expression.includes("button.click()")) return undefined;
      state.composerLength = 0;
      state.hasStop = true;
      return { result: { value: true } };
    },
  });
  await client.fillAndSend("saved", "文本", "https://chatgpt.com/c/6aba965e-7d04-83ea-9dfd-ce571652eb2c");
  assert.equal(connection.calls.some((call) => call.method === "Input.insertText"), true);
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

test("ensureVisible 在不可见或没有焦点时激活", async () => {
  const hidden = makeHarness({ state: { visible: false } });
  assert.equal(await hidden.client.ensureVisible("saved"), true);
  assert.equal(hidden.connection.calls.some((call) => call.method === "Target.activateTarget"), true);

  const unfocused = makeHarness({ state: { visible: true, focused: false } });
  assert.equal(await unfocused.client.ensureVisible("saved"), true);
  assert.equal(unfocused.connection.calls.some((call) => call.method === "Target.activateTarget"), true);

  const visible = makeHarness();
  assert.equal(await visible.client.ensureVisible("saved"), false);
  assert.equal(visible.connection.calls.some((call) => call.method === "Target.activateTarget"), false);
});

test("菜单第一次点击没打开时会再点一次", async () => {
  const { client, connection } = makeHarness({ menuOpensAfterClicks: 2 });
  assert.deepEqual(await client.preflight("saved"), { model: "最新", thinkingLevel: "极高", mode: "chat" });
  assert.equal(connection.calls.filter((call) => String(call.params.expression ?? "").includes("t.click()")).length, 2);
});

test("preflight 与 fillAndSend 在读取/输入前先激活后台标签页", async () => {
  const { client, connection } = makeHarness({
    state: { visible: false, hasSend: false },
    onEvaluate: (expression, state) => {
      if (!expression.includes("button.click()")) return undefined;
      state.href = "https://chatgpt.com/c/abc";
      state.pathname = "/c/abc";
      state.composerLength = 0;
      state.hasStop = true;
      return { result: { value: true } };
    },
  });
  await client.preflight("saved");
  const activateIndex = connection.calls.findIndex((call) => call.method === "Target.activateTarget");
  const firstEvaluate = connection.calls.findIndex((call) => call.method === "Runtime.evaluate");
  assert.ok(activateIndex >= 0 && activateIndex < firstEvaluate, "预检应在读取状态前激活标签页");

  connection.calls.length = 0;
  await client.fillAndSend("saved", "文本");
  const insertIndex = connection.calls.findIndex((call) => call.method === "Input.insertText");
  const activateBeforeInsert = connection.calls.findIndex((call) => call.method === "Target.activateTarget");
  assert.ok(activateBeforeInsert >= 0 && activateBeforeInsert < insertIndex, "发送应在写入文本前激活标签页");
});

test("模型菜单关不掉时预检直接失败", async () => {
  const { client } = makeHarness({ menuStaysOpen: true });
  await assert.rejects(() => client.preflight("saved"), /模型菜单读取后未能关闭/);
});

test("createTab 在命令超时后重试成功", async () => {
  const { client, connection } = makeHarness({ pages: [], createTargetFailures: 2 });
  const ensured = await client.ensureChatPage();
  assert.equal(ensured.created, true);
  assert.equal(ensured.page.targetId, "created-1");
  assert.equal(connection.calls.filter((call) => call.method === "Target.createTarget").length, 3);
});

test("浏览器未就绪时先等命令可应答再建页", async () => {
  const { client, connection } = makeHarness({ pages: [], getTargetsFailures: 2 });
  await client.ensureChatPage();
  assert.equal(connection.calls.filter((call) => call.method === "Target.getTargets").length, 3);
});

test("closePage 在 CDP 关闭失败时回退到 HTTP 接口", async () => {
  const { client } = makeHarness({ closeTargetFails: true });
  await client.closePage("saved");
});

test("closePage 两条路径都失败时抛错", async () => {
  const { client } = makeHarness({ closeTargetFails: true, closeHttpFails: true });
  await assert.rejects(() => client.closePage("saved"), /关闭标签页失败/);
});
