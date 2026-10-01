# Pi Agent 插件安装清单

用于在其他电脑上安装当前 Pi Agent 配置中的 8 个插件包。

## 安装前提

- 已安装 Pi Agent，并且终端可以执行 `pi`。
- 建议使用 Node.js 22.19.0 或更高版本，匹配当前 Pi Agent 0.99.2 的运行要求。
- 默认安装到当前用户的全局 Pi 配置；需要网络访问 npm/GitHub。

## 一键安装

以下命令按当前已安装版本执行：

```bash
pi install npm:pi-mcp-adapter@2.35.0
pi install npm:pi-web-access@0.30.0
pi install npm:@juicesharp/rpiv-ask-user-question@2.10.1
pi install npm:@ff-labs/pi-fff@0.11.0
pi install npm:@tunnckocore/pi-gpt-fast-mode@0.4.0
pi install npm:pi-gui-extension@0.4.1
pi install npm:mellos-mapping@0.27.1
pi install git:github.com/ddll8023/pi-extensions
```

## 插件清单

| 状态 | 插件包 | 版本 | 功能概述 | 安装指令 |
|---|---|---:|---|---|
| [ ] | `pi-mcp-adapter` | `2.35.0` | MCP（Model Context Protocol）服务适配 | `pi install npm:pi-mcp-adapter@2.35.0` |
| [ ] | `pi-web-access` | `0.30.0` | 网页搜索、网页/PDF/GitHub/视频访问 | `pi install npm:pi-web-access@0.30.0` |
| [ ] | `@juicesharp/rpiv-ask-user-question` | `2.10.1` | 结构化询问用户 | `pi install npm:@juicesharp/rpiv-ask-user-question@2.10.1` |
| [ ] | `@ff-labs/pi-fff` | `0.11.0` | 模糊文件与内容搜索 | `pi install npm:@ff-labs/pi-fff@0.11.0` |
| [ ] | `@tunnckocore/pi-gpt-fast-mode` | `0.4.0` | 通过 `/fast` 切换 GPT 快速模式 | `pi install npm:@tunnckocore/pi-gpt-fast-mode@0.4.0` |
| [ ] | `pi-gui-extension` | `0.4.1` | 本机多会话网页界面扩展，非独立工具 pigui | `pi install npm:pi-gui-extension@0.4.1` |
| [ ] | `mellos-mapping` | `0.27.1` | 实时分层依赖地图、开发进度与验证证据；包含建图工具、技能和 `/mmap` 提示模板 | `pi install npm:mellos-mapping@0.27.1` |
| [ ] | `ddll8023/pi-extensions` | Git 仓库 | 个人扩展集合 | `pi install git:github.com/ddll8023/pi-extensions` |

## Git 扩展包包含的插件

`ddll8023/pi-extensions` 会加载以下扩展：

- `codex-usage`：命令 `/codex-usage`
- `settings-zh`：命令 `/settings-zh`
- `permission-mode`：命令 `/permission-mode`
- `token-rate`：显示 Token 生成速率
- `status-footer`：自定义底部状态栏

## 安装后验证

```bash
pi list
```

应能看到以上 8 个包。若 Pi 已经在运行，安装完成后执行：

```text
/reload
```

也可以直接退出并重新启动 Pi。

## Mellos 首次配置

安装 `mellos-mapping` 后，建议退出并重新启动 Pi，再开始新会话；在 pigui 中使用时，重启 pigui 服务。包内的 Pi 扩展负责加载建图工具，技能和 `/mmap` 提示模板负责引导建图。

用户级和项目级策略都未设置时，首次使用会询问默认建图策略，由用户选择：

| 策略 | 含义 |
|---|---|
| `always` | 所有结构化任务均维护地图，包括流程、设计、架构和技术依赖 |
| `complex` | 仅中等或复杂任务维护地图，如多个模块、新子系统或较大重构 |
| `on-request` | 仅在用户明确要求时创建地图 |

- 默认由助手调用 `mmap_setup {policy: "用户所选策略", scope: "user"}` 保存到 `~/.mellos/config.json`，适用于用户打开的所有项目；已有选择后不应每个项目重复询问。
- 本机当前用户级策略为 `always`。在新电脑上仍应由用户选择，不自动代填策略。
- 某个项目需要不同策略时，使用 `scope: "project"` 保存到项目的 `.mellos/config.json`，项目策略优先于用户策略；需要重新选择时可输入 `/mmap setup`。
- 地图数据保存在工作目录的 `.mellos/map.json` 或 `.mellos/pages/<页名>.json`，由 AI 调用建图工具声明设计并更新进度，不是从聊天记录自动生成。
- 代码已写好但未验证时应保持 `in-progress`；只有实际验证通过并记录真实证据后才标记 `done`。建图策略不替代文件修改或测试的审批要求。

## 安装到项目本地（可选）

默认命令安装到全局配置。如果只希望当前项目使用，将每条命令增加 `-l`：

```bash
pi install -l npm:pi-mcp-adapter@2.35.0
```

## 版本说明

- npm 插件已按当前电脑上的版本固定，便于复现。
- Git 插件当前配置未指定 tag 或 commit，因此安装时使用仓库当前默认版本；如需完全可复现，应改为带 tag 或 commit 的 Git 地址。
