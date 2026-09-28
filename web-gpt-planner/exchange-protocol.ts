import { createHash } from "node:crypto";
import { isAbsolute, normalize, posix, win32 } from "node:path";

export const WEB_PROTOCOL_VERSION = 1 as const;
export const MAX_WEB_ROUNDS = 6;

export type OutboundKind = "NEED_CONTEXT" | "PLAN" | "REPORT";
export type InboundKind = "NEED_CONTEXT" | "PLAN" | "REVIEW";
export type ReviewDecision = "CONTINUE" | "REVISE" | "NEED_CONTEXT" | "COMPLETE";

export interface OutboundExchange {
  protocol_version: typeof WEB_PROTOCOL_VERSION;
  task_id: string;
  exchange_id: string;
  phase_id: string;
  plan_version: number;
  kind: OutboundKind;
  source_files: string[];
  text: string;
}

export interface InboundExchange {
  protocol_version: typeof WEB_PROTOCOL_VERSION;
  task_id: string;
  exchange_id: string;
  phase_id: string;
  plan_version: number;
  kind: InboundKind;
  body: string;
  decision?: ReviewDecision;
  next_phase_id?: string;
  next_plan_version?: number;
}

export interface ExchangeIdentity {
  taskId: string;
  exchangeId: string;
  phaseId: string;
  planVersion: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_SEGMENTS = new Set([".git", ".pi", ".ssh", ".aws", ".azure", "node_modules", "secrets", "credentials", "private", "keys"]);

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Reject paths that escape the project or name common credential/state locations. */
export function validateSourcePath(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new Error("source path must be a non-empty string");
  const candidate = input.trim();
  const rawSegments = candidate.replaceAll("\\", "/").split("/");
  if (rawSegments.some((segment) => segment === "..")) throw new Error("source path escapes the project");
  if (candidate.includes("\0") || isAbsolute(candidate) || posix.isAbsolute(candidate) || win32.isAbsolute(candidate)) {
    throw new Error("source path must be project-relative");
  }
  const normalized = normalize(candidate).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) throw new Error("source path escapes the project");
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error("source path is excluded from planner context");
  }
  const baseName = segments.at(-1)?.toLowerCase() ?? "";
  if (baseName === ".env" || baseName.startsWith(".env.") || /(^|[._-])(secret|credential|token|password|id_rsa|id_ed25519)([._-]|$)/.test(baseName) || /\.(?:pem|p12|pfx)$/i.test(baseName)) {
    throw new Error("source path may contain credentials and is excluded");
  }
  return segments.join("/");
}

export function containsLikelySecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text)
    || /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[:=]\s*\S+/i.test(text)
    || /\bBearer\s+[A-Za-z0-9._-]{12,}/i.test(text)
    || /\bsk-[A-Za-z0-9]{12,}\b/i.test(text);
}

export function createOutboundExchange(input: {
  identity: ExchangeIdentity;
  kind: OutboundKind;
  text: string;
  sourceFiles?: string[];
}): OutboundExchange {
  if (!isTaskId(input.identity.taskId) || !isTaskId(input.identity.exchangeId)) throw new Error("invalid task or exchange id");
  if (typeof input.identity.phaseId !== "string" || input.identity.phaseId.trim() === "") throw new Error("phaseId is required");
  if (!Number.isInteger(input.identity.planVersion) || input.identity.planVersion < 1) throw new Error("planVersion must be a positive integer");
  if (!(input.kind === "NEED_CONTEXT" || input.kind === "PLAN" || input.kind === "REPORT")) throw new Error("unsupported outbound kind");
  if (typeof input.text !== "string" || input.text.trim() === "") throw new Error("exchange text is required");
  if (containsLikelySecret(input.text)) throw new Error("text appears to contain credentials and is excluded");
  const sourceFiles = (input.sourceFiles ?? []).map(validateSourcePath);
  if (new Set(sourceFiles).size !== sourceFiles.length) throw new Error("duplicate source paths are not allowed");
  return {
    protocol_version: WEB_PROTOCOL_VERSION,
    task_id: input.identity.taskId,
    exchange_id: input.identity.exchangeId,
    phase_id: input.identity.phaseId,
    plan_version: input.identity.planVersion,
    kind: input.kind,
    source_files: sourceFiles,
    text: input.text.trim(),
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first < 0 || last <= first) throw new Error("planner response is not valid protocol JSON");
    return JSON.parse(candidate.slice(first, last + 1)) as unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseInboundExchange(text: string, expected: ExchangeIdentity): InboundExchange {
  const value = extractJson(text);
  if (!isRecord(value)) throw new Error("planner response must be a JSON object");
  if (value.protocol_version !== WEB_PROTOCOL_VERSION) throw new Error("unsupported planner protocol version");
  if (value.task_id !== expected.taskId || value.exchange_id !== expected.exchangeId || value.phase_id !== expected.phaseId) {
    throw new Error("planner response does not match the active exchange");
  }
  if (value.plan_version !== expected.planVersion) throw new Error("planner response has a stale plan version");
  if (!(value.kind === "NEED_CONTEXT" || value.kind === "PLAN" || value.kind === "REVIEW")) throw new Error("unsupported planner response kind");
  const declaredBody = typeof value.body === "string" ? value.body.trim() : "";
  // 兼容别名：网页端常按请求信封的字段名镜像，把正文放在 text 里（请求自身用的就是 text）。
  const aliasedBody = typeof value.text === "string" ? value.text.trim() : "";
  const resolvedBody = declaredBody !== "" ? declaredBody : aliasedBody;
  if (resolvedBody === "") throw new Error("planner response body is empty (neither body nor text is filled)");

  let decision: ReviewDecision | undefined;
  let nextPhaseId: string | undefined;
  let nextPlanVersion: number | undefined;
  if (value.kind === "REVIEW") {
    if (!(value.decision === "CONTINUE" || value.decision === "REVISE" || value.decision === "NEED_CONTEXT" || value.decision === "COMPLETE")) {
      throw new Error("review response requires a supported decision");
    }
    decision = value.decision;
    if (decision === "CONTINUE") {
      if (typeof value.next_phase_id !== "string" || value.next_phase_id.trim() === "") throw new Error("CONTINUE requires next_phase_id");
      if (!Number.isInteger(value.next_plan_version) || Number(value.next_plan_version) <= expected.planVersion) throw new Error("CONTINUE requires a newer next_plan_version");
      nextPhaseId = value.next_phase_id;
      nextPlanVersion = Number(value.next_plan_version);
    }
    if (decision === "REVISE") {
      if (!Number.isInteger(value.next_plan_version) || Number(value.next_plan_version) <= expected.planVersion) throw new Error("REVISE requires a newer next_plan_version");
      nextPlanVersion = Number(value.next_plan_version);
    }
  }
  return {
    protocol_version: WEB_PROTOCOL_VERSION,
    task_id: expected.taskId,
    exchange_id: expected.exchangeId,
    phase_id: expected.phaseId,
    plan_version: expected.planVersion,
    kind: value.kind,
    body: resolvedBody,
    ...(decision ? { decision } : {}),
    ...(nextPhaseId ? { next_phase_id: nextPhaseId } : {}),
    ...(nextPlanVersion ? { next_plan_version: nextPlanVersion } : {}),
  };
}

export function exchangeFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
