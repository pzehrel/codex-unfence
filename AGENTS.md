## Engineering

- 使用 `package.json` 固定版本的 pnpm 管理仓库；依赖锁文件仅使用 `pnpm-lock.yaml`。安装使用 `pnpm install --frozen-lockfile --ignore-scripts`。
- 所有维护代码使用 TypeScript（`.ts`；同步 CommonJS 测试 preload 使用 `.cts`）。禁止新增手写 `.js`、`.mjs`、`.cjs` 或其他语言的执行脚本。`dist/` 和 `.build/` 仅为忽略的编译产物；被分析的 JavaScript 文本样本与目标插件文件名不属于执行入口。
- 统一检查使用 `pnpm run check --base <明确基线>`，覆盖产品、测试、脚本和配置的严格类型检查。不要使用 `@ts-nocheck` 或全局放宽类型规则绕过迁移。
- npm／npx 仅保留为产品消费者兼容性测试和普通用户分发入口，工程依赖、构建、测试及打包使用 pnpm。

## Agent skills

### Issue tracker

Issues 和 specs 使用 GitHub Issues；读取、创建或更新工作项前，参阅 `docs/agents/issue-tracker.md`。

### Triage labels

Triage 使用默认五角色标签；分类或修改标签前，参阅 `docs/agents/triage-labels.md`。

### Domain docs

领域文档采用 single-context；探索代码或讨论领域术语、架构决策前，参阅 `docs/agents/domain.md`。

### Repository guardrails

修改测试隔离或统一检查、接手并行任务、集成交付或清理 worktree 前，参阅 [仓库工程与协作协议](docs/design/retro-guardrails.md)。
