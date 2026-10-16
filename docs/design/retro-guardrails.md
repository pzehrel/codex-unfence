# Repo-retro：测试隔离与统一检查

基线：`a2df734ce657b7dbb453eeec4b83872123efe954`。范围限于仓库工程工具，不改变插件文件补丁功能或 npm 发布文件 allowlist。

## 完成条件

- 所有源码及已安装 CLI 测试通过 `tests/helpers/cli.mjs` 启动。同步与异步共用隔离策略，支持显式外部 preload、IPC 暂停和已安装可执行文件。
- 启动目录必须位于系统临时目录内。最终 cwd、HOME、XDG 目录及 PWD 固定到该 sandbox；环境只继承必要宿主变量，并在调用方覆盖之后清空 NODE_OPTIONS、NODE_PATH。环境覆盖只用于显式测试 fixture 输入。
- 真实 CLI 默认发现回归验证调用方 HOME/cwd 覆盖不会改变发现位置。外部 fixture 同时验证同步、异步子进程的 cwd 与环境；不绑定生产内部 AST。
- ESLint 拒绝测试直接导入、重导出、动态导入或 require `child_process` / `node:child_process`，包括静态模板字符串、常见 require 别名及 getBuiltinModule。负例通过 ESLint 公共接口验证。
- 例外仅限共享 launcher、固定 npm pack/install 支持模块，以及 `transaction-boundaries.cjs` 拦截 `/bin/ps` 的精确 require 行。该 fixture 的其他导入继续受限，常用直接 spawn/exec/fork 属性另受限制。
- `npm run check -- --base <ref>` 依次运行显式基线的 `git diff --check`、typecheck、lint、test。test 已包含 build，因此不再重复 build。任一步失败立即返回其状态。
- `npm run check -- --base <ref> --whitespace-only` 只运行相同空白检查；`--help` 提供用法。缺失或不可解析基线返回 2。ref 经校验并解析为 tree ID，所有子命令使用参数数组，不使用 shell 拼接。
- CI 与本地使用同一 check 命令。checkout 使用完整历史，PR 使用目标分支 SHA，push 使用事件 before SHA；首次推送新分支使用显式空树，force-push 旧 tip 不在历史时按 SHA fetch。

## 验证边界

TDD 记录包含默认发现隔离、缺失 lint 规则、缺失 check 命令及首次 push 空树支持的失败，再通过对应定向回归。最终全量验证使用上述固定基线。

空白检查遵循 `git diff <base>`：覆盖已提交、暂存及工作区的 tracked 差异，不检查尚未 git add 的新文件。lint 限制实用的直接访问路径，不尝试阻止任意字符串计算或恶意规则规避。GitHub Actions 矩阵需由 CI 实际执行；本地验证不代表已运行远端工作流。

## 本地验收

统一入口 `npm run check -- --base a2df734ce657b7dbb453eeec4b83872123efe954` 完整通过：类型检查、静态检查及包含构建的 149 项测试，零失败、零跳过。审查发现 ps mock 例外遗漏 `execFile` 直接调用限制，随后补充 dot/computed 调用约束及完整 fixture 的静态回归。修复后定向 `tests/guardrails.test.mjs` 的 4 项测试、类型检查、静态检查及显式基线空白检查均通过；没有将修复前的全套结果冒称为修复后再次执行。产品源码和发布资产白名单保持原有行为。
