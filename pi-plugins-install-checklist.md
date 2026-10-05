# Pi Agent 环境安装清单（新电脑快速入手）

在一台新电脑上复现本环境，需要装**两类互不替代的东西**：

| 类别 | 数量 | 安装方式 | 装在什么地方 |
|---|---:|---|---|
| pi 扩展（插件包） | 6 | `pi install <source>` | pi 的全局配置，由 `pi list` 管理 |
| 独立命令行工具 pigui | 1 | `npm i -g github:ddll8023/pigui` | npm 全局，命令行多一个 `pigui` 命令 |

> **最容易踩的坑**：pigui 是独立 CLI 工具，**不是 pi 扩展**，仓库里没有 `index.ts`，`pi.extensions` 不会加载它，`pi install` 也装不了。反过来，`npm i -g` 也装不了 pi 扩展。两条路互不影响。

## 0. 前置检查

```bash
node -v          # 需 >= 22.19.0，这是 pi 1.0.3 的 engines 要求（本机实测 v26.5.0 可用）
npm -v           # 本机 11.17.0
pi --version     # 本机 1.0.3
pi list          # 看这台机器当前已装了什么，装之前先跑一次
```

- 需要能访问 npm registry 与 GitHub。
- pigui 想自动打开浏览器页签时还需要 **Orca**（它内部调用 `orca tab create`）；没有 Orca，用 `pigui --no-open` 只起服务并打印地址。

## 1. 安装 6 个 pi 扩展

`pi install` **一次只能接一个 source**，所以逐条执行（没有一条命令装完的写法）：

```bash
pi install npm:pi-mcp-adapter
pi install npm:pi-web-access
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:@ff-labs/pi-fff
pi install npm:@tunnckocore/pi-gpt-fast-mode
pi install git:github.com/ddll8023/pi-extensions
```

默认装到用户全局配置；只想当前项目用，加 `-l`：

```bash
pi install -l npm:pi-mcp-adapter
```

## 2. 安装 pigui（独立工具，1 条命令）

```bash
npm i -g github:ddll8023/pigui
```

装完后，macOS / Linux 在全局 bin 目录生成 `pigui` 入口（本机为 `/opt/homebrew/bin/pigui`），Windows 会多生成 `pigui.cmd` / `pigui.ps1`；之后任何目录都可直接执行 `pigui`。

❌ **不要执行 `npm i -g pigui`**：npm 上的同名包 `pigui@0.0.0` 是 2019 年的无关 UI 组件库，装错了完全不是这个工具。务必用上面的 `github:ddll8023/pigui` 地址。

> 另有第三方 pi 扩展 `pi-gui-extension`（包内命令 `/gui`，在 pi 里开本地网页界面），功能与 pigui 重叠、都连同一套 pi SDK 与会话目录，因此**本清单不再列入**。需要时单独 `pi install npm:pi-gui-extension`，注意它作为 pi 扩展会随 pi 启动加载第三方代码。

## 3. 验证

```bash
pi list        # 应列出 6 个包（user 或 project 段下）
which pigui    # macOS / Linux；Windows 用 where pigui。应有路径，例如 /opt/homebrew/bin/pigui
```

如果 Pi 已经在运行，装完后在 Pi 里执行 `/reload`（也可以退出重启），新扩展才会生效。

pigui 的启动验证（会起本地服务，需在 Orca 的 worktree 终端里跑）：

```bash
cd <你的 worktree 目录>
pigui --no-open    # 只起服务并打印地址，最省事、不影响其他会话
```

停止：在该终端按 `Ctrl+C`。pigui 默认**新建会话**，不碰该目录里的历史会话。

## 插件清单

| 状态 | 插件包 | 功能概述 | 安装指令 |
|---|---|---|---|
| [ ] | `pi-mcp-adapter` | MCP（Model Context Protocol）服务适配 | `pi install npm:pi-mcp-adapter` |
| [ ] | `pi-web-access` | 网页搜索、网页/PDF/GitHub/视频访问 | `pi install npm:pi-web-access` |
| [ ] | `@juicesharp/rpiv-ask-user-question` | 结构化询问用户 | `pi install npm:@juicesharp/rpiv-ask-user-question` |
| [ ] | `@ff-labs/pi-fff` | 模糊文件与内容搜索 | `pi install npm:@ff-labs/pi-fff` |
| [ ] | `@tunnckocore/pi-gpt-fast-mode` | 通过 `/fast` 切换 GPT 快速模式 | `pi install npm:@tunnckocore/pi-gpt-fast-mode` |
| [ ] | `ddll8023/pi-extensions` | 个人扩展集合（见下） | `pi install git:github.com/ddll8023/pi-extensions` |

### `ddll8023/pi-extensions` 包含的扩展

包内 `pi.extensions` 为 `./*/index.ts`，会加载以下带 `index.ts` 的子目录：

- `codex-usage`：命令 `/codex-usage`，显示 ChatGPT/Codex 账号剩余额度
- `settings-zh`：命令 `/settings-zh`，中文设置菜单
- `permission-mode`：命令 `/permission-mode`，权限模式切换
- `token-rate`：显示 Token 生成速率
- `status-footer`：自定义底部状态栏

## 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `pi install npm:pigui` 失败或找不到 | pigui 不是 pi 扩展 | 改用 `npm i -g github:ddll8023/pigui` |
| 装完 `pigui --version` 出来个 v0.0.0 的 UI 组件库 | 执行了 `npm i -g pigui`，装到 npm 上的同名无关包 | `npm rm -g pigui` 后改装 `github:ddll8023/pigui` |
| 装完命令没出现 / 扩展没生效 | 未重载 | 在 Pi 里 `/reload`，或退出重启 Pi |
| `pi list` 少了某个包 | 装到了项目本地，或某条命令没成功 | `pi list` 会分 user / project 两段列出；确认是否用了 `-l`；重跑失败那条 |
| pigui 起了服务但没自动开页签 | 没装 Orca，或不在 Orca 的 worktree 里 | 用 `pigui --no-open`，自己打开打印出的地址 |
| pigui 报找不到 pi SDK | 本机没装 pi | 先安装并确认 `pi --version` 可用 |
| 改了扩展源码但没生效 | 扩展按 package 加载，改源码需更新对应 package | `pi update --extensions` 后再 `/reload` |

## 版本与可复现性

- **本清单不锁版本**：`pi install` 与 `npm i -g` 都会装当时的最新版，因此不同时间装出来的版本可能不同。
- 需要完全可复现时：
  - npm 包写死版本，例如 `pi install npm:pi-mcp-adapter@5.0.0`；
  - git 包用带 tag 或 commit 的地址（具体写法见 `pi install --help` 的 Git 示例）；该仓库目前没有 tag，只能用 commit。
- 更新已装的扩展：`pi update --extensions`，然后 `/reload`。

下表是写入本清单时这台机器的实装版本，会随时间过期，仅用于判断「是不是装得太旧」：

| 项 | 本机版本 |
|---|---|
| pi | 1.0.3 |
| node / npm | v26.5.0 / 11.17.0 |
| pi-mcp-adapter | 5.0.0 |
| pi-web-access | 0.36.0 |
| @juicesharp/rpiv-ask-user-question | 2.12.0 |
| @ff-labs/pi-fff | 0.11.0 |
| @tunnckocore/pi-gpt-fast-mode | 0.4.0 |
| git 包 pi-extensions | 0.1.0（commit `0ca9025`） |
| pigui | 0.1.0 |

## 安装到项目本地（可选）

默认安装到用户全局配置。只希望当前项目使用，把每条命令加上 `-l`：

```bash
pi install -l npm:pi-web-access
```

对应的移除命令为 `pi remove <source> [-l]`。
