import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

type PermissionMode = "no-edit" | "auto";

interface PermissionModeState {
	mode: PermissionMode;
}

const STATE_ENTRY = "permission-mode-state";
const STATUS_KEY = "permission-mode";
const EDIT_TOOL = "edit";

const MODE_LABELS: Record<PermissionMode, string> = {
	"no-edit": "No edit（禁止 edit）",
	auto: "自动（全部工具）",
};

function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "no-edit" || value === "auto";
}

function parseMode(value: string): PermissionMode | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "no-edit" || normalized === "noedit" || normalized === "no_edit") {
		return "no-edit";
	}
	if (normalized === "auto" || normalized === "automatic" || normalized === "自动") {
		return "auto";
	}
	return undefined;
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

function allToolNames(pi: ExtensionAPI): string[] {
	return uniqueToolNames(pi.getAllTools().map((tool) => tool.name));
}

function savedMode(ctx: ExtensionContext): PermissionMode | undefined {
	let mode: PermissionMode | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;

		const data = entry.data;
		if (data && typeof data === "object" && isPermissionMode((data as PermissionModeState).mode)) {
			mode = (data as PermissionModeState).mode;
		}
	}

	return mode;
}

export default function permissionModeExtension(pi: ExtensionAPI): void {
	let mode: PermissionMode = "auto";

	function applyMode(): void {
		const availableTools = allToolNames(pi);
		const activeTools = mode === "no-edit" ? availableTools.filter((name) => name !== EDIT_TOOL) : availableTools;
		pi.setActiveTools(activeTools);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const color = mode === "no-edit" ? "warning" : "accent";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `权限：${MODE_LABELS[mode]}`));
	}

	function persistState(): void {
		pi.appendEntry<PermissionModeState>(STATE_ENTRY, { mode });
	}

	function setMode(nextMode: PermissionMode, ctx: ExtensionContext, notify = true): void {
		const changed = mode !== nextMode;
		mode = nextMode;
		applyMode();
		updateStatus(ctx);
		if (!changed || !notify) return;

		persistState();
		ctx.ui.notify(`已切换到${MODE_LABELS[mode]}`);
	}

	async function chooseMode(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("当前模式没有交互界面，请使用 /permission-mode no-edit 或 /permission-mode auto", "error");
			return;
		}

		const choice = await ctx.ui.select(`选择权限模式（当前：${MODE_LABELS[mode]}）`, [
			"No edit：禁止 edit 工具，其他工具全部允许",
			"自动：全部工具允许",
		]);

		if (choice?.startsWith("No edit")) {
			setMode("no-edit", ctx);
		} else if (choice?.startsWith("自动")) {
			setMode("auto", ctx);
		}
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const argument = args.trim();
		if (!argument) {
			await chooseMode(ctx);
			return;
		}

		if (argument.toLowerCase() === "status" || argument === "当前") {
			ctx.ui.notify(`当前权限模式：${MODE_LABELS[mode]}`);
			return;
		}

		const nextMode = parseMode(argument);
		if (!nextMode) {
			ctx.ui.notify("用法：/permission-mode [no-edit|auto]，或直接执行 /permission-mode 打开选择菜单", "error");
			return;
		}

		setMode(nextMode, ctx);
	}

	pi.registerCommand("permission-mode", {
		description: "切换 Pi 权限模式（no-edit / auto）",
		handler: handleCommand,
	});

	pi.registerShortcut(Key.f6, {
		description: "使用 F6 在 No edit 和自动模式之间切换",
		handler: async (ctx) => setMode(mode === "no-edit" ? "auto" : "no-edit", ctx),
	});

	pi.on("tool_call", async (event) => {
		if (mode !== "no-edit" || event.toolName !== EDIT_TOOL) return;

		return {
			block: true,
			reason: "No edit 模式已禁止 edit 工具。请使用 /permission-mode auto 恢复自动模式。",
		};
	});

	function restoreMode(ctx: ExtensionContext): void {
		mode = savedMode(ctx) ?? "auto";
		applyMode();
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreMode(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreMode(ctx);
	});
}
