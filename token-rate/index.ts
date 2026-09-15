import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
	type MessageEndEvent,
	type MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-rate";
const STATUS_UPDATE_INTERVAL_MS = 100;
const MIN_MEASURED_ELAPSED_MS = 250;

type TokenSource = "provider" | "estimate";

type TokenSnapshot = {
	tokens: number;
	source: TokenSource;
};

type ActiveResponse = {
	startedAt?: number;
	outputTokens: number;
	source: TokenSource;
	lastRenderedAt: number;
};

function positiveFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function snapshotFromStreamEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): TokenSnapshot | undefined {
	if (!("partial" in event)) return undefined;

	const providerTokens = positiveFiniteNumber(event.partial.usage?.output);
	if (providerTokens !== undefined) {
		return { tokens: providerTokens, source: "provider" };
	}

	const estimatedTokens = estimateTokens(event.partial);
	return estimatedTokens > 0 ? { tokens: estimatedTokens, source: "estimate" } : undefined;
}

function snapshotFromMessage(message: MessageEndEvent["message"]): TokenSnapshot | undefined {
	if (message.role !== "assistant") return undefined;

	const providerTokens = positiveFiniteNumber(message.usage.output);
	if (providerTokens !== undefined) {
		return { tokens: providerTokens, source: "provider" };
	}

	const estimatedTokens = estimateTokens(message);
	return estimatedTokens > 0 ? { tokens: estimatedTokens, source: "estimate" } : undefined;
}

function applySnapshot(response: ActiveResponse, snapshot: TokenSnapshot, timestamp: number): void {
	if (snapshot.source === "provider") {
		response.outputTokens = response.source === "provider"
			? Math.max(response.outputTokens, snapshot.tokens)
			: snapshot.tokens;
		response.source = "provider";
	} else if (response.source !== "provider") {
		response.outputTokens = Math.max(response.outputTokens, snapshot.tokens);
	}

	if (response.startedAt === undefined && response.outputTokens > 0) {
		response.startedAt = timestamp;
	}
}

function responseRate(response: ActiveResponse, timestamp: number, allowShortElapsed: boolean): number | undefined {
	if (response.startedAt === undefined || response.outputTokens <= 0) return undefined;

	const elapsedMs = timestamp - response.startedAt;
	if (elapsedMs <= 0 || (!allowShortElapsed && elapsedMs < MIN_MEASURED_ELAPSED_MS)) return undefined;

	return response.outputTokens / (elapsedMs / 1000);
}

function formatRate(rate: number): string {
	return rate >= 100 ? Math.round(rate).toString() : rate.toFixed(1);
}

function setStatus(ctx: ExtensionContext, text: string): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", text));
}

function createResponse(): ActiveResponse {
	return {
		outputTokens: 0,
		source: "estimate",
		lastRenderedAt: 0,
	};
}

function renderLiveRate(ctx: ExtensionContext, response: ActiveResponse, timestamp: number): void {
	if (timestamp - response.lastRenderedAt < STATUS_UPDATE_INTERVAL_MS) return;

	const rate = responseRate(response, timestamp, false);
	if (rate === undefined) return;

	const prefix = response.source === "estimate" ? "≈" : "";
	setStatus(ctx, `Token速率：${prefix}${formatRate(rate)} tok/s`);
	response.lastRenderedAt = timestamp;
}

function renderFinalRate(ctx: ExtensionContext, response: ActiveResponse, timestamp: number): void {
	const rate = responseRate(response, timestamp, true);
	if (rate === undefined) {
		setStatus(ctx, "Token速率：无流式数据");
		return;
	}

	const prefix = response.source === "estimate" ? "≈" : "";
	setStatus(ctx, `Token速率：${prefix}${formatRate(rate)} tok/s`);
}

export default function tokenRateExtension(pi: ExtensionAPI): void {
	let activeResponse: ActiveResponse | undefined;

	pi.on("session_start", async (_event, ctx) => {
		activeResponse = undefined;
		setStatus(ctx, "Token速率：—");
	});

	pi.on("turn_start", async (_event, ctx) => {
		activeResponse = undefined;
		setStatus(ctx, "Token速率：等待生成…");
	});

	pi.on("message_start", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;

		activeResponse = createResponse();
		setStatus(ctx, "Token速率：生成中…");
	});

	pi.on("message_update", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;

		const snapshot = snapshotFromStreamEvent(event.assistantMessageEvent);
		if (!snapshot) return;

		activeResponse ??= createResponse();
		const timestamp = Date.now();
		applySnapshot(activeResponse, snapshot, timestamp);
		renderLiveRate(ctx, activeResponse, timestamp);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const response = activeResponse;
		activeResponse = undefined;
		if (!response) return;

		const timestamp = Date.now();
		const snapshot = snapshotFromMessage(event.message);
		if (snapshot) applySnapshot(response, snapshot, timestamp);
		renderFinalRate(ctx, response, timestamp);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeResponse = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
