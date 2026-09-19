import {
	getAgentDir,
	isBashToolResult,
	isPowerShellToolResult,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeShellCommand, readOnlyToolNames, type ReadOnlyPolicy, type ShellKind } from "./readonly.ts";
import { formatFinding, snapshotWorkspace, WorkspaceSentinel } from "./sentinel.ts";

type PermissionMode = "no-edit" | "auto";
type ModificationDecision = "once" | "session" | "deny";

interface PermissionModeState {
	mode: PermissionMode;
}

interface PermissionModeConfig {
	readOnlyTools?: string[];
	readOnlyCommands?: string[];
	rollbackOnChange?: boolean;
}

const STATE_ENTRY = "permission-mode-state";
const STATUS_KEY = "permission-mode";
const CONFIG_FILE_NAME = "permission-mode.json";
const DETAIL_LIMIT = 600;

const MODE_LABELS: Record<PermissionMode, string> = {
	"no-edit": "No edit（只读，修改前确认）",
	auto: "自动（全部工具，不确认）",
};

const STATUS_LABELS: Record<PermissionMode, string> = {
	"no-edit": "No edit",
	auto: "自动",
};

const MODE_CHOICES: Array<{ label: string; mode: PermissionMode }> = [
	{ label: "No edit：只读工具与只读命令直接放行，会修改内容的操作先询问你", mode: "no-edit" },
	{ label: "自动：全部操作直接执行，不再询问", mode: "auto" },
];

function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "no-edit" || value === "auto";
}

function parseMode(value: string): PermissionMode | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "no-edit" || normalized === "noedit" || normalized === "no_edit") return "no-edit";
	if (normalized === "auto" || normalized === "automatic" || normalized === "自动") return "auto";
	return undefined;
}

function truncate(text: string, limit = DETAIL_LIMIT): string {
	return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

/** 从全局与项目配置合并只读白名单扩展 */
function loadConfig(cwd: string): PermissionModeConfig {
	const merged: PermissionModeConfig = {};

	for (const path of [join(getAgentDir(), CONFIG_FILE_NAME), join(cwd, ".pi", CONFIG_FILE_NAME)]) {
		let parsed: PermissionModeConfig;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as PermissionModeConfig;
		} catch {
			continue;
		}
		if (Array.isArray(parsed.readOnlyTools)) {
			merged.readOnlyTools = [...(merged.readOnlyTools ?? []), ...parsed.readOnlyTools.filter((v) => typeof v === "string")];
		}
		if (Array.isArray(parsed.readOnlyCommands)) {
			merged.readOnlyCommands = [
				...(merged.readOnlyCommands ?? []),
				...parsed.readOnlyCommands.filter((v) => typeof v === "string").map((v) => v.toLowerCase()),
			];
		}
		if (typeof parsed.rollbackOnChange === "boolean") merged.rollbackOnChange = parsed.rollbackOnChange;
	}

	return merged;
}

/** 生成确认框里的操作摘要 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "edit" || toolName === "write") {
		const path = typeof input.path === "string" ? input.path : "(未知路径)";
		const count = Array.isArray(input.edits) ? `，${input.edits.length} 处替换` : "";
		const size = typeof input.content === "string" ? `，${input.content.length} 字符` : "";
		return `文件：${path}${count}${size}`;
	}

	try {
		return truncate(JSON.stringify(input, null, 2) ?? "");
	} catch {
		return "(无法序列化的参数)";
	}
}

export default function permissionModeExtension(pi: ExtensionAPI): void {
	let mode: PermissionMode = "auto";
	let policy: ReadOnlyPolicy = { extraTools: [], extraCommands: [] };
	let rollbackOnChange = true;

	/** 会话级授权：用户选择"本会话始终允许"后不再重复询问 */
	const sessionGrants = new Set<string>();
	const sentinel = new WorkspaceSentinel();
	const readOnlyTools = (): Set<string> => readOnlyToolNames(policy);
	const grantKey = (kind: "tool" | "command", name: string): string => `${kind}:${name}`;

	function updateStatus(ctx: ExtensionContext): void {
		const color = mode === "no-edit" ? "warning" : "accent";
		const label = mode === "no-edit" && !rollbackOnChange ? "No edit!" : STATUS_LABELS[mode];
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `权限 ${label}`));
	}

	function persistState(): void {
		pi.appendEntry<PermissionModeState>(STATE_ENTRY, { mode });
	}

	function savedMode(ctx: ExtensionContext): PermissionMode | undefined {
		let saved: PermissionMode | undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const data = entry.data;
			if (data && typeof data === "object" && isPermissionMode((data as PermissionModeState).mode)) {
				saved = (data as PermissionModeState).mode;
			}
		}

		return saved;
	}

	/** 询问用户是否允许这次修改 */
	async function confirmModification(
		ctx: ExtensionContext,
		title: string,
		detail: string,
	): Promise<ModificationDecision> {
		if (!ctx.hasUI) {
			ctx.ui.notify("No edit 模式下需要修改内容的操作被迫跳过：当前没有可确认的交互界面。", "warning");
			return "deny";
		}

		const choice = await ctx.ui.select(
			`${title}\n\n${detail}\n\n允许后本次修改不会被变更哨兵回滚。`,
			["允许一次", "本会话始终允许同类操作", "拒绝"],
			ctx.signal ? { signal: ctx.signal } : undefined,
		);

		if (choice === "允许一次") return "once";
		if (choice === "本会话始终允许同类操作") return "session";
		return "deny";
	}
	function setMode(nextMode: PermissionMode, ctx: ExtensionContext, notify = true): void {
		const changed = mode !== nextMode;
		mode = nextMode;
		updateStatus(ctx);
		if (!changed || !notify) return;

		persistState();
		ctx.ui.notify(`已切换到${MODE_LABELS[mode]}`);
	}

	/** 进入 No edit 模式时告知哨兵的实际可用性 */
	async function announceSentinelState(ctx: ExtensionContext): Promise<void> {
		if (!rollbackOnChange) {
			ctx.ui.notify("已进入 No edit 模式；变更哨兵在配置中关闭，只依赖静态判定。", "warning");
			return;
		}

		const snapshot = await snapshotWorkspace(ctx.cwd);
		if (!snapshot) {
			ctx.ui.notify("变更哨兵在当前位置不可用（不是 git 工作区或未安装 git），只能依赖静态判定。", "warning");
		}
	}

	async function chooseMode(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("当前模式没有交互界面，请使用 /permission-mode no-edit 或 /permission-mode auto", "error");
			return;
		}

		const choice = await ctx.ui.select(
			`选择权限模式（当前：${MODE_LABELS[mode]}）`,
			MODE_CHOICES.map((item) => item.label),
		);
		const matched = MODE_CHOICES.find((item) => item.label === choice);
		if (matched) setMode(matched.mode, ctx);
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const argument = args.trim();
		if (!argument) {
			await chooseMode(ctx);
			return;
		}

		if (argument.toLowerCase() === "status" || argument === "当前") {
			ctx.ui.notify(
				`当前权限模式：${MODE_LABELS[mode]}\n变更哨兵：${rollbackOnChange ? "启用（自动回滚）" : "关闭"}\n本会话授权：${sessionGrants.size} 项（切换会话或 /reload 后清空）`,
			);
			return;
		}

		const nextMode = parseMode(argument);
		if (!nextMode) {
			ctx.ui.notify("用法：/permission-mode [no-edit|auto|status]，或直接执行 /permission-mode 打开选择菜单", "error");
			return;
		}

		setMode(nextMode, ctx);
		if (mode === "no-edit") await announceSentinelState(ctx);
	}

	pi.registerCommand("permission-mode", {
		description: "切换 Pi 权限模式（no-edit 只读 + 修改确认 / auto 全部允许）",
		handler: handleCommand,
	});

	pi.registerShortcut(Key.f6, {
		description: "使用 F6 在 No edit 和自动模式之间切换",
		handler: async (ctx) => {
			setMode(mode === "no-edit" ? "auto" : "no-edit", ctx);
			if (mode === "no-edit") await announceSentinelState(ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode !== "no-edit") return undefined;

		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const shell: ShellKind = event.toolName === "bash" ? "bash" : "powershell";
			const command = typeof event.input.command === "string" ? event.input.command : "";
			const verdict = judgeShellCommand(command, shell, policy.extraCommands);

			if (verdict.allowed) {
				// 只读命令静默放行，但仍记录快照，命令意外写入时由哨兵回滚
				await sentinel.begin(event.toolCallId, ctx.cwd);
				return undefined;
			}

			const granted =
				verdict.commands.length > 0 &&
				verdict.commands.every((name) => sessionGrants.has(grantKey("command", name)));
			const decision = granted
				? "session"
				: await confirmModification(
						ctx,
						"No edit 模式：命令可能需要修改文件或系统",
						`命令：${truncate(command)}\n判定依据：${verdict.reason ?? "不在只读命令白名单内"}`,
					);

			if (decision === "deny") {
				return {
					block: true,
					reason: `已按 No edit 模式拒绝该命令（${verdict.reason ?? "不在只读命令白名单内"}）。\n命令：${command}\n如需执行请切换 /permission-mode auto。`,
				};
			}

			if (decision === "session") {
				for (const name of verdict.commands) sessionGrants.add(grantKey("command", name));
			}
			return undefined;
		}

		if (readOnlyTools().has(event.toolName)) return undefined;
		if (sessionGrants.has(grantKey("tool", event.toolName))) return undefined;

		const decision = await confirmModification(
			ctx,
			`No edit 模式：${event.toolName} 会修改内容`,
			summarizeToolInput(event.toolName, event.input as Record<string, unknown>),
		);

		if (decision === "deny") {
			return {
				block: true,
				reason: `已按 No edit 模式拒绝 ${event.toolName}。确认框里选择"允许一次"或"本会话始终允许同类操作"可通过，也可切换 /permission-mode auto。`,
			};
		}

		if (decision === "session") sessionGrants.add(grantKey("tool", event.toolName));
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (mode !== "no-edit") return undefined;
		if (!isBashToolResult(event) && !isPowerShellToolResult(event)) return undefined;

		const finding = await sentinel.finish(event.toolCallId, rollbackOnChange);
		if (!finding) return undefined;

		return {
			content: [...event.content, { type: "text", text: formatFinding(finding) }],
			isError: true,
		};
	});

	pi.on("turn_end", () => {
		sentinel.reset();
	});

	function restoreMode(ctx: ExtensionContext): void {
		const config = loadConfig(ctx.cwd);
		policy = { extraTools: config.readOnlyTools ?? [], extraCommands: config.readOnlyCommands ?? [] };
		rollbackOnChange = config.rollbackOnChange ?? true;
		sessionGrants.clear();
		mode = savedMode(ctx) ?? "auto";
		updateStatus(ctx);
		if (mode === "no-edit") void announceSentinelState(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreMode(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreMode(ctx);
	});
}
