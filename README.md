# PI extensions

用于保存后续开发的 Pi Agent 扩展。每个插件使用独立子目录。

## 当前插件

- `codex-usage/`：在底部状态栏显示 ChatGPT/Codex 账号剩余额度，命令为 `/codex-usage`。
- `settings-zh/`：中文设置菜单扩展，命令为 `/settings-zh`。
- `permission-mode/`：权限模式切换扩展，命令为 `/permission-mode`。
- `token-rate/`：在模型生成期间显示当前 AI 回复的 Token 生成速率。
- `status-footer/`：自定义底部 Footer，隐藏 MCP 状态，并将插件状态分成最多两行显示。
- `web-gpt-planner/`：文本优先的 ChatGPT 网页规划协作；命令 `/sol-plan`、`/sol-status`、`/sol-resume`、`/sol-stop`，V1 不自动上传附件。
  - 无需预先打开标签页：`/sol-plan` 会在专用 Edge 实例里复用或新建 ChatGPT 标签页，`/sol-stop` 关闭自建的那个（复用的不关）。
  - 不依赖 `edge://inspect` 人工授权：直连固定 CDP 端口 `http://127.0.0.1:9222`，可用 `WEB_GPT_PLANNER_EDGE_PORT` 覆盖，`WEB_GPT_PLANNER_EDGE_LAUNCHER` 指定启动脚本（默认 `%LOCALAPPDATA%\PiAgent\PiAgent-Edge.bat`，端点未运行时会拉起它）；登录态保存在专用 Profile `%LOCALAPPDATA%\Microsoft\Edge\PiAgentProfile`，不碰你日常 Edge 的 Profile。
  - 网页侧仍要求“聊天模式 + 最新 + 思考极高”；读回不符或无法确认时暂停，需手动设置后 `/sol-resume`。

权限模式支持：

- `No edit`：只读工具与只读 shell 命令直接放行，会修改内容的操作先弹确认框（允许一次 / 本会话始终允许同类操作 / 拒绝）；对静默放行的只读命令启用 git 变更哨兵，发现实际写入会自动回滚；
- `自动`：全部操作直接执行，不再询问。

详见 [`permission-mode/README.md`](permission-mode/README.md) 和 [`status-footer/README.md`](status-footer/README.md)。

`package.json` 中的 `pi.extensions` 使用 `./*/index.ts`，每个带 `index.ts` 的插件子目录会随 package 加载；`pi.skills` 指向 `./skills`，其中的 Skill 会随 package 发现。新扩展源码需重新加载或更新对应 package 后才会在 Pi 中生效，未经验证不得据此声称命令已可用。

## GitHub 安装

GitHub 仓库：<https://github.com/ddll8023/pi-extensions>

全局安装整个 package：

```bash
pi install git:github.com/ddll8023/pi-extensions
```

Pi 会将 package 缓存到 `~/.pi/agent/git/`，不会依赖本地 `test` 文件夹。更新 GitHub 上的所有插件：

```bash
pi update --extensions
```

然后在 Pi 中执行：

```text
/reload
```
