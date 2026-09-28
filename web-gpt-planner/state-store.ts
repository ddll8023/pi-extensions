import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OutboundKind } from "./exchange-protocol.ts";

export type TaskStatus =
  | "preflight"
  | "gathering"
  | "waiting"
  | "plan_ready"
  | "awaiting_approval"
  | "executing"
  | "report_ready"
  | "paused"
  | "stopped"
  | "completed";

export interface PendingExchange {
  exchangeId: string;
  phaseId: string;
  planVersion: number;
  kind: OutboundKind;
  text: string;
  fingerprint: string;
  estimatedTokens: number;
  submittedAt: string;
  submissionState: "intent" | "accepted" | "unknown";
}

export interface PlannerTaskState {
  version: 1;
  taskId: string;
  projectRoot: string;
  sessionName?: string;
  browserPageId?: string;
  browserProfileId?: string;
  worktreeId?: string;
  chatUrl?: string;
  allowedSourceFiles: string[];
  selectedModel?: string;
  thinkingLevel?: string;
  composerMode?: "chat" | "unknown";
  status: TaskStatus;
  phaseId: string;
  planVersion: number;
  roundsUsed: number;
  estimatedTokensUsed: number;
  pending?: PendingExchange;
  processedResponses: string[];
  stopRequested: boolean;
  pauseReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveTaskIndex {
  version: 1;
  taskId: string;
  projectRoot: string;
  pid: number;
  sessionName?: string;
  createdAt: string;
}

export interface CreateTaskInput {
  projectRoot: string;
  sessionName?: string;
  taskText: string;
}

export class ActiveTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActiveTaskError";
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    try { await unlink(temporary); } catch { /* preserve the original error */ }
    throw error;
  }
}

function isTaskId(taskId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId);
}

export class PlannerTaskStore {
  readonly projectRoot: string;
  readonly baseDir: string;
  readonly activeIndexPath: string;
  private readonly queue = new Map<string, Promise<void>>();

  constructor(projectRoot: string, agentDir: string) {
    if (!isAbsolute(projectRoot) || !isAbsolute(agentDir)) throw new Error("projectRoot and agentDir must be absolute");
    this.projectRoot = resolve(projectRoot);
    this.baseDir = join(this.projectRoot, ".pi", "sol-planner");
    this.activeIndexPath = join(agentDir, "web-gpt-planner", "active-task.json");
  }

  taskDir(taskId: string): string {
    if (!isTaskId(taskId)) throw new Error("invalid task id");
    return join(this.baseDir, taskId);
  }

  async readActive(): Promise<ActiveTaskIndex | undefined> {
    return readJson<ActiveTaskIndex>(this.activeIndexPath);
  }

  async claimActiveForResume(taskId: string, sessionName?: string): Promise<ActiveTaskIndex> {
    const current = await this.readActive();
    if (!current || current.taskId !== taskId) throw new ActiveTaskError("active task index changed; pause for reconciliation");
    if (current.pid === process.pid) return current;
    try {
      process.kill(current.pid, 0);
      throw new ActiveTaskError("another Pi process still owns the active task");
    } catch (error) {
      if (error instanceof ActiveTaskError) throw error;
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") {
        throw new ActiveTaskError("could not verify the previous Pi process; refusing concurrent resume");
      }
    }

    const resumeLockPath = join(dirname(this.activeIndexPath), "active-task.resume.lock");
    let lockHandle;
    try {
      lockHandle = await open(resumeLockPath, "wx", 0o600);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw new ActiveTaskError("another Pi process is recovering this task");
      }
      throw error;
    }
    try {
      const latest = await this.readActive();
      if (!latest || latest.taskId !== taskId || latest.pid !== current.pid) throw new ActiveTaskError("active task changed during recovery");
      const claimed: ActiveTaskIndex = { ...latest, pid: process.pid, ...(sessionName ? { sessionName } : {}) };
      await writeAtomic(this.activeIndexPath, JSON.stringify(claimed, null, 2));
      return claimed;
    } finally {
      await lockHandle.close();
      try { await unlink(resumeLockPath); } catch { /* recovery remains fail-closed */ }
    }
  }

  async readTask(taskId: string): Promise<PlannerTaskState | undefined> {
    const directory = this.taskDir(taskId);
    const path = join(directory, "state.json");
    try {
      await this.assertProjectChild(directory);
      await this.assertProjectChild(path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    return readJson<PlannerTaskState>(path);
  }

  async readBrief(taskId: string): Promise<string> {
    const directory = this.taskDir(taskId);
    const path = join(directory, "brief.md");
    await this.assertProjectChild(directory);
    await this.assertProjectChild(path);
    return readFile(path, "utf8");
  }

  private async assertProjectChild(target: string): Promise<void> {
    const root = await realpath(this.projectRoot);
    const actual = await realpath(target);
    const fromRoot = relative(root, actual);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("planner state path resolves outside the project");
    }
  }

  async createTask(input: CreateTaskInput): Promise<PlannerTaskState> {
    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const active: ActiveTaskIndex = {
      version: 1,
      taskId,
      projectRoot: this.projectRoot,
      pid: process.pid,
      ...(input.sessionName ? { sessionName: input.sessionName } : {}),
      createdAt,
    };
    await mkdir(this.baseDir, { recursive: true });
    await this.assertProjectChild(this.baseDir);
    await mkdir(dirname(this.activeIndexPath), { recursive: true });
    let activeHandle: FileHandle;
    try {
      activeHandle = await open(this.activeIndexPath, "wx", 0o600);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        const existing = await this.readActive();
        throw new ActiveTaskError(existing ? `active task ${existing.taskId} already exists; use /sol-status or /sol-resume` : "active task index exists but is unreadable; pause for manual recovery");
      }
      throw error;
    }

    const state: PlannerTaskState = {
      version: 1,
      taskId,
      projectRoot: this.projectRoot,
      ...(input.sessionName ? { sessionName: input.sessionName } : {}),
      allowedSourceFiles: [],
      status: "preflight",
      phaseId: "phase-1",
      planVersion: 1,
      roundsUsed: 0,
      estimatedTokensUsed: 0,
      processedResponses: [],
      stopRequested: false,
      createdAt,
      updatedAt: createdAt,
    };
    const directory = this.taskDir(taskId);
    try {
      await activeHandle.writeFile(JSON.stringify(active, null, 2), "utf8");
      await activeHandle.sync();
      await mkdir(join(directory, "exchanges"), { recursive: true });
      await this.assertProjectChild(directory);
      await this.assertProjectChild(join(directory, "exchanges"));
      await writeAtomic(join(directory, "brief.md"), `${input.taskText.trim()}\n`);
      await writeAtomic(join(directory, "plan.md"), "# 当前有效计划\n\n待规划。\n");
      await writeAtomic(join(directory, "report.md"), "# 阶段报告\n\n尚无执行结果。\n");
      await writeAtomic(join(directory, "state.json"), JSON.stringify(state, null, 2));
      return state;
    } catch (error) {
      try { await unlink(this.activeIndexPath); } catch { /* keep original error */ }
      throw error;
    } finally {
      await activeHandle.close();
    }
  }

  async writeTask(state: PlannerTaskState): Promise<void> {
    if (state.projectRoot !== this.projectRoot || !isTaskId(state.taskId)) throw new Error("task state does not belong to this project");
    await this.assertProjectChild(this.taskDir(state.taskId));
    await this.assertProjectChild(join(this.taskDir(state.taskId), "state.json"));
    await this.withQueue(state.taskId, async () => {
      const updated: PlannerTaskState = { ...state, updatedAt: new Date().toISOString() };
      await writeAtomic(join(this.taskDir(state.taskId), "state.json"), JSON.stringify(updated, null, 2));
      Object.assign(state, updated);
    });
  }

  async writeExchange(taskId: string, exchangeId: string, data: unknown): Promise<void> {
    if (!isTaskId(taskId) || !isTaskId(exchangeId)) throw new Error("invalid exchange path component");
    const directory = join(this.taskDir(taskId), "exchanges");
    await this.assertProjectChild(this.taskDir(taskId));
    await this.assertProjectChild(directory);
    await writeAtomic(join(directory, `${exchangeId}.json`), JSON.stringify(data, null, 2));
  }

  async writeCurrentPlan(taskId: string, plan: string): Promise<void> {
    const directory = this.taskDir(taskId);
    await this.assertProjectChild(directory);
    await writeAtomic(join(directory, "plan.md"), `${plan.trim()}\n`);
  }

  async writeCurrentReport(taskId: string, report: string): Promise<void> {
    const directory = this.taskDir(taskId);
    await this.assertProjectChild(directory);
    await writeAtomic(join(directory, "report.md"), `${report.trim()}\n`);
  }

  async releaseActive(taskId: string): Promise<void> {
    const active = await this.readActive();
    if (!active || active.taskId !== taskId) return;
    await unlink(this.activeIndexPath);
  }

  private async withQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    const tail = previous.then(() => current);
    this.queue.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queue.get(key) === tail) this.queue.delete(key);
    }
  }
}
