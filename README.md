# codex-unfence

需要 **macOS、Node.js ≥22.13.0 和 npm／npx**。

## 安装

直接从 npm 安装：

```bash
npx codex-unfence install
```

1. 运行安装命令。只有一个安装时自动选中；多个安装时按提示选择。也可追加 `--app <应用绝对路径>` 指定目标。
2. 核对目标、兼容性和影响，输入 `yes` 确认。
3. 安装成功后，必须完整退出对应桌面应用及相关浏览器服务（`browser-service`、`node_repl`），再重新启动应用，使新文件被加载。

安装需要交互终端。重复运行会识别已安装状态。检测到 ChatGPT、Codex 或相关服务正在运行时，工具只提示警告，仍可安装、卸载或恢复；成功写入后都需要完整退出并重启。若无法读取进程列表或确认进程身份，工具会停止操作并报告原因。

**补丁会修改应用签名资源，使严格签名校验失败，系统可能拒绝加载修改后的应用。** 工具不会重新签名、提权或关闭系统验证。

## 命令

```bash
npx codex-unfence --help
```

```bash
npx codex-unfence --version
```

`-h` 与 `--help` 等价，`-v` 与 `--version` 等价。查看某个命令的用法，例如：

```bash
npx codex-unfence check --help
```

检查所有发现的应用，不修改文件：

```bash
npx codex-unfence check
```

指定应用并输出 JSON：

```bash
npx codex-unfence check --app /Applications/Codex.app --json
```

卸载补丁：

```bash
npx codex-unfence uninstall
```

不带命令运行会进入交互引导。参数错误显示在 stderr；`--json` 模式下，结果与错误均输出到 stdout。

## 本地安装

在仓库目录使用 `package.json` 中固定版本的 pnpm 安装依赖：

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

打包会自动构建：

```bash
pnpm pack
```

使用生成的安装包：

```bash
npx --offline --package "$PWD/codex-unfence-0.0.2.tgz" codex-unfence install
```

按上述安装步骤确认并重启应用。请保留本地包，以便后续使用相同工具版本。

## 开源协议

本项目采用 [MIT License](LICENSE)。
