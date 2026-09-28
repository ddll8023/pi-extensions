import assert from "node:assert/strict";
import test from "node:test";
import { OrcaClient, type OrcaExecResult } from "../orca-client.ts";

function result(value: unknown): OrcaExecResult {
  return { stdout: JSON.stringify({ ok: true, result: value }), stderr: "", code: 0, killed: false };
}

test("tab discovery returns only one ChatGPT page and omits titles", async () => {
  const calls: string[][] = [];
  const client = new OrcaClient(async (_command, args) => {
    calls.push(args);
    return result({ tabs: [
      { browserPageId: "page-1", url: "https://chatgpt.com/", title: "private title" },
      { browserPageId: "page-2", url: "https://example.com/", title: "other" },
    ] });
  }, "orca", "D:\\project");
  const page = await client.findSingleChatPage();
  assert.deepEqual(page, { browserPageId: "page-1", url: "https://chatgpt.com/" });
  assert.equal(JSON.stringify(page).includes("private title"), false);
  assert.equal(calls.length, 1);
});

test("ambiguous ChatGPT tabs fail closed", async () => {
  const client = new OrcaClient(async () => result({ tabs: [
    { browserPageId: "page-1", url: "https://chatgpt.com/" },
    { browserPageId: "page-2", url: "https://chatgpt.com/c/example" },
  ] }), "orca", "D:\\project");
  await assert.rejects(() => client.findSingleChatPage(), /Multiple ChatGPT tabs/);
});
