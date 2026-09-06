# permission-mode

为 Pi Agent 提供两个可切换的权限模式：

- `No edit`：禁止模型调用 `edit` 工具，其他当前可用工具全部保留；
- `自动`：启用当前会话可用的全部工具。

## 使用

```text
/permission-mode
/permission-mode no-edit
/permission-mode auto
/permission-mode status
```

也可以使用 `F6` 在两个模式之间切换。

模式会写入当前会话，并在 `/reload`、恢复会话和切换会话分支后恢复。

## 边界

`No edit` 只禁止 `edit` 工具，不是只读沙箱；`write` 工具和 `bash` 仍然允许执行文件修改。插件同时通过工具调用拦截再次确认 `edit` 不会执行。

“自动”启用的是 Pi 当前会话已经暴露的全部工具，不会绕过操作系统权限、项目可信任设置或 Pi 进程本身的权限边界。
