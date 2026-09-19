import {
	CONFIG_DIR_NAME,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const CONFIG_FILE_NAME = "status-footer.json";
const DEFAULT_STATUS_ORDER = ["codex-usage", "permission-mode", "openviking", "token-rate"];
const DEFAULT_HIDDEN_STATUS_KEYS: string[] = [];

const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

type StatusFooterConfig = {
	statusRows: 1 | 2;
	hideMcp: boolean;
	hiddenStatusKeys: string[];
	order: string[];
	showIdleTokenRate: boolean;
};

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type StatusItem = {
	key: string;
	text: string;
};

const DEFAULT_CONFIG: StatusFooterConfig = {
	statusRows: 2,
	hideMcp: true,
	hiddenStatusKeys: DEFAULT_HIDDEN_STATUS_KEYS,
	order: DEFAULT_STATUS_ORDER,
	showIdleTokenRate: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function sanitizeStatusText(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function createUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageToTotals(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function collectUsage(ctx: ExtensionContext): { totals: UsageTotals; latestCacheHitRate?: number } {
	const totals = createUsageTotals();
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addUsageToTotals(totals, entry.message.usage);
			const latestPromptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
			latestCacheHitRate = latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			addUsageToTotals(totals, entry.message.usage);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addUsageToTotals(totals, entry.usage);
		}
	}

	return { totals, latestCacheHitRate };
}

function readAutoCompactEnabled(ctx: ExtensionContext): boolean {
	try {
		const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		return settings.getCompactionEnabled();
	} catch {
		return true;
	}
}

function readConfigFile(path: string): Partial<StatusFooterConfig> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(value)) return undefined;

		const config: Partial<StatusFooterConfig> = {};
		if (value.statusRows === 1 || value.statusRows === 2) config.statusRows = value.statusRows;
		if (typeof value.hideMcp === "boolean") config.hideMcp = value.hideMcp;
		if (typeof value.showIdleTokenRate === "boolean") config.showIdleTokenRate = value.showIdleTokenRate;
		if (Array.isArray(value.hiddenStatusKeys)) {
			config.hiddenStatusKeys = value.hiddenStatusKeys.filter((item): item is string => typeof item === "string");
		}
		if (Array.isArray(value.order)) {
			config.order = value.order.filter((item): item is string => typeof item === "string");
		}
		return config;
	} catch {
		return undefined;
	}
}

function loadConfig(ctx: ExtensionContext): StatusFooterConfig {
	const config: StatusFooterConfig = {
		...DEFAULT_CONFIG,
		hiddenStatusKeys: [...DEFAULT_CONFIG.hiddenStatusKeys],
		order: [...DEFAULT_CONFIG.order],
	};
	const paths = [join(getAgentDir(), CONFIG_FILE_NAME)];
	if (ctx.isProjectTrusted()) paths.push(join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME));

	for (const path of paths) {
		const parsed = readConfigFile(path);
		if (!parsed) continue;
		if (parsed.statusRows !== undefined) config.statusRows = parsed.statusRows;
		if (parsed.hideMcp !== undefined) config.hideMcp = parsed.hideMcp;
		if (parsed.showIdleTokenRate !== undefined) config.showIdleTokenRate = parsed.showIdleTokenRate;
		if (parsed.hiddenStatusKeys !== undefined) config.hiddenStatusKeys = parsed.hiddenStatusKeys;
		if (parsed.order !== undefined) config.order = parsed.order;
	}

	return config;
}

function compactResetToken(token: string): string {
	if (token === "重置时间未知") return "↻?";
	if (token === "即将重置") return "↻即将";

	return `↻${token
		.replace(/后重置$/, "")
		.replaceAll("小时", "时")
		.replaceAll("分钟", "分")}`;
}

function compactCodexStatus(text: string): string {
	const windows: string[] = [];
	const pattern = /(\d+(?:周|天|小时|分钟|秒))剩(\d+)%\s+(\S+)/g;
	for (const match of text.matchAll(pattern)) {
		windows.push(`${match[1]}${match[2]}%${compactResetToken(match[3])}`);
	}

	if (windows.length === 0) return text.replace(/^Codex(?:额度)?[：:]?\s*/, "Codex ");
	const balance = text.match(/余额\s*\S+/)?.[0];
	return `Codex ${windows.join(" ")}${balance ? ` ${balance}` : ""}`;
}

function compactOpenVikingStatus(text: string): string {
	const state = text.includes("✗") ? "OV✗" : text.includes("✓") ? "OV✓" : "OV";
	const context = text.match(/\bctx\s+(\d+)/)?.[1];
	const budget = text.match(/~\s*\d+\s*\/\s*(\d+)/)?.[1];
	if (context && budget) return `${state} ctx${context}/${formatTokens(Number(budget))}`;

	const added = text.match(/↩\s*(\d+)/)?.[1];
	return added ? `${state} ↩${added}` : state;
}

function compactTokenRateStatus(text: string): string {
	const values = [...text.matchAll(/(实时|平均|实|均)\s*[：:]?\s*(≈?\d+(?:\.\d+)?)\s*(?:tok\/s|\/s)/g)];
	if (values.length === 0) return text.includes("读取") ? "速率…" : text;

	const parts = values.map((match) => `${match[1] === "实时" || match[1] === "实" ? "实" : "均"}${match[2]}/s`);
	return `速率 ${parts.join(" ")}`;
}

function isTokenRateActive(text: string): boolean {
	return /(?:实时|实)\s*[：:]?\s*≈?\d/.test(text);
}

function compactStatus(key: string, text: string): string {
	switch (key.toLowerCase()) {
		case "codex-usage":
			return compactCodexStatus(text);
		case "permission-mode":
			if (text.includes("No edit")) return text.includes("哨兵关闭") ? "权限 No edit!" : "权限 No edit";
			if (text.includes("自动")) return "权限 自动";
			return text;
		case "openviking":
			return compactOpenVikingStatus(text);
		case "token-rate":
			return compactTokenRateStatus(text);
		default:
			return text;
	}
}

function isHiddenStatus(key: string, text: string, config: StatusFooterConfig): boolean {
	const normalizedKey = key.toLowerCase();
	if (config.hiddenStatusKeys.some((item) => item.toLowerCase() === normalizedKey)) return true;
	if (config.hideMcp && (normalizedKey === "mcp" || /^MCP(?:[:：]|\s)/i.test(text))) return true;
	if (normalizedKey === "token-rate" && !config.showIdleTokenRate && !isTokenRateActive(text)) return true;
	return false;
}

function statusRowFor(key: string, rowCount: number): number | undefined {
	if (rowCount < 2) return 0;
	if (key === "codex-usage" || key === "permission-mode") return 0;
	if (key === "openviking" || key === "token-rate") return 1;
	return undefined;
}

function statusOrder(key: string, config: StatusFooterConfig): number {
	const index = config.order.findIndex((item) => item.toLowerCase() === key.toLowerCase());
	return index >= 0 ? index : config.order.length + 1;
}

function statusColor(theme: Theme, key: string, text: string): string {
	if (key === "permission-mode" && text.includes("No edit")) return theme.fg("warning", text);
	if (key === "openviking" && text.includes("✗")) return theme.fg("error", text);
	if (key === "codex-usage") {
		const percentages = [...text.matchAll(/(\d+)%/g)].map((match) => Number(match[1]));
		if (percentages.some((value) => value <= 0)) return theme.fg("error", text);
		if (percentages.some((value) => value <= 20)) return theme.fg("warning", text);
	}
	return theme.fg("accent", text);
}

function collectStatusItems(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	config: StatusFooterConfig,
): StatusItem[][] {
	const items = Array.from(footerData.getExtensionStatuses().entries())
		.map(([key, rawText]) => ({ key, plainText: sanitizeStatusText(rawText) }))
		.filter(({ key, plainText }) => plainText.length > 0 && !isHiddenStatus(key, plainText, config))
		.sort((left, right) => statusOrder(left.key, config) - statusOrder(right.key, config) || left.key.localeCompare(right.key))
		.map(({ key, plainText }) => ({ key, text: statusColor(theme, key, compactStatus(key, plainText)) }));

	const rows: StatusItem[][] = Array.from({ length: config.statusRows }, () => []);
	for (const item of items) {
		const preferredRow = statusRowFor(item.key, config.statusRows);
		if (preferredRow !== undefined) {
			rows[preferredRow]?.push(item);
			continue;
		}

		let targetRow = 0;
		let shortestWidth = Number.POSITIVE_INFINITY;
		for (let index = 0; index < rows.length; index += 1) {
			const rowWidth = rows[index].reduce((sum, rowItem) => sum + visibleWidth(rowItem.text) + 3, 0);
			if (rowWidth < shortestWidth) {
				shortestWidth = rowWidth;
				targetRow = index;
			}
		}
		rows[targetRow].push(item);
	}

	return rows;
}

function renderStatusRow(items: StatusItem[], width: number): string {
	let line = "";
	let renderedItems = 0;
	for (const item of items) {
		const separator = line ? " · " : "";
		const available = width - visibleWidth(line) - visibleWidth(separator);
		if (available <= 0) break;

		const text = visibleWidth(item.text) > available ? truncateToWidth(item.text, available, "…") : item.text;
		if (!text) break;
		line += separator + text;
		renderedItems += 1;
	}

	const omitted = items.length - renderedItems;
	if (omitted > 0 && line) {
		const suffix = ` · +${omitted}`;
		if (visibleWidth(line) + visibleWidth(suffix) <= width) line += suffix;
	}
	return line;
}

function renderBaseFooter(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
	autoCompactEnabled: boolean,
): string[] {
	const { totals, latestCacheHitRate } = collectUsage(ctx);
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const hasContextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = hasContextPercent ? contextPercentValue.toFixed(1) : "?";

	let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
	const branch = footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd = `${pwd} • ${sessionName}`;

	const statsParts: string[] = [];
	if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

	const autoIndicator = autoCompactEnabled ? " (auto)" : "";
	const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
	const contextColor = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : undefined;
	statsParts.push(contextColor ? theme.fg(contextColor, contextPercentDisplay) : contextPercentDisplay);

	let statsLeft = statsParts.join(" ");
	if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "...");

	const modelName = ctx.model?.id || "no-model";
	let rightSide = modelName;
	if (ctx.model?.reasoning) {
		const thinkingLevel = ctx.thinkingLevel || "off";
		rightSide = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		const withProvider = `(${ctx.model.provider}) ${rightSide}`;
		if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
	}

	const availableForRight = width - visibleWidth(statsLeft) - 2;
	let statsLine = statsLeft;
	if (availableForRight > 0) {
		const right = truncateToWidth(rightSide, availableForRight, "");
		const padding = " ".repeat(Math.max(2, width - visibleWidth(statsLeft) - visibleWidth(right)));
		statsLine += padding + right;
	}

	return [
		truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
		theme.fg("dim", statsLine),
	];
}

function renderFooter(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	config: StatusFooterConfig,
	autoCompactEnabled: boolean,
	width: number,
): string[] {
	const lines = renderBaseFooter(ctx, theme, footerData, width, autoCompactEnabled);
	const statusRows = collectStatusItems(theme, footerData, config)
		.map((items) => renderStatusRow(items, width))
		.filter((line) => line.length > 0);
	return [...lines, ...statusRows];
}

export default function statusFooterExtension(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;

	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		activeContext = ctx;
		const config = loadConfig(ctx);
		const autoCompactEnabled = readAutoCompactEnabled(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					return renderFooter(activeContext ?? ctx, theme, footerData, config, autoCompactEnabled, width);
				},
			};
		});
	}

	pi.registerCommand("status-footer", {
		description: "查看并重新加载插件状态栏布局",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/status-footer 仅支持交互式 TUI 模式", "error");
				return;
			}

			const config = loadConfig(ctx);
			if (args.trim().toLowerCase() === "reload") {
				installFooter(ctx);
				ctx.ui.notify("已重新加载状态栏布局配置。", "info");
				return;
			}

			ctx.ui.notify(
				`插件状态栏：最多 ${config.statusRows} 行\nMCP：${config.hideMcp ? "隐藏" : "显示"}\n空闲 Token 速率：${config.showIdleTokenRate ? "显示" : "隐藏"}\n修改配置后执行 /status-footer reload。`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		activeContext = ctx;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		if (activeContext === ctx) activeContext = undefined;
	});
}
