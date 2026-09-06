# settings-zh

为 Pi Agent 提供中文设置菜单，命令为 `/settings-zh`。

## 源代码

```text
index.ts
```

## 当前安装副本

```text
~/.pi/agent/extensions/settings-zh.ts
```

源代码和安装副本是独立文件，不使用符号链接。修改源代码后，执行以下命令同步安装副本：

```bash
cp "./index.ts" ~/.pi/agent/extensions/settings-zh.ts
```

然后在 Pi 中执行：

```text
/reload
/settings-zh
```
