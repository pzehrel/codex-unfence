# npm CLI 交付验证记录

日期：2026-10-16。范围：[最终安装包验收 #8](https://github.com/pzehrel/codex-browser-liberation-patch/issues/8)，上级为 [规格 #1](https://github.com/pzehrel/codex-browser-liberation-patch/issues/1)。实现基线为 `ad09681037d19b0a29df7bd90862da458754a0e0`。

## 合成自动化：通过

本地环境为 macOS、Node.js `v22.20.0`、npm `10.9.3`。执行：

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run build
```

类型检查、静态检查、构建通过；测试 **133 通过、0 失败、0 跳过**。原有 128 项行为验证继续通过，扩展安装产物验收增加 5 个子场景。独立重跑安装产物验收可用 `npm run test:package`。

`tests/package.test.mjs` 实际打包、在独立临时 prefix 离线安装，并执行安装后的公开 bin；没有从测试导入生产源码或源码构建目录。它验证：

- 帮助、macOS/最低 Node 声明、可执行 bin 链接，以及 human/JSON schema 1 和退出码 0/1/2/3/4。
- 显式目标顺序、保留未选目标、all-compatible、多版本 browser/chrome 的 detect/prepare/apply/status/restore/recover，已知状态重复操作及文件权限。
- 第二目标失败且回滚失败时保留未完成组；普通写操作受阻；显式 recover 完成回滚。
- SIGKILL 中断 apply、restore 和 recover；再次恢复返回每个目标的混合操作前状态；未知外部内容导致全组零恢复写入。
- 精确包清单：九个运行 JS、README、package.json，以及四个锁定运行依赖的闭包。放入 dist 的合成本机状态哨兵被排除。测试、研究提取文件、专有应用 bundle、方案、备份及操作存储不在包内。

所有插件源码为可分发合成样例，插件根目录、home、store 均独立临时创建。可控进程及文件系统故障仅通过外部显式 `--require` fixture 注入测试子进程；fixture 不打包，生产 CLI 无绕过选项。没有修改真实安装或执行真实 bundle。

交付修复只收紧 `package.json` 的 files 白名单，防止 `dist/` 下额外本机工件被带入 tarball；新增回归已观察到修复前失败、修复后通过。没有增加结构模式或修改事务语义。

CI 已配置无 Codex 的 Linux/macOS、最低 Node `22.13.0` 和 Node 24，执行安装依赖、类型检查、静态检查、全部测试（包含已安装包验收）及构建。**本记录未将尚未运行的 GitHub Actions 或最低版本矩阵声明为已通过。**

## 真实源码结构兼容性：未验证

本次没有读取或重新分析真实安装源码，没有新增样本身份或兼容性结论。历史研究描述的 deferred initializer、拆分 URL 构造及 cache/inflight 控制流超出 `site-status-v1` 的有限证明范围。合成样例通过不表示实际样本兼容。

## 真实宿主加载、完整性及网站操作：未验证

没有启动或修改真实 Codex/ChatGPT，没有测试真实模块重载、缓存刷新、宿主完整性接受、更新覆盖或网站工具操作。文件和事务成功始终单独报告 `runtime: "not-verified"`。文件/目录 fsync 和合成 SIGKILL 验证不证明断电耐久性，也不能排除外部更新器。

## 干净检出复验

必须先运行 `npm ci --ignore-scripts`。父集成检出曾因没有 node_modules 而出现 `tsc: command not found`；该次尝试不算构建通过，也不需要产品代码修复。协调者随后已确认父检出运行 `npm ci --ignore-scripts` 及 `npm run build` 通过。干净检出仍须先安装依赖，再按上面的命令复验。不要推送、发布 npm、修改真实插件或写外部 tracker；这些不属于本地交付验证。
