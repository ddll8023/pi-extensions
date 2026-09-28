# Pi Agent 插件安装清单

用于在其他电脑上安装当前 Pi Agent 配置中的 6 个插件包。

## 安装前提

- 已安装 Pi Agent，并且终端可以执行 `pi`。
- 建议使用 Node.js 20 或更高版本。
- 默认安装到当前用户的全局 Pi 配置；需要网络访问 npm/GitHub。

## 一键安装

以下命令按当前已安装版本执行：

```bash
pi install npm:pi-mcp-adapter@2.35.0
pi install npm:pi-web-access@0.30.0
pi install npm:@juicesharp/rpiv-ask-user-question@2.10.1
pi install npm:@ff-labs/pi-fff@0.11.0
pi install npm:@tunnckocore/pi-gpt-fast-mode@0.4.0
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
| [ ] | `ddll8023/pi-extensions` | Git 仓库 | 个人扩展集合 | `pi install git:github.com/ddll8023/pi-extensions` |

## Git 扩展包包含的插件

`ddll8023/pi-extensions` 会加载以下扩展：

- `codex-usage`：命令 `/codex-usage`
- `settings-zh`：命令 `/settings-zh`
- `permission-mode`：命令 `/permission-mode`
- `token-rate`：显示 Token 生成速率
- `status-footer`：自定义底部状态栏
- `web-gpt-planner`：文本优先的 ChatGPT 网页规划协作，命令 `/sol-plan`、`/sol-status`、`/sol-resume`、`/sol-stop`；V1 不自动上传附件；通过固定 CDP 端口（`127.0.0.1:9222`，可用 `WEB_GPT_PLANNER_EDGE_PORT` 覆盖）直连**专用 Edge 实例**，标签页按需新建/复用，停止时关闭自建标签页；不依赖 `edge://inspect` 人工授权

## 安装后验证

```bash
pi list
```

应能看到以上 6 个包。若 Pi 已经在运行，安装完成后执行：

```text
/reload
```

也可以直接退出并重新启动 Pi。

## 安装到项目本地（可选）

默认命令安装到全局配置。如果只希望当前项目使用，将每条命令增加 `-l`：

```bash
pi install -l npm:pi-mcp-adapter@2.35.0
```

## 版本说明

- npm 插件已按当前电脑上的版本固定，便于复现。
- Git 插件当前配置未指定 tag 或 commit，因此安装时使用仓库当前默认版本；如需完全可复现，应改为带 tag 或 commit 的 Git 地址。
