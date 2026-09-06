# PI extensions

用于保存后续开发的 Pi Agent 扩展。每个插件使用独立子目录。

## 当前插件

- `settings-zh/`：中文设置菜单扩展，命令为 `/settings-zh`。

`package.json` 中的 `pi.extensions` 使用 `./*/index.ts`，后续每增加一个带有 `index.ts` 的插件子目录，安装此 package 时会一并加载。

## 源代码与安装位置

- GitHub 源代码：`settings-zh/index.ts`
- 当前 Pi 安装副本：`~/.pi/agent/extensions/settings-zh.ts`

两者是独立文件，不使用符号链接。因此删除或移动本目录不会影响当前 Pi 已安装的插件。

源代码更新后，如需同步到当前 Pi：

```bash
cp "./settings-zh/index.ts" ~/.pi/agent/extensions/settings-zh.ts
```

发布到 GitHub 后，全局安装整个 package：

```bash
pi install git:github.com/ddll8023/pi-extensions
```

更新 GitHub 上的所有插件：

```bash
pi update --extensions
```

然后在 Pi 中执行：

```text
/reload
```
