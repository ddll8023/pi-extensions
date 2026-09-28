import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const CODEX_API = "openai-codex-responses";
const STATUS_KEY = "codex-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const POLL_INTERVAL_MS = 60_000;
const MIN_FETCH_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

type UsageWindow = {
	windowSeconds: number;
	remainingPercent: number;
	resetAt?: number;
};

type QuotaSnapshot = {
	windows: UsageWindow[];
	credits?: string;
	limitReached: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

/** 当前会话是否正在使用 Codex 模型，非 Codex 模型不显示额度状态。 */
function isCodexModel(ctx: ExtensionContext): boolean {
	return ctx.model?.api === CODEX_API;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return undefined;

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeAccountId(accessToken: string): string | undefined {
	try {
		const payloadPart = accessToken.split(".")[1];
		if (!payloadPart) return undefined;

		const payload = JSON.parse(
			Buffer.from(payloadPart.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"),
		) as unknown;
		if (!isRecord(payload)) return undefined;

		const authClaim = payload["https://api.openai.com/auth"];
		if (!isRecord(authClaim)) return undefined;

		const accountId = authClaim.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function parseCredits(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (value.unlimited === true) return "∞";
	if (value.has_credits === false) return undefined;

	const balance = value.balance;
	if (balance === undefined || balance === null || String(balance).trim() === "") return undefined;

	const text = String(balance).trim();
	return text.startsWith("$") ? text : `$${text}`;
}

function parseUsagePayload(payload: unknown): QuotaSnapshot {
	if (!isRecord(payload)) {
		throw new Error("Codex 额度接口返回了无效数据");
	}

	const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
	const windows: UsageWindow[] = [];

	for (const key of ["primary_window", "secondary_window"]) {
		const window = rateLimit && isRecord(rateLimit[key]) ? rateLimit[key] : undefined;
		if (!window) continue;

		const usedPercent = finiteNumber(window.used_percent);
		const windowSeconds = finiteNumber(window.limit_window_seconds);
		if (usedPercent === undefined || windowSeconds === undefined || windowSeconds <= 0) continue;

		const resetAt = finiteNumber(window.reset_at);
		const boundedUsedPercent = Math.max(0, Math.min(100, usedPercent));
		windows.push({
			windowSeconds,
			remainingPercent: 100 - boundedUsedPercent,
			...(resetAt !== undefined ? { resetAt } : {}),
		});
	}

	windows.sort((left, right) => left.windowSeconds - right.windowSeconds);

	return {
		windows,
		credits: parseCredits(payload.credits),
		limitReached: rateLimit?.limit_reached === true,
	};
}

async function fetchQuota(ctx: ExtensionContext, signal: AbortSignal): Promise<QuotaSnapshot | null> {
	const resolvedAuth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	const accessToken = resolvedAuth?.auth.apiKey;
	if (!accessToken) return null;
	if (signal.aborted) throw new Error("Codex 额度请求已取消");

	const accountId = decodeAccountId(accessToken);
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
	const abortRequest = () => timeoutController.abort();
	signal.addEventListener("abort", abortRequest, { once: true });

	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "pi-codex-usage-extension",
		};
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;

		const response = await fetch(USAGE_URL, {
			method: "GET",
			headers,
			signal: timeoutController.signal,
		});
		if (!response.ok) {
			throw new Error(`Codex 额度接口返回 HTTP ${response.status}`);
		}

		return parseUsagePayload(await response.json());
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortRequest);
	}
}

function formatWindowLabel(seconds: number): string {
	if (seconds % 604_800 === 0) return `${seconds / 604_800}周`;
	if (seconds % 86_400 === 0) return `${seconds / 86_400}天`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}小时`;
	if (seconds % 60 === 0) return `${seconds / 60}分钟`;
	return `${Math.round(seconds)}秒`;
}

/** 将重置时间换算成“还剩多久”的简短文案，用于宽度有限的状态栏。 */
function formatCountdown(resetAt: number | undefined): string {
	if (resetAt === undefined) return "重置时间未知";

	const remainingMinutes = Math.floor((resetAt * 1000 - Date.now()) / 60_000);
	if (remainingMinutes <= 0) return "即将重置";

	const days = Math.floor(remainingMinutes / 1_440);
	const hours = Math.floor((remainingMinutes % 1_440) / 60);
	const minutes = remainingMinutes % 60;

	if (days > 0) return `${days}天${hours}小时后重置`;
	if (hours > 0) return `${hours}小时${minutes}分后重置`;
	return `${minutes}分钟后重置`;
}

function formatCompactReset(resetAt: number | undefined): string {
	const countdown = formatCountdown(resetAt);
	if (countdown === "重置时间未知") return "↻?";
	if (countdown === "即将重置") return "↻即将";

	return `↻${countdown.replace(/后重置$/, "").replaceAll("小时", "时").replaceAll("分钟", "分")}`;
}

function formatStatus(snapshot: QuotaSnapshot): string {
	if (snapshot.windows.length === 0) {
		return snapshot.limitReached ? "Codex额度：已达到限制" : "Codex额度：暂无数据";
	}

	const windows = snapshot.windows
		.map((window) => `${formatWindowLabel(window.windowSeconds)}${Math.round(window.remainingPercent)}%${formatCompactReset(window.resetAt)}`)
		.join(" ");
	const credits = snapshot.credits ? ` 余额${snapshot.credits}` : "";
	return `Codex ${windows}${credits}`;
}

function formatResetTime(resetAt: number | undefined): string {
	if (resetAt === undefined) return "未知";

	const resetDate = new Date(resetAt * 1000);
	const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(resetDate);
	if (resetDate.toDateString() === new Date().toDateString()) return `今天 ${time}`;

	return new Intl.DateTimeFormat("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(resetDate);
}

function formatDetails(snapshot: QuotaSnapshot): string {
	if (snapshot.windows.length === 0) {
		return snapshot.limitReached ? "Codex 额度已达到限制" : "Codex 暂无可用额度数据";
	}

	const windows = snapshot.windows
		.map(
			(window) =>
				`${formatWindowLabel(window.windowSeconds)}剩余 ${Math.round(window.remainingPercent)}%（${formatCountdown(window.resetAt)}，重置时间 ${formatResetTime(window.resetAt)}）`,
		)
		.join("；");
	const credits = snapshot.credits ? `；余额 ${snapshot.credits}` : "";
	return `Codex：${windows}${credits}`;
}

function statusColor(snapshot: QuotaSnapshot): "accent" | "warning" | "error" {
	if (snapshot.limitReached || snapshot.windows.some((window) => window.remainingPercent <= 0)) return "error";
	if (snapshot.windows.some((window) => window.remainingPercent <= 20)) return "warning";
	return "accent";
}

export default function codexUsageExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;
	let isActive = false;
	let activeContext: ExtensionContext | undefined;
	let activeRequest: { controller: AbortController } | undefined;
	let lastAttemptAt = 0;
	let lastSnapshot: QuotaSnapshot | undefined;

	function setStatus(ctx: ExtensionContext, text: string, color: "accent" | "warning" | "error" = "accent"): void {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
	}

	function clearPolling(ctx?: ExtensionContext): void {
		generation += 1;
		isActive = false;
		activeContext = undefined;
		lastSnapshot = undefined;
		lastAttemptAt = 0;
		activeRequest?.controller.abort();
		activeRequest = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	async function refreshQuota(
		ctx: ExtensionContext,
		expectedGeneration?: number,
		force = false,
	): Promise<QuotaSnapshot | null | undefined> {
		if (expectedGeneration !== undefined && expectedGeneration !== generation) return undefined;
		if (activeRequest) return lastSnapshot;

		const now = Date.now();
		if (!force && now - lastAttemptAt < MIN_FETCH_INTERVAL_MS) return lastSnapshot;

		const request = { controller: new AbortController() };
		activeRequest = request;
		lastAttemptAt = now;
		try {
			const snapshot = await fetchQuota(ctx, request.controller.signal);
			if (expectedGeneration !== undefined && expectedGeneration !== generation) return snapshot;

			lastSnapshot = snapshot ?? undefined;
			if (!snapshot) {
				if (isActive && activeContext === ctx) ctx.ui.setStatus(STATUS_KEY, undefined);
				return null;
			}

			if (isActive && activeContext === ctx) {
				setStatus(ctx, formatStatus(snapshot), statusColor(snapshot));
			}
			return snapshot;
		} catch {
			if (isActive && activeContext === ctx && !lastSnapshot) {
				setStatus(ctx, "Codex额度：刷新失败", "warning");
			}
			return undefined;
		} finally {
			if (activeRequest === request) activeRequest = undefined;
		}
	}

	function startPolling(ctx: ExtensionContext): void {
		clearPolling(ctx);
		isActive = true;
		activeContext = ctx;
		const currentGeneration = generation;
		setStatus(ctx, "Codex额度：读取中…", "accent");

		void refreshQuota(ctx, currentGeneration, true);
		timer = setInterval(() => {
			// 先用上一次数据重绘，保证接口偶发失败时倒计时仍在走。
			if (lastSnapshot) setStatus(ctx, formatStatus(lastSnapshot), statusColor(lastSnapshot));
			void refreshQuota(ctx, currentGeneration);
		}, POLL_INTERVAL_MS);
	}

	pi.registerCommand("codex-usage", {
		description: "刷新并查看 Codex 账号额度",
		handler: async (_args, ctx) => {
			const snapshot = await refreshQuota(ctx, undefined, true);
			if (!snapshot) {
				ctx.ui.notify("未读取到 Codex 额度，请确认已通过 /login 登录 ChatGPT/Codex。", "error");
				return;
			}

			if (isActive && activeContext === ctx) {
				setStatus(ctx, formatStatus(snapshot), statusColor(snapshot));
			}
			ctx.ui.notify(formatDetails(snapshot), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui" && isCodexModel(ctx)) startPolling(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		if (!isCodexModel(ctx)) {
			clearPolling(ctx);
			return;
		}

		if (isActive) void refreshQuota(ctx, generation, true);
		else startPolling(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (ctx.mode === "tui" && isActive) void refreshQuota(ctx, generation);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearPolling(ctx);
	});
}
