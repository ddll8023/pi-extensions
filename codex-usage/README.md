# codex-usage

在 Pi Agent 底部状态栏显示 ChatGPT/Codex 账号的剩余额度。

显示内容包括：

- 短周期窗口（通常为 5 小时）剩余百分比与重置倒计时；
- 周期窗口（通常为 7 天）剩余百分比与重置倒计时；
- 可用购买额度余额（如果账号有）；
- `/codex-usage` 手动刷新并查看百分比、倒计时和具体重置时间。

## 使用

安装整个扩展包后执行：

```text
/reload
```

如果状态栏显示刷新失败，可执行：

```text
/codex-usage
```

## 说明

扩展使用 Pi 当前的 `openai-codex` OAuth 登录凭据，并调用 Codex 使用量接口：

```text
GET https://chatgpt.com/backend-api/wham/usage
```

该接口是 Codex 客户端使用的内部接口，并非稳定的公开 API；如果 OpenAI 修改接口，额度状态可能暂时无法显示。扩展不会输出或保存 OAuth 访问令牌。

状态栏条目仅在当前模型使用 Codex 响应 API（`openai-codex-responses`）时显示；切换到其他模型后条目会自动清除，也不会再轮询额度。此时仍可手动执行 `/codex-usage` 查询额度详情。
