# PI extensions

用于保存后续开发的 Pi Agent 扩展。每个插件使用独立子目录。

## 当前插件

- `codex-usage/`：在底部状态栏显示 ChatGPT/Codex 账号剩余额度，命令为 `/codex-usage`。
- `settings-zh/`：中文设置菜单扩展，命令为 `/settings-zh`。
- `permission-mode/`：权限模式切换扩展，命令为 `/permission-mode`。

权限模式支持：

- `No edit`：禁止模型调用 `edit` 工具，其他工具允许；
- `自动`：启用当前会话可用的全部工具。

`package.json` 中的 `pi.extensions` 使用 `./*/index.ts`，后续每增加一个带有 `index.ts` 的插件子目录，安装此 package 时会一并加载。

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
