# permission-mode

为 Pi Agent 提供两种权限模式：

- **No edit（默认）**：命令类调用直接执行，`edit`/`write` 等文件编辑操作先向你确认；
- **自动**：全部操作直接执行，不再询问。

## 使用

```text
/permission-mode
/permission-mode no-edit
/permission-mode auto
/permission-mode status
```

也可以使用 `F6` 在两个模式之间切换。模式会写入当前会话，并在 `/reload`、恢复会话和切换会话分支后恢复。

## No edit 模式的行为

1. **只读工具**（`read`、`grep`、`find`、`ls`，以及已知只读的扩展工具）直接放行。
2. **只读 shell 命令**（`bash` / `powershell`）直接放行，例如 `git status`、`git log`、`rg`、`cat`、`Get-ChildItem`；明确写入的 shell 命令仍会确认。
3. **命令/分析工具**（`ctx_execute`、`ctx_execute_file`、`ctx_batch_execute`、`ctx_fetch_and_index`、`ctx_index`、`ctx_doctor`、`ctx_insight`）直接执行，不因工具名重复确认；
4. **其它调用**（`edit`、`write`、未列入命令工具的 MCP 工具、`memory_add`、`skill_manage` 等）弹出确认框：

   - `允许一次`：仅本次放行；
   - `本会话始终允许同类操作`：按工具名或命令名记住，本会话内不再询问；
   - `拒绝`：阻止该次调用并返回拒绝原因。

   没有可交互界面时（例如 `-p` 打印模式）一律按拒绝处理。

5. **变更哨兵**：对第 2、3 类静默放行的调用，在执行前后比对 git 工作区；如果实际写入了文件，自动回滚这些路径并把工具结果标记为错误。被第 4 类确认放行的操作不回滚。

## 自动放行工具

- 内置只读：`read`、`grep`、`find`、`ls`
- 命令/分析工具：`ctx_execute`、`ctx_execute_file`、`ctx_batch_execute`、`ctx_fetch_and_index`、`ctx_index`、`ctx_doctor`、`ctx_insight`（实际改动由变更哨兵回滚）
- 扩展工具（未安装的会被自动忽略）：`web_search`、`source_check`、`fetch_content`、`get_search_content`、`memory_search`、`session_search`、`ask_user_question`、`questionnaire`、`ffgrep`、`fffind`、`rg`、`ctx_search`、`ctx_stats`、`mcp_database_database_status`、`todo`、`tool_search`

## 只读命令判定

默认拒绝：命令按 `;`、`&&`、`||`、`|`、`&`、换行分段，逐段检查后才放行。

判定维度：

- 命令名必须在白名单内（`git`、`rg`、`cat`、`ls`、`npm ls`、`Get-ChildItem`、`Select-String` 等）；
- `git`、`npm`/`pnpm`/`yarn`、`find`、`rg`、`fd`、`tree`、`sort`、`yq`、`curl`、`date`、`ip` 等命令额外校验子命令与参数（例如 `git commit`、`git stash pop`、`npm install`、`curl -o`、`rg --pre`、`sort -o`、`find -exec` 都会被拒绝）；
- 解释器只允许查看版本（`python --version`、`node --version`），`python -c`、`node -e`、`sh -c`、`npx` 一律拒绝；
- 写文件重定向（`>`、`>>`、`<`）拒绝，`2>&1`、`>/dev/null`、`>$null` 视为无副作用；
- 命令替换、进程替换、here-doc、here-string、反引号、`eval`、`sudo` 等动态执行形式拒绝；
- 相对路径命令（`./script.sh`）拒绝；
- PowerShell 额外按动词判定，写入类动词（`Set-`、`New-`、`Remove-`、`Move-`、`Copy-`、`Rename-`、`Out-File`、`Export-`、`Start-Process`、`Add-Type` 等）及其别名（`rm`、`cp`、`sc`、`iex`、`tee` …）一律拒绝，脚本块内的写入命令也会被逐词扫描拦下。

## 配置

可选配置文件，全局 `~/.pi/agent/permission-mode.json` 与项目 `<cwd>/.pi/permission-mode.json` 会合并：

```json
{
  "readOnlyTools": ["mcp_database_database_status"],
  "readOnlyCommands": ["mytool", "get-mything"],
  "rollbackOnChange": true
}
```

- `readOnlyTools`：追加视为只读的工具名，不再弹确认框；
- `readOnlyCommands`：追加视为只读的命令名，命中后**不再校验参数**，仅在你确认该命令不会写文件时使用；
- `rollbackOnChange`：是否启用变更哨兵，默认 `true`；设为 `false` 时只依赖静态判定。

## 边界与已知限制

- 命令/分析工具不弹出前置确认；如果其中的脚本改动 git 工作区，变更哨兵会在执行后回滚。非 git 目录、外部系统和数据库副作用无法由哨兵回滚。
- Pi 没有内置沙箱，Windows 原生也没有可用的 OS 级沙箱，因此 No edit 是**策略层拦截 + 事后回滚**，不是强隔离。需要强隔离时应在容器 / WSL 中运行 Pi。
- 命令判定是启发式的：白名单外的命令一律需要确认，因此误报（多问一次）是设计的一部分；漏报由变更哨兵兜底。
- 变更哨兵依赖 `git`，且只在 git 工作区内生效；非 git 目录会提示哨兵不可用。它只比对 git 状态码变化的路径，不检测已存在的未跟踪文件的内容变化。
- 并发执行多条 shell 命令时，只由最后完成的那次调用统一做哨兵检查。
- 确认框里放行的操作不会被回滚，这是有意的：确认即代表你接受该次修改。
- 本会话授权只作用于当前会话；子 agent 或另起的 pi 进程有自己的会话与授权状态。
- 若同时安装其它占用 `F6` 或处理 `edit`/`write` 权限的扩展（例如 `pi-pledit`），行为会叠加，建议只保留一个。
