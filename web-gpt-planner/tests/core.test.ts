import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkTaskBudget } from "../context-budget.ts";
import { containsLikelySecret, createOutboundExchange, parseInboundExchange, validateSourcePath } from "../exchange-protocol.ts";
import { ActiveTaskError, PlannerTaskStore } from "../state-store.ts";

const taskId = "a41e2d9a-12bc-4f24-9a43-4bc9e3b681d8";
const exchangeId = "ba7b6128-90db-47e8-ae7a-7b9831439801";

 test("exchange envelopes require matching identity and review decision", () => {
  const request = createOutboundExchange({
    identity: { taskId, exchangeId, phaseId: "phase-1", planVersion: 1 },
    kind: "PLAN",
    text: "hello",
    sourceFiles: ["src/main.ts"],
  });
  assert.equal(request.protocol_version, 1);
  assert.equal(request.source_files[0], "src/main.ts");

  const result = parseInboundExchange(JSON.stringify({
    protocol_version: 1,
    task_id: taskId,
    exchange_id: exchangeId,
    phase_id: "phase-1",
    plan_version: 1,
    kind: "REVIEW",
    decision: "CONTINUE",
    next_phase_id: "phase-2",
    next_plan_version: 2,
    body: "Proceed with the next phase.",
  }), { taskId, exchangeId, phaseId: "phase-1", planVersion: 1 });
  assert.equal(result.decision, "CONTINUE");
  assert.throws(() => parseInboundExchange("{}", { taskId, exchangeId, phaseId: "phase-1", planVersion: 1 }));
});

test("planner 把正文放在 text 里时仍能解析（兼容别名）", () => {
  const identity = { taskId, exchangeId, phaseId: "phase-1", planVersion: 1 };
  const aliased = parseInboundExchange(JSON.stringify({
    protocol_version: 1,
    task_id: taskId,
    exchange_id: exchangeId,
    phase_id: "phase-1",
    plan_version: 1,
    kind: "PLAN",
    text: "阶段一计划：……",
  }), identity);
  assert.equal(aliased.body, "阶段一计划：……");
  assert.throws(
    () => parseInboundExchange(JSON.stringify({
      protocol_version: 1,
      task_id: taskId,
      exchange_id: exchangeId,
      phase_id: "phase-1",
      plan_version: 1,
      kind: "PLAN",
      body: "   ",
      text: "",
    }), identity),
    /body is empty/,
  );
});

test("source paths reject traversal and credential-like locations", () => {
  assert.equal(validateSourcePath("src/main.ts"), "src/main.ts");
  assert.throws(() => validateSourcePath("../secret.txt"));
  assert.throws(() => validateSourcePath(".env.local"));
  assert.throws(() => validateSourcePath(".pi/sol-planner/state.json"));
  assert.throws(() => validateSourcePath(".ssh/id_rsa"));
  assert.equal(containsLikelySecret("OPENAI_API_KEY=sk-abc1234567890123"), true);
});

test("task budget is cumulative and rejects overflow", () => {
  const estimator = (text: string) => Math.ceil(text.length / 4);
  const allowed = checkTaskBudget(100, "a small payload", estimator, 1_000);
  assert.equal(allowed.allowed, true);
  const rejected = checkTaskBudget(990, "a payload that exceeds the remaining budget", estimator, 1_000);
  assert.equal(rejected.allowed, false);
});

test("task store creates one project task and refuses a second active task", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-gpt-planner-core-"));
  const project = join(root, "project");
  const agent = join(root, "agent");
  try {
    const store = new PlannerTaskStore(project, agent);
    const state = await store.createTask({ projectRoot: project, taskText: "test task" });
    assert.equal((await store.readTask(state.taskId))?.status, "preflight");
    assert.equal((await readFile(join(store.taskDir(state.taskId), "brief.md"), "utf8")).trim(), "test task");
    await assert.rejects(() => store.createTask({ projectRoot: project, taskText: "second" }), ActiveTaskError);
    await store.releaseActive(state.taskId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
