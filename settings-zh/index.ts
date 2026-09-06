import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	Container,
	SelectList,
	SettingsList,
	Spacer,
	Text,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type SettingItem,
	type SettingsListTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

type Choice = {
	value: string;
	label: string;
	description?: string;
};

type ChangeHandler = (value: string) => void;

const AUTO_THEME_VALUE = "__automatic__";

function settingsListTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => {
			const translations: Record<string, string> = {
				"  Type to search · Enter/Space to change · Esc to cancel": "  输入搜索 · 回车/空格修改 · Esc 取消",
				"  Enter/Space to change · Esc to cancel": "  回车/空格修改 · Esc 取消",
				"  No settings available": "  没有可用设置",
				"  No matching settings": "  没有匹配的设置",
			};
			return theme.fg("dim", translations[text] ?? text);
		},
	};
}

function selectListTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

function createSelectSubmenu(
	tui: { requestRender(): void },
	theme: Theme,
	title: string,
	description: string,
	choices: Choice[],
	currentValue: string,
	done: (value?: string) => void,
): Component {
	const container = new Container();
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", description), 0, 0));
	container.addChild(new Spacer(1));

	const listItems: SelectItem[] = choices.map((choice) => ({
		value: choice.value,
		label: choice.label,
		description: choice.description,
	}));
	const list = new SelectList(listItems, Math.min(listItems.length, 10), selectListTheme(theme));
	const selectedIndex = listItems.findIndex((item) => item.value === currentValue);
	if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
	list.onSelect = (item) => done(choices.find((choice) => choice.value === item.value)?.label ?? item.label);
	list.onCancel = () => done();
	container.addChild(list);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", "  回车选择 · Esc 返回"), 0, 0));

	return {
		render: (width) => container.render(width),
		handleInput: (data) => {
			list.handleInput(data);
			tui.requestRender();
		},
		handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
			const result = list.handleMouse?.(event);
			if (result?.render) tui.requestRender();
			return result;
		},
		invalidate: () => container.invalidate(),
	};
}

function addChoiceSetting(
	items: SettingItem[],
	handlers: Map<string, ChangeHandler>,
	config: {
		id: string;
		label: string;
		description: string;
		getValue: () => string;
		setValue: (value: string) => void;
		choices: Choice[];
	},
): void {
	const currentValue = config.getValue();
	const currentChoice = config.choices.find((choice) => choice.value === currentValue);
	const labels = config.choices.map((choice) => choice.label);

	items.push({
		id: config.id,
		label: config.label,
		description: config.description,
		currentValue: currentChoice?.label ?? currentValue,
		values: labels,
	});

	handlers.set(config.id, (label) => {
		const choice = config.choices.find((item) => item.label === label);
		if (choice) config.setValue(choice.value);
	});
}

function addBooleanSetting(
	items: SettingItem[],
	handlers: Map<string, ChangeHandler>,
	config: {
		id: string;
		label: string;
		description: string;
		getValue: () => boolean;
		setValue: (value: boolean) => void;
	},
): void {
	addChoiceSetting(items, handlers, {
		id: config.id,
		label: config.label,
		description: config.description,
		getValue: () => (config.getValue() ? "true" : "false"),
		setValue: (value) => config.setValue(value === "true"),
		choices: [
			{ value: "true", label: "开启" },
			{ value: "false", label: "关闭" },
		],
	});
}

function timeoutLabel(timeoutMs: number): string {
	if (timeoutMs === 0) return "不限制";
	if (timeoutMs % 60000 === 0) return `${timeoutMs / 60000} 分钟`;
	return `${timeoutMs / 1000} 秒`;
}

function themeDisplayValue(themeSetting: string): string {
	return themeSetting.includes("/") ? "自动（跟随终端明暗）" : themeSetting;
}

function automaticThemeSetting(current: string): string {
	if (current.includes("/")) return current;
	return `${current}/${current}`;
}

export default function settingsZhExtension(pi: ExtensionAPI): void {
	pi.registerCommand("settings-zh", {
		description: "打开中文设置菜单",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/settings-zh 仅支持交互式 TUI 模式", "error");
				return;
			}

			const settings = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const loadErrors = settings.drainErrors();
			if (loadErrors.length > 0) {
				ctx.ui.notify(
					`读取设置失败：${loadErrors.map((item) => `${item.scope} - ${item.error.message}`).join("；")}`,
					"error",
				);
				return;
			}

			const items: SettingItem[] = [];
			const handlers = new Map<string, ChangeHandler>();
			let changed = false;

			addBooleanSetting(items, handlers, {
				id: "autocompact",
				label: "自动压缩上下文",
				description: "上下文过大时自动压缩历史消息",
				getValue: () => settings.getCompactionEnabled(),
				setValue: (value) => settings.setCompactionEnabled(value),
			});
			addBooleanSetting(items, handlers, {
				id: "show-images",
				label: "显示图片",
				description: "在终端中内联显示图片（终端支持时生效）",
				getValue: () => settings.getShowImages(),
				setValue: (value) => settings.setShowImages(value),
			});
			addChoiceSetting(items, handlers, {
				id: "image-width",
				label: "图片宽度",
				description: "终端内联图片的首选宽度（字符数）",
				getValue: () => String(settings.getImageWidthCells()),
				setValue: (value) => settings.setImageWidthCells(Number(value)),
				choices: ["60", "80", "120"].map((value) => ({ value, label: `${value} 列` })),
			});
			addBooleanSetting(items, handlers, {
				id: "auto-resize-images",
				label: "自动调整图片大小",
				description: "将大图片缩放到最大 2000×2000，以提高模型兼容性",
				getValue: () => settings.getImageAutoResize(),
				setValue: (value) => settings.setImageAutoResize(value),
			});
			addBooleanSetting(items, handlers, {
				id: "block-images",
				label: "禁止发送图片",
				description: "阻止将图片发送给模型服务商",
				getValue: () => settings.getBlockImages(),
				setValue: (value) => settings.setBlockImages(value),
			});
			addBooleanSetting(items, handlers, {
				id: "skill-commands",
				label: "技能命令",
				description: "将技能注册为 /skill:name 命令",
				getValue: () => settings.getEnableSkillCommands(),
				setValue: (value) => settings.setEnableSkillCommands(value),
			});
			addChoiceSetting(items, handlers, {
				id: "steering-mode",
				label: "引导消息模式",
				description: "模型生成过程中按回车发送引导消息时的投递方式",
				getValue: () => settings.getSteeringMode(),
				setValue: (value) => settings.setSteeringMode(value as "all" | "one-at-a-time"),
				choices: [
					{ value: "one-at-a-time", label: "逐条发送" },
					{ value: "all", label: "一次全部发送" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "follow-up-mode",
				label: "后续消息模式",
				description: "模型完成当前任务后发送排队消息时的投递方式",
				getValue: () => settings.getFollowUpMode(),
				setValue: (value) => settings.setFollowUpMode(value as "all" | "one-at-a-time"),
				choices: [
					{ value: "one-at-a-time", label: "逐条发送" },
					{ value: "all", label: "一次全部发送" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "transport",
				label: "网络传输方式",
				description: "支持多种传输方式的服务商所使用的优先传输方式",
				getValue: () => settings.getTransport(),
				setValue: (value) => settings.setTransport(value as "sse" | "websocket" | "websocket-cached" | "auto"),
				choices: [
					{ value: "auto", label: "自动" },
					{ value: "sse", label: "SSE" },
					{ value: "websocket", label: "WebSocket" },
					{ value: "websocket-cached", label: "WebSocket（缓存）" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "http-idle-timeout",
				label: "HTTP 空闲超时",
				description: "等待 HTTP 响应或数据块时允许的最大空闲间隔",
				getValue: () => String(settings.getHttpIdleTimeoutMs()),
				setValue: (value) => settings.setHttpIdleTimeoutMs(Number(value)),
				choices: [0, 30000, 60000, 300000, 600000, 1800000].map((value) => ({
					value: String(value),
					label: timeoutLabel(value),
				})),
			});
			addBooleanSetting(items, handlers, {
				id: "hide-thinking",
				label: "隐藏思考过程",
				description: "隐藏助手回复中的思考内容",
				getValue: () => settings.getHideThinkingBlock(),
				setValue: (value) => settings.setHideThinkingBlock(value),
			});
			addChoiceSetting(items, handlers, {
				id: "mermaid-rendering",
				label: "Mermaid 图表",
				description: "Mermaid 代码块的渲染方式",
				getValue: () => settings.getMermaidRenderingMode(),
				setValue: (value) => settings.setMermaidRenderingMode(value as "off" | "final" | "streaming"),
				choices: [
					{ value: "streaming", label: "实时渲染" },
					{ value: "final", label: "完成后渲染" },
					{ value: "off", label: "关闭" },
				],
			});
			addBooleanSetting(items, handlers, {
				id: "cache-miss-notices",
				label: "缓存未命中提示",
				description: "显示提示词缓存成本、压缩和服务商恢复诊断信息",
				getValue: () => settings.getShowCacheMissNotices(),
				setValue: (value) => settings.setShowCacheMissNotices(value),
			});
			addBooleanSetting(items, handlers, {
				id: "collapse-changelog",
				label: "折叠更新日志",
				description: "更新后以精简形式显示更新日志",
				getValue: () => settings.getCollapseChangelog(),
				setValue: (value) => settings.setCollapseChangelog(value),
			});
			addBooleanSetting(items, handlers, {
				id: "quiet-startup",
				label: "安静启动",
				description: "隐藏启动时的详细输出",
				getValue: () => settings.getQuietStartup(),
				setValue: (value) => settings.setQuietStartup(value),
			});
			addBooleanSetting(items, handlers, {
				id: "install-telemetry",
				label: "安装遥测",
				description: "更新后发送匿名版本/更新统计",
				getValue: () => settings.getEnableInstallTelemetry(),
				setValue: (value) => settings.setEnableInstallTelemetry(value),
			});
			addChoiceSetting(items, handlers, {
				id: "default-project-trust",
				label: "项目默认信任",
				description: "没有扩展或已保存决定时的项目资源信任策略",
				getValue: () => settings.getDefaultProjectTrust(),
				setValue: (value) => settings.setDefaultProjectTrust(value as "ask" | "always" | "never"),
				choices: [
					{ value: "ask", label: "每次询问" },
					{ value: "always", label: "始终信任" },
					{ value: "never", label: "始终不信任" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "double-escape-action",
				label: "双击 Esc 操作",
				description: "编辑器为空时连续按两次 Esc 的操作",
				getValue: () => settings.getDoubleEscapeAction(),
				setValue: (value) => settings.setDoubleEscapeAction(value as "tree" | "fork" | "none"),
				choices: [
					{ value: "tree", label: "打开会话树" },
					{ value: "fork", label: "打开分支选择" },
					{ value: "none", label: "不操作" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "tree-filter-mode",
				label: "会话树筛选模式",
				description: "打开会话树时使用的默认筛选方式",
				getValue: () => settings.getTreeFilterMode(),
				setValue: (value) => settings.setTreeFilterMode(value as "default" | "no-tools" | "user-only" | "labeled-only" | "all"),
				choices: [
					{ value: "default", label: "默认" },
					{ value: "no-tools", label: "隐藏工具调用" },
					{ value: "user-only", label: "仅用户消息" },
					{ value: "labeled-only", label: "仅已标记消息" },
					{ value: "all", label: "全部" },
				],
			});
			addBooleanSetting(items, handlers, {
				id: "show-hardware-cursor",
				label: "显示硬件光标",
				description: "为中文输入法定位显示终端光标",
				getValue: () => settings.getShowHardwareCursor(),
				setValue: (value) => settings.setShowHardwareCursor(value),
			});
			addChoiceSetting(items, handlers, {
				id: "editor-padding",
				label: "编辑器左右边距",
				description: "输入编辑器的水平边距（0-3）",
				getValue: () => String(settings.getEditorPaddingX()),
				setValue: (value) => settings.setEditorPaddingX(Number(value)),
				choices: [0, 1, 2, 3].map((value) => ({ value: String(value), label: `${value}` })),
			});
			addChoiceSetting(items, handlers, {
				id: "output-padding",
				label: "输出左右边距",
				description: "用户消息、助手消息和思考内容的水平边距",
				getValue: () => String(settings.getOutputPad()),
				setValue: (value) => settings.setOutputPad(value === "0" ? 0 : 1),
				choices: [
					{ value: "0", label: "0" },
					{ value: "1", label: "1" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "autocomplete-max-visible",
				label: "补全最大显示数",
				description: "自动补全下拉列表最多显示的项目数（3-20）",
				getValue: () => String(settings.getAutocompleteMaxVisible()),
				setValue: (value) => settings.setAutocompleteMaxVisible(Number(value)),
				choices: [3, 5, 7, 10, 15, 20].map((value) => ({ value: String(value), label: `${value}` })),
			});
			addBooleanSetting(items, handlers, {
				id: "clear-on-shrink",
				label: "内容缩小时清屏",
				description: "内容变少时清除空行（可能产生闪烁）",
				getValue: () => settings.getClearOnShrink(),
				setValue: (value) => settings.setClearOnShrink(value),
			});
			addBooleanSetting(items, handlers, {
				id: "terminal-progress",
				label: "终端进度指示器",
				description: "在终端标签栏显示 OSC 9;4 进度指示器",
				getValue: () => settings.getShowTerminalProgress(),
				setValue: (value) => settings.setShowTerminalProgress(value),
			});
			addChoiceSetting(items, handlers, {
				id: "tui-mode",
				label: "界面模式",
				description: "终端界面布局；全屏模式目前是实验性功能",
				getValue: () => settings.getTuiMode(),
				setValue: (value) => settings.setTuiMode(value as "regular" | "fullscreen"),
				choices: [
					{ value: "regular", label: "普通模式" },
					{ value: "fullscreen", label: "全屏模式" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "fullscreen-exit-output",
				label: "退出全屏后的输出",
				description: "退出全屏模式时打印完整记录，或只显示恢复提示",
				getValue: () => settings.getFullscreenExitOutput(),
				setValue: (value) => settings.setFullscreenExitOutput(value as "transcript" | "resume-hint"),
				choices: [
					{ value: "transcript", label: "完整会话记录" },
					{ value: "resume-hint", label: "仅恢复提示" },
				],
			});
			addChoiceSetting(items, handlers, {
				id: "fullscreen-scrollbar",
				label: "全屏滚动条",
				description: "全屏模式下滚动条的显示方式",
				getValue: () => settings.getFullscreenScrollbar(),
				setValue: (value) => settings.setFullscreenScrollbar(value as "auto" | "always" | "hidden"),
				choices: [
					{ value: "auto", label: "自动" },
					{ value: "always", label: "始终显示" },
					{ value: "hidden", label: "隐藏" },
				],
			});
			addBooleanSetting(items, handlers, {
				id: "fullscreen-copy-on-select",
				label: "全屏选中后自动复制",
				description: "全屏模式下选中文字后自动复制；关闭后使用 Ctrl+X 复制",
				getValue: () => settings.getFullscreenCopyOnSelect(),
				setValue: (value) => settings.setFullscreenCopyOnSelect(value),
			});
			addBooleanSetting(items, handlers, {
				id: "anthropic-extra-usage-warning",
				label: "Anthropic 额外用量提醒",
				description: "Anthropic 订阅认证可能产生额外付费用量时显示提醒",
				getValue: () => settings.getWarnings().anthropicExtraUsage ?? true,
				setValue: (value) => settings.setWarnings({
					...settings.getWarnings(),
					anthropicExtraUsage: value,
				}),
			});

			const themeSetting = settings.getThemeSetting() ?? "dark";
			const availableThemes = ctx.ui.getAllThemes().map((item) => item.name);
			const themeChoices: Choice[] = [
				{
					value: AUTO_THEME_VALUE,
					label: "自动（跟随终端明暗）",
					description: "根据终端的浅色/深色外观选择主题",
				},
				...availableThemes.map((name) => ({ value: name, label: name })),
			];
			let currentThemeValue = themeSetting.includes("/") ? AUTO_THEME_VALUE : themeSetting;

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				items.push({
					id: "theme",
					label: "界面主题",
					description: "选择 Pi 的颜色主题",
					currentValue: themeDisplayValue(themeSetting),
					submenu: (_currentValue, submenuDone) =>
						createSelectSubmenu(
							tui,
							theme,
							"界面主题",
							"请选择颜色主题",
							themeChoices,
							currentThemeValue,
							submenuDone,
						),
				});
				handlers.set("theme", (label) => {
					const choice = themeChoices.find((item) => item.label === label);
					if (!choice) return;
					const nextSetting = choice.value === AUTO_THEME_VALUE
						? automaticThemeSetting(settings.getThemeSetting() ?? "dark")
						: choice.value;
					currentThemeValue = choice.value;
					settings.setTheme(nextSetting);
				});

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("中文设置")), 1, 0));
				container.addChild(new Text(theme.fg("dim", "修改会写入全局配置；关闭菜单后自动重载。"), 1, 0));
				container.addChild(new Spacer(1));

				const settingsList = new SettingsList(
					items,
					12,
					settingsListTheme(theme),
					(id, value) => {
						const handler = handlers.get(id);
						if (!handler) return;
						changed = true;
						handler(value);
					},
					() => done(undefined),
					{ enableSearch: true },
				);
				container.addChild(settingsList);
				container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput(data);
						tui.requestRender();
					},
					handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
						const result = settingsList.handleMouse?.(event);
						if (result?.render) tui.requestRender();
						return result;
					},
				};
			});

			await settings.flush();
			const saveErrors = settings.drainErrors();
			if (saveErrors.length > 0) {
				ctx.ui.notify(
					`保存设置失败：${saveErrors.map((item) => `${item.scope} - ${item.error.message}`).join("；")}`,
					"error",
				);
				return;
			}
			if (changed) {
				await ctx.reload();
				return;
			}
		},
	});
}
