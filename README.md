# Codex Browser Site Status Patch

正式工具是 macOS 的 Node.js CLI：发现 browser/chrome 插件，证明有限的站点状态消费结构，生成可审阅方案，再执行可恢复的文件事务。它只在本地消费点构造响应副本，将 `feature_status.agent` 固定为 `false`，保留请求、原对象及其他字段。

**当前证据来自临时目录中的合成样例。真实插件结构兼容性、Codex 加载、宿主完整性接受和网站操作均未验证。** 已研究样本包含首版不支持的 deferred initializer 和 cache/inflight 控制流；不能据此声称实际样本兼容。检测不执行插件源码，也不修改插件。

## 限定版本的 CUA 请求包装副本

当前另有一个仓库内的本地准备切片，见 [CUA 请求包装规格](docs/design/cua-request-wrapper-slice.md)：在已确认版本的专用请求通道中注入 `ok/json` 响应适配器，保留原 fetch 和判定器，仅在 JSON 数据副本中将严格为 true 的 agent 改为 false。它采用文件身份限制、定向审查及合成行为测试，不表示完成上述正式 CLI 的结构证明，也不接入其 apply/restore 方案。

准备脚本只生成私有原始／补丁副本和核对清单，不修改安装或运行应用。真实加载、生效、撤销、旧缓存及宿主完整性接受仍未验证；未知版本拒绝，不自动跟随更新。具体命令及验证结果见 [副本交付报告](reports/cua-request-wrapper-implementation.zh-CN.md)。该脚本仅供仓库内运行，不包含在 npm 包中。

后续的仓库内应用／恢复工具见 [应用切片](docs/design/cua-wrapper-application-slice.md)及[工具交付报告](reports/cua-wrapper-application-implementation.zh-CN.md)。它采用独立的限定版本准入，并复用文件事务保护；不把 CUA 副本作为旧结构方案传入正式 CLI。真实安装写入和宿主／站点验收须另行确定范围，步骤见 [真实验收准备](docs/design/cua-wrapper-runtime-acceptance.md)。

## 本地安装

首版仅支持 macOS，要求 **Node.js >=22.13.0** 和 npm。Linux 只用于合成自动化，不属于产品平台支持。

在仓库根目录构建并安装本地 tarball：

```bash
npm ci --ignore-scripts
npm run build
npm pack
npm install --global --prefix "$HOME/.local" --ignore-scripts --offline --no-audit --no-fund ./codex-browser-liberation-patch-0.1.0.tgz
export PATH="$HOME/.local/bin:$PATH"
codex-browser-patch --help
```

`npm ci` 需要获取锁定的开发依赖；tarball 已包含运行依赖，后续本地安装可离线完成。本流程不需要公共 npm 发布。安装 CLI 本身不应用补丁。

包使用 `package.json` 中的逐文件白名单，包含明确列出的 `dist/*.js` 运行文件，以及 npm 自动包含的 `package.json`、本 README 和 Acorn/eslint-scope 的依赖闭包（`acorn`、`eslint-scope`、`esrecurse`、`estraverse`）。测试、源码、研究报告、真实应用 bundle、提取工件、本机方案、备份和操作存储不进入包。构建目录中额外遗留的本机状态也不在白名单内。

## 工作流程

先检测，再明确选择目标并审阅方案。下列写操作示例使用**自行创建的合成插件根目录**；真实安装的修改需要用户单独决定。

```bash
codex-browser-patch detect
codex-browser-patch detect --plugin-root /absolute/synthetic-plugins --json
```

默认根目录是 `~/.codex/plugins/cache/openai-bundled`。发现规则为 `<root>/{browser,chrome}/<version>/scripts/browser-service.mjs`，枚举所有版本，不选“最大版本”或推断当前运行版本。版本名原样保留，按插件名和版本名词法排序。相对根目录从当前工作目录解析；缺失或空根目录成功返回空集合。不可读、缺失或非文件的目标返回运行错误，并保留其他已发现目标。

每个工件包含绝对 `path` 和规范化 `realPath`。检测可跟随符号链接，但这不表示写操作接受别名。准备拒绝多个条目指向同一规范文件或文件身份；事务进一步拒绝符号链接/硬链接别名及路径身份变化。

从检测结果复制精确的绝对路径。可以重复 `--target`，也可明确选择 `--all-compatible`：

```bash
codex-browser-patch prepare --plugin-root /absolute/synthetic-plugins \
  --target /absolute/synthetic-plugins/browser/example/scripts/browser-service.mjs \
  --target /absolute/synthetic-plugins/chrome/example/scripts/browser-service.mjs \
  --output /absolute/new-review-plan --json

# 另一种选择方式；使用另一个尚不存在的输出目录。
codex-browser-patch prepare --plugin-root /absolute/synthetic-plugins \
  --all-compatible --output /absolute/all-compatible-plan --json
```

没有默认写入目标。两种选择方式不能混用。明确选择的不兼容目标使准备失败；`--all-compatible` 只选择证明兼容的目标，并保留被过滤目标的诊断。发现运行错误时不能静默跳过。准备保持插件不变，不创建操作存储；已有输出路径绝不覆盖，失败不发布可被当作完整方案使用的产物。

审阅输出的 `contents/manifest.json`、局部 diff、原始和补丁工件，以及完成标记 `complete.json`。方案记录目标路径、版本、结构证据、半开 UTF-16 源码区间、局部表达式、大小和前后 SHA-256。变换只替换目标表达式，之后重新解析语法。方案的完整性校验表示内容一致性，不是来源认证或本工具已应用的证明。

审阅后，退出 Codex/ChatGPT 和全部相关 browser-service 工具进程。选择一个专属的绝对操作存储路径：

```bash
codex-browser-patch apply --plan /absolute/new-review-plan --store /absolute/private-store --json
codex-browser-patch status --plan /absolute/new-review-plan --store /absolute/private-store --json
codex-browser-patch status \
  --target /absolute/synthetic-plugins/browser/example/scripts/browser-service.mjs \
  --target /absolute/synthetic-plugins/chrome/example/scripts/browser-service.mjs \
  --store /absolute/private-store
codex-browser-patch restore --plan /absolute/new-review-plan --store /absolute/private-store --json
```

所有操作命令必须显式给出 `--store`；apply/restore 只操作该方案中的目标。存储由当前用户拥有，权限必须为 `0700`，路径必须规范化；不存在时工具创建。保留该存储、验证过的备份和目标旁 `.codex-browser-patch.lock` 的后继历史，它们用于来源证明、跨存储排他及中断恢复。不要手工删除锁来绕过未完成事务。

apply/restore 在第一次目标写入前，验证全部目标、方案工件、备份、来源记录、相关进程和未完成事务。准备后发生外部修改或升级会导致拒绝覆盖。已知状态可重复操作，分别返回 `already-applied` 或 `already-original`。仅有类似补丁的代码形状不能证明本工具来源；未知内容始终受到保护。

进程检查通过 `ps` 快照核对应用可执行文件及工具命令身份。枚举失败时拒绝写入；发现相关进程时返回信息，由用户退出，工具不结束进程。快照之后仍可能启动新进程，也不能排除外部更新器。

## restore 与 recover

`restore --plan ... --store ...` 是普通事务：把可信的工具补丁恢复到方案中的已验证原始内容。

`recover --store ...` 只处理未完成事务：将每个目标回滚到**该次操作开始前的实际状态**，绝不继续 apply 或 restore。

```bash
codex-browser-patch status --plan /absolute/new-review-plan --store /absolute/private-store --json
codex-browser-patch recover --store /absolute/private-store --json
```

apply 中断通常回到 original；restore 中断通常回到 tool-applied。混合状态逐目标恢复，已知无操作项保留其原状态。普通 apply/restore 在恢复完成前被阻止，包括使用其他存储的操作。status 会报告完整未完成组和所属存储，即使只查询其中一个目标；必须使用所属存储运行 recover。

恢复先验证整个组。任一目标出现未知外部内容，就保留所有目标和事务记录并报告冲突。不要把这类冲突当作可强制覆盖的提示。没有未完成事务时 recover 成功返回 `NO_INCOMPLETE_TRANSACTION`。

事务先持久记录恢复所需的意图和私有备份，再逐文件原子替换，并校验写后内容。存储锁先于按规范路径排序的目标旁锁；跨存储操作共享目标排他。文件及父目录执行 fsync。整个多文件组**不是一次文件系统原子交换**；后续目标写入失败时回滚实际已变化的目标，回滚失败保留显式恢复证据。

锁发布使用完整记录的不可覆盖硬链接。若在 link 与临时名 unlink 之间中断，读取只接受同目录、私有、同 inode 的唯一 `.publish-<UUID>` 临时名；不删除这个历史证据，仍验证 owner 生死和其事务，无法解释的硬链接继续拒绝。没有发布事务意图的死 owner 可由下一次普通写操作安全接替；recover 此时返回 `NO_INCOMPLETE_TRANSACTION`。

历史方案与备份校验不要求终态目标仍存在。删除已完成或已恢复的旧版本，不会阻止另一个版本的 status/apply/recover；实际选中或待恢复的目标仍必须通过当前路径、文件身份、内容与父目录校验。损坏历史工件或认证失败仍会阻止操作。

SIGKILL 恢复根据实际 before/after 内容判断，覆盖替换完成但日志尚未更新的窗口；恢复本身也可再次中断后重试。这些自动化证据不等同于断电耐久性保证，也不能阻止外部更新器。存储 HMAC 将操作来源记录与可编辑方案分开；能读取私有密钥的同用户恶意修改不在此本地信任边界内。

## 输出与自动化

人类输出与 JSON 使用同一结果模型。`--json` 将一个 JSON 对象及换行写到 stdout，包括命令错误。`--help` 返回纯文本；自动化应检查退出码及字段，不解析人类文案。

```json
{
  "schemaVersion": 1,
  "command": "status",
  "outcome": "success",
  "exitCode": 0,
  "diagnostics": [],
  "data": {
    "store": "/absolute/private-store",
    "transaction": null,
    "operation": null,
    "targets": [{"path": "/absolute/plugin/scripts/browser-service.mjs", "state": "original"}],
    "groupState": "complete",
    "pendingTransactions": [],
    "runtime": "not-verified"
  }
}
```

示例用于说明字段；具体诊断因命令与环境而异。错误时 `data` 可为 null，未识别命令的 `command` 为 null。诊断包含 `code`、`severity`、`message`，可附 `path`、`systemCode` 及源码 `range`。schema 1 可增加字段与诊断代码；不兼容改动需要新 schema。

| 退出码 | outcome | 含义 |
| --- | --- | --- |
| 0 | `success` | 命令成功，包括空发现、已知状态、无待恢复事务；status 的已知 incomplete 状态也可为 0。 |
| 1 | `runtime-error` | 平台不支持、读取/进程枚举/文件写入失败，或回滚失败。 |
| 2 | `usage-error` | 参数、目标选择或输出路径不合法。 |
| 3 | `incompatible` | 结构无法证明，包括 detect 的兼容/不兼容混合结果。 |
| 4 | `conflict` | 外部修改、来源/方案/备份冲突、运行进程、锁或未完成事务阻止普通写入。 |

detect 的运行错误优先于不兼容，仍保留可用的逐目标结果。不可用工件为 `availability: "unavailable"`、`compatibility: "not-analyzed"`；可读工件附结构分析及证据。

status 的目标状态为 `original`、`tool-applied`、`incompatible`、`conflict`、`incomplete`。成功的写操作还包含 `action`，例如 `applied`、`restored`、`rolled-back`、`already-applied`、`already-original`。

| 状态字段 | 含义 |
| --- | --- |
| `data.targets` | 精确的方案或重复 `--target` 选择，保持选择顺序。 |
| `data.groupState` | `complete`、`incomplete`、`conflict` 或 `incompatible`。待恢复组冲突优先，其次 incomplete，再次 incompatible。 |
| `data.pendingTransactions` | 当前存储及选中目标旁锁发现的完整未完成组，包含所属 store 和全部成员。 |
| `targets[].pending` | 所属 store/transaction/operation、实际 `before`、`desired`，以及 `current`: `before`、`after`、`before-and-after` 或 `unknown`。 |
| `data.transaction`、`data.operation` | 恰有一个待恢复组时的简写；没有或存在多个组时为 null。 |

status 对发现的待恢复冲突返回 4；否则所选目标不兼容返回 3；已知状态包含 incomplete 返回 0。即使全部字节已回到 before，只有经过认证的终态日志才能完成恢复。`runtime: "not-verified"` 始终独立于文件成功；磁盘哈希不能证明模块重载、缓存刷新、宿主完整性接受或网站操作成功。

## 有限结构支持：site-status-v1

结构兼容性依据 AST、作用域绑定及消费链证明，不依据版本白名单、完整文件哈希或压缩变量名。不执行被分析源码。首版只接受一个完整且唯一的链：

1. 模块级单参数函数使用未被遮蔽的全局 `URL` 构造 `https://chatgpt.com/backend-api/aura/site_status`，设置 `site_url`，仅返回 `{endpoint: url.toString()}`。
2. 模块级 async transport 原样传递 runtime、endpoint、options，返回 `await runtime.fetch(endpoint, options)`。
3. async 类方法以 `request.endpoint` 和 `{method: 'GET'}` 调用 transport，对 `!response.ok` 抛错，等待 `response.json()`，将简单响应标识符传给 agent 判定器。
4. 同步模块函数返回 `genericPredicate(body, agentKey)`。key 为字面量 `'agent'` 或类定义前直接初始化的模块级 const。通用判定器对非对象返回 false，读取 `feature_status`，返回 `isObject(features) ? features[key] === true : false`。两处对象判断必须解析到同一个 `typeof value === 'object' && value != null` 函数；支持 typeof 的 `==`、null 的 `!==` 及压缩布尔值 `!0`/`!1`。
5. 第二个 async 方法等待上述方法并仅返回 `{blocked}`；第三个由 site 参数构造请求，以相同 runtime/request 绑定调用第二个方法，并在 `result.blocked` 时抛错。方法调用必须属于同一类的 `this` 和静态方法名。

参数和相关局部绑定必须是单一定义、未重赋值的简单标识符。函数和类必须是模块级声明；函数绑定只作为直接被调用者使用。类不支持继承、构造器、字段、访问器、static 或 computed 方法。读取支持点属性及静态字符串 computed 属性；对象字面量键必须为静态非 computed 字段。对象判断沿用 JavaScript 语义，包括数组，不引入更严格的响应 schema。

类恰含上述三个方法。相关类的每次引用必须是无参数 `new`，所得实例只能直接调用入口方法，或存入未重赋值的 const 后直接调用入口方法；静态字符串 computed 入口读取也可使用。拒绝子类、原型读取、方法提取、`.call`/`.apply`/`.bind`、类或实例别名、对外传递及导出，避免把动态 this 当作声明类的实例。

调用和环境能力采用封闭证明：源码中的调用只能来自已证明的链体或已验证的实例入口调用；构造只接受链内 URL、上述实例和单个字符串字面量参数的未遮蔽 Error。拒绝其余调用、import/export、动态 import、tagged template 和环境全局引用。这样同时拒绝反射能力的别名、解构及动态属性绕过，无需执行源码。证明假定宿主提供标准 URL/Error 和约定的 runtime fetch/JSON；不证明宿主被外部代码修改后的行为。

额外链内语句、解构、内联/拆分判定器、动态 key、嵌套或表达式类及其他控制流均不支持。两个完整链是歧义；完整链旁另有无法证明的 `.blocked` 消费也拒绝。无消费链且无未知调用或环境能力的相似函数不会成为目标。源码中任意属性赋值/更新/delete、eval 或已识别的反射修改都会被拒绝，即使看似无关。

解析失败、缺失证据、作用域遮蔽、绑定逃逸、语义改变和已知补丁形状均有结构诊断，例如 `PARSE_ERROR`、`NO_TARGET`、`AMBIGUOUS_TARGET`、`UNSUPPORTED_CHAIN`、`UNSUPPORTED_INITIALIZATION`、`CHANGED_SEMANTICS`、`UNTRUSTED_PATCHED_SHAPE`。无法证明时停止，不退回字符串替换。

纯源码边界 `analyzeSource(source)` 返回兼容性、证据、诊断及唯一 target；`transformSource(source)` 局部变换后重新解析。区间单位为 JavaScript UTF-16 code units，半开区间，可用于 `source.slice(start, end)`，不是 UTF-8 字节偏移。变换保留原响应及其他 feature，只改变此处 agent 消费。用户授权、企业策略、协议检查、侧栏评论模式等不在作用范围内。

**延迟模式完整证明：** `site-status-deferred-v1` 独立验证有限一次性初始化、拆分请求来源、同一 HTTP/JSON 响应、严格 agent 判定、构造器默认时钟与 metadata accessor、类/实例 receiver、缓存/inflight 及实际 policy 的 `result.blocked` 消费。只有八类 UTF-16 证据和相关影响检查全部通过、目标唯一时，detect 才报告 compatible；transform/prepare 仅替换该 JSON 响应实参，构造局部浅副本并固定嵌套 agent 为 false。部分链、未知形态及歧义继续拒绝；同文件出现另一个旧模式或未知 blocking 类也拒绝。

纯旧模式选择继续生成原格式 `formatVersion: 1` / `patternVersion: site-status-v1`，保留历史五项证据契约。任何含 deferred 的选择（包括混合旧/新目标）使用 `formatVersion: 2` / `patternVersion: site-status-selection-v1`，每个目标明确记录自己的 `patternVersion` 和相应有序证据。加载时重新分析原文并核对逐目标模式、证据、区间、补丁及局部差异；未知或不匹配的身份拒绝，重算哈希不能代替结构重推导。状态诊断沿用可信事务记录；单有响应副本形状不证明工具应用。

该证明信任标准宿主 URL、Map、Date、Promise、JSON 等内建能力、约定 runtime.fetch/response.json 接口及 Node 标准模块按约定工作，不递归审计所有依赖。当前文件中可能影响相关链的修改、反射、原型/别名写入及未知逃逸仍须拒绝，外围代码位置不构成无关性证明。相关类只接受唯一直接构造的本地实例、已证明的方法和状态字段；继承覆盖、方法借用/提取和未知接收者拒绝。

**缓存与运行边界：** 每次调用先启动新请求，再查询旧缓存或旧 inflight promise；命中时为丢弃的新请求处理拒绝。新结果按完成时钟记录，24 小时到期，仅清理同一 inflight promise。修改磁盘副本不会立即清除已缓存的禁止结果，也不证明运行中模块已经重载。真实宿主加载、完整性接受、缓存清除和网站操作继续为 `not-verified`。

**指定真实样本仍阻塞：** 两份 `26.1013.31256` 实际工件中的 `globalThis` 可经本地句柄桥交给 ZXing 资源。用户已批准 [ADR 0003](docs/adr/0003-specific-zxing-dependency-contract.md) 的特定资源生命周期非干扰契约，以及 [ADR 0004](docs/adr/0004-specific-ambient-property-premise.md) 的特定初始化环境属性前提；二者都是明确接受的外部语义假设，不是对实际资源行为或 live 属性描述符的验证。

纯源码边界可接收显式依赖证据 `analyzeSource(source, dependencyEvidence)` / `transformSource(source, dependencyEvidence)`。当前检查点核对封闭契约、实际字节身份、二进制接口和有限加载/回调来源；`registeredContract` 仅表示资源身份及接口匹配。JavaScript glue 的句柄、描述符、调度、消费及生命周期证明尚未闭合，`acceptedContract` 仍为空，提供依赖证据时也保持 incompatible、无目标和无变换。CLI 依赖解析及依赖方案支持尚未交付。相关源码效果继续检查，不能凭资源摘要、函数区间或生成代码标记获得豁免。

合成完整证明不能替代两份真实工件的最终 detect/prepare 静态验收。真实源码和资源仅作数据读取与解析，不执行、import、编译或实例化，不修改安装；运行时继续 `not-verified`。

## 开发与验证

在干净检出或尚无 `node_modules` 的检出中，先安装依赖。缺失依赖导致 `tsc: command not found` 是环境未准备，不是构建通过。

```bash
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run build

# 单独重跑已安装产物回归；npm test 已包含它。
npm run test:package
```

`npm test` 构建并运行纯源码及真实 CLI 子进程测试。所有核心样例均为可分发合成源码，使用临时插件根目录、独立 home/store；不需要 Codex，也不因缺少 Codex 跳过。旧 Python 测试不作为正式验收。

`tests/package.test.mjs` 无生产源码相对导入：实际 npm pack、在临时 prefix 离线安装、直接执行公开 bin，覆盖帮助、human/JSON、目标选择、退出码 0/1/2/3/4、多目标往返、回滚失败、SIGKILL apply/restore 及再次中断 recover。测试先在 dist 放入合成本机状态哨兵，验证它被包白名单排除。安装子进程从临时目录运行且清空 `NODE_PATH`、`NODE_OPTIONS`，运行依赖来自 tarball。

安装产物回归还覆盖反射别名和动态接收者的 detect/prepare 拒绝、store/target 首次及后继/释放锁发布 link-unlink 窗口的 SIGKILL 重试，以及删除终态旧版本后另一个版本的普通操作与 pending recover。

macOS 身份和可控 `ps`/文件系统边界仅通过显式外部 `node --require tests/fixtures/*.cjs` 注入测试子进程。预加载 fixture 不进入 tarball，生产 CLI 不提供平台、进程检查或故障注入绕过选项。权限测试需要非 root 执行用户。

GitHub Actions 在无 Codex 的 Linux/macOS 上，以最低 Node **22.13.0** 和 Node 24 运行依赖安装、类型检查、静态检查、全部测试（含安装产物验收）及构建。本地结果及证据边界见仓库内 [交付验证记录](reports/package-verification.md)；该报告不进入 npm 包。

## 历史 Python 研究原型

`scripts/site_status_patch.py` 保留为针对固定旧样本的研究原型，**不是正式 CLI**。它使用固定版本/哈希与字节锚点，其测试依赖历史本机副本，可能跳过；不能作为新 CLI 的兼容性或真实运行证据。不要按旧脚本流程替代上述方案与持久事务流程。

研究资料保留在仓库，不进入 npm 分发：

- [网站限制逆向报告](reports/codex-browser-restrictions.zh-CN.md)
- [历史静态证据](reports/static-evidence.md) 与 [结构化证据](reports/static-evidence.json)
- [Python 研究原型](scripts/site_status_patch.py) 与 [历史测试](tests/test_site_status_patch.py)
- [结构兼容性决策](docs/adr/0001-structural-compatibility.md)
