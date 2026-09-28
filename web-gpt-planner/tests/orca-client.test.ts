import assert from "node:assert/strict";
import test from "node:test";
import { OrcaClient, PROFILE_ENV_VAR, type OrcaExecResult } from "../orca-client.ts";

function result(value: unknown): OrcaExecResult {
  return { stdout: JSON.stringify({ ok: true, result: value }), stderr: "", code: 0, killed: false };
}

function clientWith(handler: (args: string[]) => unknown, cwd = "D:\\project"): OrcaClient {
  return new OrcaClient(async (_command, args) => result(handler(args)), "orca", cwd);
}

function withProfileEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[PROFILE_ENV_VAR];
  if (value === undefined) delete process.env[PROFILE_ENV_VAR];
  else process.env[PROFILE_ENV_VAR] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[PROFILE_ENV_VAR];
    else process.env[PROFILE_ENV_VAR] = previous;
  });
}

test("chat page discovery keeps ChatGPT pages from the current worktree and drops titles", async () => {
  const calls: string[][] = [];
  const client = new OrcaClient(async (_command, args) => {
    calls.push(args);
    return result({ tabs: [
      { browserPageId: "page-1", url: "https://chatgpt.com/", title: "private title" },
      { browserPageId: "page-2", url: "https://example.com/", title: "other" },
    ] });
  }, "orca", "D:\\project");
  const pages = await client.findChatPages();
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.browserPageId, "page-1");
  assert.equal(JSON.stringify(pages).includes("private title"), false);
  assert.deepEqual(calls[0], ["tab", "list", "--show-profile", "--worktree", "path:D:\\project"]);
});

test("profile resolution falls back to Orca's default without a hardcoded id", async () => {
  await withProfileEnv(undefined, async () => {
    const client = clientWith((args) => (args[1] === "list" ? { tabs: [] } : {}));
    assert.equal(await client.resolveProfileId(), "default");
  });
});

test("profile resolution reuses the profile of an existing ChatGPT tab", async () => {
  await withProfileEnv(undefined, async () => {
    const client = clientWith((args) => (args[1] === "list"
      ? { tabs: [{ browserPageId: "p", url: "https://chatgpt.com/", profileId: "p-7" }] }
      : {}));
    assert.equal(await client.resolveProfileId(), "p-7");
  });
});

test("profile resolution honours the environment override by id or label", async () => {
  await withProfileEnv("Planner", async () => {
    const client = clientWith((args) => (args[1] === "profile" ? { profiles: [{ id: "p-9", label: "Planner" }] } : {}));
    assert.equal(await client.resolveProfileId(), "p-9");
  });
});

test("profile resolution fails closed when the configured profile is absent", async () => {
  await withProfileEnv("missing-profile", async () => {
    const client = clientWith((args) => (args[1] === "profile" ? { profiles: [{ id: "default", label: "Default" }] } : {}));
    await assert.rejects(() => client.resolveProfileId(), /未匹配任何 Orca profile/);
  });
});

test("worktree resolution compares normalized paths", async () => {
  const client = clientWith((args) => (args[0] === "worktree" ? [{ id: "r::D:/project", path: "D:/project" }] : {}), "D:\\project");
  assert.equal((await client.resolveWorktree()).id, "r::D:/project");
});

test("worktree resolution fails closed outside a registered Orca workspace", async () => {
  const client = clientWith((args) => (args[0] === "worktree" ? [{ id: "x", path: "D:/elsewhere" }] : {}), "D:\\project");
  await assert.rejects(() => client.resolveWorktree(), /不是 Orca 已登记的工作区/);
});

test("ensureChatPage reuses a saved page id without creating another tab", async () => {
  const client = new OrcaClient(async (_command, args) => {
    if (args[0] === "worktree") return result([{ id: "r::D:/project", path: "D:/project" }]);
    if (args[1] === "list") return result({ tabs: [{ browserPageId: "saved", url: "https://chatgpt.com/c/abc" }] });
    throw new Error(`unexpected ${args.join(" ")}`);
  }, "orca", "D:\\project");
  const ensured = await client.ensureChatPage({ browserPageId: "saved" });
  assert.equal(ensured.created, false);
  assert.equal(ensured.page.browserPageId, "saved");
});

test("ensureChatPage confirms a newly created tab when the create payload omits the URL", async () => {
  await withProfileEnv(undefined, async () => {
    const created: string[][] = [];
    let listCalls = 0;
    const client = new OrcaClient(async (_command, args) => {
      if (args[0] === "worktree") return result([{ id: "r::D:/project", path: "D:/project" }]);
      if (args[1] === "list") {
        listCalls += 1;
        return result({ tabs: listCalls === 1 ? [] : [{ browserPageId: "new-page", url: "https://chatgpt.com/", profileId: "default", index: 2 }] });
      }
      if (args[1] === "create") {
        created.push(args);
        return result({ browserPageId: "new-page" });
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    }, "orca", "D:\\project");
    const ensured = await client.ensureChatPage();
    assert.equal(ensured.created, true);
    assert.equal(ensured.page.browserPageId, "new-page");
    assert.equal(ensured.page.url, "https://chatgpt.com/");
    assert.equal(ensured.worktree.id, "r::D:/project");
    assert.deepEqual(created[0], ["tab", "create", "--url", "https://chatgpt.com/", "--worktree", "path:D:\\project", "--profile", "default"]);
  });
});

test("ensureChatPage falls back to the newest new tab when the create payload has no id", async () => {
  await withProfileEnv(undefined, async () => {
    let listCalls = 0;
    const client = new OrcaClient(async (_command, args) => {
      if (args[0] === "worktree") return result([{ id: "r::D:/project", path: "D:/project" }]);
      if (args[1] === "list") {
        listCalls += 1;
        return result({ tabs: listCalls === 1
          ? [{ browserPageId: "old-page", url: "https://chatgpt.com/c/old", index: 1 }]
          : [
              { browserPageId: "old-page", url: "https://chatgpt.com/c/old", index: 1 },
              { browserPageId: "fresh-page", url: "https://chatgpt.com/", index: 2 },
            ] });
      }
      if (args[1] === "create") return result({ ok: true });
      throw new Error(`unexpected ${args.join(" ")}`);
    }, "orca", "D:\\project");
    const ensured = await client.ensureChatPage();
    assert.equal(ensured.page.browserPageId, "fresh-page");
  });
});

test("closePage closes by stable page id", async () => {
  const calls: string[][] = [];
  const client = new OrcaClient(async (_command, args) => {
    calls.push(args);
    return result({});
  }, "orca", "D:\\project");
  await client.closePage("page-1");
  assert.deepEqual(calls[0], ["tab", "close", "--page", "page-1"]);
});
