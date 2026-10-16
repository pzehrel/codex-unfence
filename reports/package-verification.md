# npm CLI 交付验证记录

日期：2026-10-16。范围：[最终安装包验收 #8](https://github.com/pzehrel/codex-browser-liberation-patch/issues/8)，上级为 [规格 #1](https://github.com/pzehrel/codex-browser-liberation-patch/issues/1)。本次最终评审修复基线为 `f1eb176e2d299bac9606ccfcad0ee88354ff6279`。

## 合成自动化：通过

本地环境为 macOS、Node.js `v22.20.0`、npm `10.9.3`。执行：

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run build
```

类型检查、静态检查、构建通过；测试 **144 通过、0 失败、0 跳过**。原有回归继续通过，安装产物验收含 8 个子场景（连同父测试共 9 项）。独立重跑安装产物验收可用 `npm run test:package`。新回归在实现前分别复现反射别名误接受、子类误接受、双链接锁 PATH_ALIAS，以及删除旧版本导致 ENOENT；修复后通过。

`tests/package.test.mjs` 实际打包、在独立临时 prefix 离线安装，并执行安装后的公开 bin；没有从测试导入生产源码或源码构建目录。它验证：

- 帮助、macOS/最低 Node 声明、可执行 bin 链接，以及 human/JSON schema 1 和退出码 0/1/2/3/4。
- 显式目标顺序、保留未选目标、all-compatible、多版本 browser/chrome 的 detect/prepare/apply/status/restore/recover，已知状态重复操作及文件权限。
- 第二目标失败且回滚失败时保留未完成组；普通写操作受阻；显式 recover 完成回滚。
- SIGKILL 中断 apply、restore 和 recover；再次恢复返回每个目标的混合操作前状态；未知外部内容导致全组零恢复写入。
- detect/prepare 拒绝 Reflect.set/Object.defineProperty 别名、继承覆盖和借用调用，不发布方案。
- store/target 锁的首次、后继和释放记录在真实 link 后、unlink 前 SIGKILL，公开命令可继续验证状态并安全重试。存活 owner 仍阻止写入，无法解释的硬链接仍冲突。
- 两版本共享 store，旧版本完成 apply/restore 后删除目录，新版本 status/apply/restore 及 pending recover 继续成功；选中目标的外部修改仍受保护。
- 精确包清单：十个运行 JS、README、package.json，以及四个锁定运行依赖的闭包。放入 dist 的合成本机状态哨兵被排除。测试、研究提取文件、专有应用 bundle、方案、备份及操作存储不在包内。

所有插件源码为可分发合成样例，插件根目录、home、store 均独立临时创建。可控进程及文件系统故障仅通过外部显式 `--require` fixture 注入测试子进程；fixture 不打包，生产 CLI 无绕过选项。没有修改真实安装或执行真实 bundle。

最终评审修复将源码证明收紧为明确的调用/环境能力和接收者闭包，保留改名、格式和静态读取支持；超出闭包的调用或逃逸保守拒绝。锁读取只识别工具发布留下的唯一私有同 inode staging 链接；历史方案加载与当前目标验证分离。canonical JSON 与 SHA-256 提取到单一生产模块，独立测试 oracle 保留；包白名单与清单断言同步增加该运行文件。方法级重复 mutation 扫描删除，整体源码 invariant 继续验证。

CI 已配置无 Codex 的 Linux/macOS、最低 Node `22.13.0` 和 Node 24，执行安装依赖、类型检查、静态检查、全部测试（包含已安装包验收）及构建。**本记录未将尚未运行的 GitHub Actions 或最低版本矩阵声明为已通过。**

## 真实源码结构兼容性：未验证

本次没有读取或重新分析真实安装源码，没有新增样本身份或兼容性结论。历史研究描述的 deferred initializer、拆分 URL 构造及 cache/inflight 控制流超出 `site-status-v1` 的有限证明范围。合成样例通过不表示实际样本兼容。

## 真实宿主加载、完整性及网站操作：未验证

没有启动或修改真实 Codex/ChatGPT，没有测试真实模块重载、缓存刷新、宿主完整性接受、更新覆盖或网站工具操作。文件和事务成功始终单独报告 `runtime: "not-verified"`。文件/目录 fsync 和合成 SIGKILL 验证不证明断电耐久性，也不能排除外部更新器。

## 集成分支最终复验

集成分支为 `integration/spec-1-structural-cli`。评审修复提交 `236833948c0998d0b4105d23ebe8e3c3c280a4ff` 已合入；随后提交 `38203ed` 将本地 `.claude/**` 代理工作目录排除在静态检查之外，避免扫描嵌套构建副本。该配置修正后，在主检出实际执行类型检查、静态检查、完整测试和构建，全部通过：**144 tests、144 pass、0 fail、0 skipped**。

最终审查的两个轴均完成独立复核：

- **Standards**：无已确认的文档规范违规；两项重复逻辑均已消除。生产完整性编码统一由 `src/integrity.ts` 提供，方法级冗余扫描已移除，全局修改约束保留。
- **Spec**：四项已复现缺陷均已修复。原反射别名和动态接收者输入现在明确不兼容；锁双链接发布中断后可安全重试，未知硬链接仍拒绝；删除无关的终态历史版本后，所选目标的查询、应用和中断回滚正常，未知外部修改仍受保护。

独立复核重跑原合成探针，没有把已有测试通过当作缺陷已修复的唯一依据。八个已合入且干净的实现工作树已清理，本地分支保留；原有 `.scratch` 未修改。未推送代码、发布 npm 或修改真实安装。GitHub 工单结案另受外部写入授权约束。

## 干净检出复验

必须先运行 `npm ci --ignore-scripts`。父集成检出曾因没有 node_modules 而出现 `tsc: command not found`；该次尝试不算构建通过，也不需要产品代码修复。协调者随后已确认父检出运行 `npm ci --ignore-scripts` 及 `npm run build` 通过。干净检出仍须先安装依赖，再按上面的命令复验。不要推送、发布 npm、修改真实插件或写外部 tracker；这些不属于本地交付验证。
