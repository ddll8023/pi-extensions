import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
	type MessageEndEvent,
	type MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-rate";
const STATUS_UPDATE_INTERVAL_MS = 100;
const REALTIME_WINDOW_MS = 2_000;
const MIN_MEASURED_ELAPSED_MS = 250;

type TokenSource = "provider" | "estimate";

type TokenSnapshot = {
	tokens: number;
	source: TokenSource;
};

type RateMetric = {
	rate: number;
	approximate: boolean;
};

type RateSample = {
	timestamp: number;
	tokens: number;
};

type ActiveResponse = {
	startedAt?: number;
	outputTokens: number;
	source: TokenSource;
	lastRenderedAt: number;
	samples: RateSample[];
};

type ConversationTotals = {
	outputTokens: number;
	generationMs: number;
	hasEstimate: boolean;
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

function recordSample(response: ActiveResponse, timestamp: number): void {
	if (response.outputTokens <= 0) return;

	const lastSample = response.samples[response.samples.length - 1];
	if (lastSample?.timestamp !== timestamp || lastSample.tokens !== response.outputTokens) {
		response.samples.push({ timestamp, tokens: response.outputTokens });
	}

	const cutoff = timestamp - REALTIME_WINDOW_MS;
	while (response.samples.length > 1 && response.samples[1].timestamp < cutoff) {
		response.samples.shift();
	}
}

function applySnapshot(response: ActiveResponse, snapshot: TokenSnapshot, timestamp: number): void {
	const previousTokens = response.outputTokens;
	const previousSource = response.source;

	if (snapshot.source === "provider") {
		response.outputTokens = response.source === "provider"
			? Math.max(response.outputTokens, snapshot.tokens)
			: snapshot.tokens;
		response.source = "provider";
	} else if (response.source !== "provider") {
		response.outputTokens = Math.max(response.outputTokens, snapshot.tokens);
	}

	const startedNow = response.startedAt === undefined && response.outputTokens > 0;
	if (startedNow) response.startedAt = timestamp;

	if (response.source !== previousSource || response.outputTokens < previousTokens) {
		response.samples = [{ timestamp, tokens: startedNow ? 0 : response.outputTokens }];
	} else if (startedNow) {
		response.samples.push({ timestamp, tokens: 0 });
	}
	recordSample(response, timestamp);
}

function realtimeMetric(
	response: ActiveResponse,
	timestamp: number,
	allowShortElapsed: boolean,
): RateMetric | undefined {
	if (response.startedAt === undefined || response.outputTokens <= 0) return undefined;

	const responseElapsedMs = timestamp - response.startedAt;
	if (responseElapsedMs <= 0 || (!allowShortElapsed && responseElapsedMs < MIN_MEASURED_ELAPSED_MS)) {
		return undefined;
	}

	const cutoff = timestamp - REALTIME_WINDOW_MS;
	let baseline: RateSample | undefined;
	for (const sample of response.samples) {
		if (sample.timestamp <= cutoff) baseline = sample;
		else break;
	}
	baseline ??= response.samples[0];
	if (!baseline) return undefined;

	const elapsedMs = timestamp - baseline.timestamp;
	const tokenDelta = response.outputTokens - baseline.tokens;
	if (elapsedMs <= 0 || tokenDelta < 0) return undefined;

	return {
		rate: tokenDelta / (elapsedMs / 1000),
		approximate: response.source === "estimate",
	};
}

function averageMetric(
	totals: ConversationTotals,
	response: ActiveResponse | undefined,
	timestamp: number,
): RateMetric | undefined {
	let outputTokens = totals.outputTokens;
	let generationMs = totals.generationMs;
	let approximate = totals.hasEstimate;

	if (response?.startedAt !== undefined && response.outputTokens > 0) {
		const responseElapsedMs = timestamp - response.startedAt;
		if (responseElapsedMs > 0) {
			outputTokens += response.outputTokens;
			generationMs += responseElapsedMs;
			approximate ||= response.source === "estimate";
		}
	}

	if (outputTokens <= 0 || generationMs <= 0) return undefined;

	return {
		rate: outputTokens / (generationMs / 1000),
		approximate,
	};
}

function addCompletedResponse(
	totals: ConversationTotals,
	response: ActiveResponse,
	timestamp: number,
): void {
	if (response.startedAt === undefined || response.outputTokens <= 0) return;

	const generationMs = timestamp - response.startedAt;
	if (generationMs <= 0) return;

	totals.outputTokens += response.outputTokens;
	totals.generationMs += generationMs;
	totals.hasEstimate ||= response.source === "estimate";
}

function formatRate(rate: number): string {
	return rate >= 100 ? Math.round(rate).toString() : rate.toFixed(1);
}

function formatMetric(metric: RateMetric | undefined): string {
	if (!metric) return "—";
	return `${metric.approximate ? "≈" : ""}${formatRate(metric.rate)}/s`;
}

function clearStatus(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
}

function setStatus(ctx: ExtensionContext, realtime: RateMetric | undefined, average: RateMetric | undefined): void {
	if (ctx.mode !== "tui") return;
	if (!realtime && !average) {
		clearStatus(ctx);
		return;
	}

	const parts: string[] = [];
	if (realtime) parts.push(`实${formatMetric(realtime)}`);
	if (average) parts.push(`均${formatMetric(average)}`);
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `速率 ${parts.join(" ")}`));
}

function createResponse(): ActiveResponse {
	return {
		outputTokens: 0,
		source: "estimate",
		lastRenderedAt: 0,
		samples: [],
	};
}

function createTotals(): ConversationTotals {
	return {
		outputTokens: 0,
		generationMs: 0,
		hasEstimate: false,
	};
}

export default function tokenRateExtension(pi: ExtensionAPI): void {
	let activeResponse: ActiveResponse | undefined;
	let conversationTotals = createTotals();
	let renderTimer: ReturnType<typeof setInterval> | undefined;

	function stopRenderTimer(): void {
		if (renderTimer) clearInterval(renderTimer);
		renderTimer = undefined;
	}

	function renderLiveStatus(ctx: ExtensionContext, timestamp: number, force = false): void {
		if (!activeResponse) return;
		if (!force && timestamp - activeResponse.lastRenderedAt < STATUS_UPDATE_INTERVAL_MS) return;

		const realtime = realtimeMetric(activeResponse, timestamp, false);
		if (!force && !realtime) return;

		setStatus(ctx, realtime, averageMetric(conversationTotals, activeResponse, timestamp));
		activeResponse.lastRenderedAt = timestamp;
	}

	function startRenderTimer(ctx: ExtensionContext): void {
		stopRenderTimer();
		renderTimer = setInterval(() => renderLiveStatus(ctx, Date.now()), STATUS_UPDATE_INTERVAL_MS);
	}

	function resetConversation(ctx: ExtensionContext): void {
		stopRenderTimer();
		activeResponse = undefined;
		conversationTotals = createTotals();
		setStatus(ctx, undefined, undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetConversation(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		stopRenderTimer();
		activeResponse = undefined;
		clearStatus(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;

		activeResponse = createResponse();
		clearStatus(ctx);
		startRenderTimer(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;

		const snapshot = snapshotFromStreamEvent(event.assistantMessageEvent);
		if (!snapshot) return;

		activeResponse ??= createResponse();
		if (!renderTimer) startRenderTimer(ctx);

		const timestamp = Date.now();
		applySnapshot(activeResponse, snapshot, timestamp);
		renderLiveStatus(ctx, timestamp);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const response = activeResponse;
		activeResponse = undefined;
		stopRenderTimer();
		if (!response) return;

		const timestamp = Date.now();
		const snapshot = snapshotFromMessage(event.message);
		if (snapshot) applySnapshot(response, snapshot, timestamp);

		addCompletedResponse(conversationTotals, response, timestamp);
		clearStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetConversation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopRenderTimer();
		activeResponse = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
