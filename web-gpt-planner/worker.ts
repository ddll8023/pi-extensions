import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exchangeFingerprint, parseInboundExchange, type ExchangeIdentity } from "./exchange-protocol.ts";
import { PlannerTaskStore, type PlannerTaskState } from "./state-store.ts";
import { OrcaClient } from "./orca-client.ts";

export interface WorkerDependencies {
  pi: ExtensionAPI;
  storeFor(cwd: string): PlannerTaskStore;
  orcaFor(cwd: string): OrcaClient;
  getContext(): ExtensionContext | undefined;
  intervalMs?: number;
}

/** Bounded extension-side polling; the local session is notified only after a matching reply is complete. */
export class PlannerWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private polling = false;
  private readonly intervalMs: number;
  private readonly stableResponses = new Map<string, { fingerprint: string; observations: number }>();
  private readonly dependencies: WorkerDependencies;

  constructor(dependencies: WorkerDependencies) {
    this.dependencies = dependencies;
    this.intervalMs = dependencies.intervalMs ?? 2_000;
  }

  start(): void {
    this.stopped = false;
    if (!this.timer) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const ctx = this.dependencies.getContext();
      if (!ctx) return;
      const store = this.dependencies.storeFor(ctx.cwd);
      const active = await store.readActive();
      if (!active || active.projectRoot !== store.projectRoot) {
        this.stop();
        return;
      }
      const state = await store.readTask(active.taskId);
      if (!state || state.status !== "waiting" || state.stopRequested || !state.pending || !state.browserPageId) {
        this.stop();
        return;
      }
      if (Date.now() - Date.parse(state.pending.submittedAt) > 5 * 60_000) {
        state.status = "paused";
        state.pauseReason = "网页回复等待超过 5 分钟；检查原线程后再恢复，不要重发。";
        await store.writeTask(state);
        this.stop();
        return;
      }
      await this.pollExchange(store, state, this.dependencies.orcaFor(ctx.cwd));
    } catch (error) {
      const ctx = this.dependencies.getContext();
      if (ctx) ctx.ui.setStatus("web-gpt-planner", ctx.ui.theme.fg("warning", `网页协作等待失败：${error instanceof Error ? error.message : String(error)}`));
    } finally {
      this.polling = false;
      if (!this.stopped) this.schedule(this.intervalMs);
    }
  }

  private async pollExchange(store: PlannerTaskStore, state: PlannerTaskState, orca: OrcaClient): Promise<void> {
    const pending = state.pending;
    if (!pending) return;
    if (await orca.isGenerating(state.browserPageId!)) return;
    const messages = await orca.getActiveMessages(state.browserPageId!);
    const userIndex = messages.findLastIndex((message) => message.role === "user" && message.text.includes(pending.exchangeId));
    const assistant = userIndex >= 0
      ? messages.slice(userIndex + 1).findLast((message) => message.role === "assistant")
      : undefined;
    if (!assistant || messages.at(-1)?.role !== "assistant") return;

    const fingerprint = exchangeFingerprint(assistant.text);
    const previous = this.stableResponses.get(pending.exchangeId);
    if (!previous || previous.fingerprint !== fingerprint) {
      this.stableResponses.set(pending.exchangeId, { fingerprint, observations: 1 });
      return;
    }
    previous.observations += 1;
    if (previous.observations < 2) return;

    const identity: ExchangeIdentity = {
      taskId: state.taskId,
      exchangeId: pending.exchangeId,
      phaseId: pending.phaseId,
      planVersion: pending.planVersion,
    };
    let result;
    try {
      result = parseInboundExchange(assistant.text, identity);
    } catch (error) {
      if (this.stopped) return;
      const current = await store.readTask(state.taskId);
      if (!current || current.stopRequested || current.status === "stopped" || current.pending?.exchangeId !== pending.exchangeId) return;
      Object.assign(state, current);
      state.status = "paused";
      state.pauseReason = `网页回复协议无效：${error instanceof Error ? error.message : String(error)}。请核对原线程。`;
      await store.writeTask(state);
      this.stop();
      return;
    }
    if (this.stopped) return;
    const current = await store.readTask(state.taskId);
    if (!current || current.stopRequested || current.status === "stopped" || current.pending?.exchangeId !== pending.exchangeId) return;
    Object.assign(state, current);
    if (state.processedResponses.includes(fingerprint)) return;

    state.processedResponses.push(fingerprint);
    state.pending = undefined;
    if (result.kind === "NEED_CONTEXT" || (result.kind === "REVIEW" && result.decision === "NEED_CONTEXT")) {
      state.status = "gathering";
    } else if (result.kind === "REVIEW" && result.decision === "COMPLETE") {
      state.status = "completed";
    } else {
      state.status = "plan_ready";
      if (result.kind === "REVIEW" && result.decision === "CONTINUE" && result.next_phase_id && result.next_plan_version) {
        state.phaseId = result.next_phase_id;
        state.planVersion = result.next_plan_version;
      } else if (result.kind === "REVIEW" && result.decision === "REVISE" && result.next_plan_version) {
        state.planVersion = result.next_plan_version;
      }
    }
    state.pauseReason = undefined;
    await store.writeTask(state);
    await store.writeExchange(state.taskId, pending.exchangeId, { request: pending, response: result, fingerprint });
    if (result.kind === "PLAN" || result.kind === "REVIEW") await store.writeCurrentPlan(state.taskId, result.body);
    if (result.kind === "REVIEW") await store.writeCurrentReport(state.taskId, result.body);

    this.dependencies.pi.sendUserMessage(
      `web-gpt-planner 收到同一交互的网页回复。exchange_id=${pending.exchangeId}\nkind=${result.kind}${result.kind === "REVIEW" ? ` decision=${result.decision}` : ""}\n\n${result.body}`,
      { deliverAs: "followUp" },
    );
    this.stableResponses.delete(pending.exchangeId);
    if (state.status === "completed") await store.releaseActive(state.taskId);
    this.stop();
  }
}
