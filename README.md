# PI extensions

用于保存后续开发的 Pi Agent 扩展。每个插件使用独立子目录。

## 当前插件

- `codex-usage/`：在底部状态栏显示 ChatGPT/Codex 账号剩余额度，命令为 `/codex-usage`。
- `settings-zh/`：中文设置菜单扩展，命令为 `/settings-zh`。
- `permission-mode/`：权限模式切换扩展，命令为 `/permission-mode`。
- `token-rate/`：在模型生成期间显示当前 AI 回复的 Token 生成速率。
- `status-footer/`：自定义底部 Footer，隐藏 MCP 状态，并将插件状态分成最多两行显示。
- `supervisor/`：默认关闭的任务级旁路监督，命令为 `/supervisor on|off|status`；只给建议，不执行工具或产生授权。详见 [`supervisor/README.md`](supervisor/README.md)。
- `pigui/`：**已迁出本仓库**，现为独立仓库与独立 npm 包：<https://github.com/ddll8023/pigui>（`npm i -g github:ddll8023/pigui`）。它是命令行工具，不是 pi 扩展，不会被 `pi.extensions` 加载。

权限模式支持：

- `No edit`：只读工具与只读 shell 命令直接放行，会修改内容的操作先弹确认框（允许一次 / 本会话始终允许同类操作 / 拒绝）；对静默放行的只读命令启用 git 变更哨兵，发现实际写入会自动回滚；
- `自动`：全部操作直接执行，不再询问。

详见 [`permission-mode/README.md`](permission-mode/README.md) 和 [`status-footer/README.md`](status-footer/README.md)。

`package.json` 中的 `pi.extensions` 使用 `./*/index.ts`，每个带 `index.ts` 的插件子目录会随 package 加载。扩展由当前会话加载后才会注册对应命令；修改本地源码不会自动更新通过 GitHub 安装的 package 缓存副本。

## pigui（网页对话界面）

`pigui` 已拆成独立仓库与独立 npm 包：<https://github.com/ddll8023/pigui>（安装：`npm i -g github:ddll8023/pigui`）。本仓库不再包含它，`package.json` 里也不再声明 `bin`。

**它不是 pi 扩展**，`pi install` 装不了它；同样不要执行 `npm i -g pigui`——npm 上的同名包是 2019 年的无关 UI 组件库，必须用带 `github:ddll8023/` 的地址。新电脑从零复现整套环境见 [`pi-plugins-install-checklist.md`](pi-plugins-install-checklist.md)。

它借用本机已安装的 pi 的 SDK（不写进依赖、不额外下载），以当前工作目录为 `cwd` 起一个本地 HTTP + SSE 服务，再让 Orca 在本 worktree 打开页签；页面与 pi 共用 `~/.pi/agent/sessions` 会话目录。用法、参数与接口协议见新仓库的 `README.md`。

## GitHub 安装

GitHub 仓库：<https://github.com/ddll8023/pi-extensions>

全局安装整个 package：

```bash
pi install git:github.com/ddll8023/pi-extensions
```

pi 扩展与独立工具 pigui 是两条互不替代的安装路线，完整步骤、验证命令与常见报错排查见 [`pi-plugins-install-checklist.md`](pi-plugins-install-checklist.md)。

Pi 会将 package 缓存到 `~/.pi/agent/git/`，不会依赖本地 `test` 文件夹。更新 GitHub 上的所有插件：

```bash
pi update --extensions
```

然后在 Pi 中执行：

```text
/reload
```
