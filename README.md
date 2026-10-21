# codex-unfence

需要 **macOS、Node.js ≥22.13.0 和 npm／npx**。

## 安装

直接从 npm 安装：

```bash
npx codex-unfence install
```

1. 完全退出对应桌面应用及相关浏览器服务。
2. 运行安装命令。只有一个安装时自动选中；多个安装时按提示选择。也可追加 `--app <应用绝对路径>` 指定目标。
3. 核对目标、兼容性和影响，输入 `yes` 确认。安装成功后手动重新打开应用。

安装需要交互终端。重复运行会识别已安装状态。

**补丁会修改应用签名资源，使严格签名校验失败，系统可能拒绝加载修改后的应用。** 工具不会重新签名、提权或关闭系统验证。

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
npx --offline --package "$PWD/codex-unfence-0.0.1.tgz" codex-unfence install
```

按上述安装步骤确认并重启应用。请保留本地包，以便后续使用相同工具版本。
