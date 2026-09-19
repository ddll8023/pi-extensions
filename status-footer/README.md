# status-footer

自定义 Pi 底部 Footer：保留 Pi 默认的目录、用量和模型信息，将扩展状态分成最多两行，并默认隐藏 MCP 状态。

## 显示示例

```text
~/Desktop/test/PI extension (main)
↑24k ↓5.3k R319k CH9.4% $0.008 2.6%/1.1M (auto)    gpt-5.6-luna • max
Codex 42%↻6天15时 · 权限 自动
OV✓ ctx0/30k · 速率 实82/s 均75/s
```

MCP 只是不在 Footer 中显示，不影响 MCP 服务和工具调用。

## 配置

全局配置：

```text
~/.pi/agent/status-footer.json
```

受信任的项目也可以使用项目配置：

```text
.pi/status-footer.json
```

示例：

```json
{
  "statusRows": 2,
  "hideMcp": true,
  "hiddenStatusKeys": [],
  "order": [
    "codex-usage",
    "permission-mode",
    "openviking",
    "token-rate"
  ],
  "showIdleTokenRate": false
}
```

配置修改后执行：

```text
/status-footer reload
```

查看当前配置：

```text
/status-footer
```

## 说明

扩展通过 Pi 的公开 `ctx.ui.setFooter()` API 实现，不修改 Pi 安装目录。若其他扩展也自定义 Footer，后加载的 Footer 会覆盖当前布局。
