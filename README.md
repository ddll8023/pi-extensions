# PI extensions

用于保存后续开发的 Pi Agent 扩展。每个插件使用独立子目录。

## 当前插件

- `codex-usage/`：在底部状态栏显示 ChatGPT/Codex 账号剩余额度，命令为 `/codex-usage`。
- `settings-zh/`：中文设置菜单扩展，命令为 `/settings-zh`。
- `permission-mode/`：权限模式切换扩展，命令为 `/permission-mode`。
- `token-rate/`：在模型生成期间显示当前 AI 回复的 Token 生成速率。
- `status-footer/`：自定义底部 Footer，隐藏 MCP 状态，并将插件状态分成最多两行显示。
- `pigui/`：命令行工具（不是 pi 扩展，不会被 `pi.extensions` 加载）。在任意工作目录执行 `pigui`，起本地服务并让 Orca 在本 worktree 打开网页对话界面；页面里可用 `/model` 切换模型与思考等级，用 `@` 引用工作目录里的文件，也可拖拽／粘贴上传图片与文本附件。

权限模式支持：

- `No edit`：只读工具与只读 shell 命令直接放行，会修改内容的操作先弹确认框（允许一次 / 本会话始终允许同类操作 / 拒绝）；对静默放行的只读命令启用 git 变更哨兵，发现实际写入会自动回滚；
- `自动`：全部操作直接执行，不再询问。

详见 [`permission-mode/README.md`](permission-mode/README.md) 和 [`status-footer/README.md`](status-footer/README.md)。

`package.json` 中的 `pi.extensions` 使用 `./*/index.ts`，每个带 `index.ts` 的插件子目录会随 package 加载。新扩展源码需重新加载或更新对应 package 后才会在 Pi 中生效，未经验证不得据此声称命令已可用。

## pigui（网页对话界面）

`pigui/` 是本仓库里的一个独立命令行工具，**不是 pi 扩展**：目录内没有 `index.ts`，所以打包根 `package.json` 的 `pi.extensions`（`./*/index.ts`）不会加载它。

它借用本机已安装的 pi 的 SDK（不写进依赖、不额外下载），以当前工作目录为 `cwd` 起一个本地 HTTP + SSE 服务，再让 Orca 在本 worktree 打开页签；页面与 pi 共用 `~/.pi/agent/sessions` 会话目录。

安装（跨机器）：

```bash
npm i -g github:ddll8023/pi-extensions
```

这个 npm 包只带 `pigui/`（打包根 `package.json` 的 `files` 只列了它）：装完只有一个 `pigui` 命令，本仓库里那 5 个 pi 扩展不在里面，它们由下面的 `pi install git:...` 安装，两条路互不影响。

用法、参数与接口协议见 [`pigui/README.md`](pigui/README.md)。

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
