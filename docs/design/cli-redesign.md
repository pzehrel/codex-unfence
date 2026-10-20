# 浏览器补丁 CLI 重构设计

状态：下面保留 2026-10-16 原结构 CLI 的设计背景。2026-10-20 的[规格 #18](https://github.com/pzehrel/codex-browser-liberation-patch/issues/18)新增托管 CUA 结构方案与临时 npm 交互入口；当前普通使用流程见[README](../../README.md)。新旧方案身份与来源验证分开，历史固定配方不因新入口放宽。

## 当前开发与本地交付

Node.js >=22.13.0；无需真实安装即可测试。构建并生成带 bundled 运行依赖的本地产物：

```bash
npm ci --ignore-scripts
```

```bash
npm run build
```

```bash
npm pack --ignore-scripts
```

以 `npm pack` 实际返回的文件名为准。当前版本 `0.2.0` 未公共发布；运行已构建本地包：

```bash
npm exec --offline --yes --package /absolute/path/codex-browser-liberation-patch-0.2.0.tgz -- codex-browser-patch --help
```

新入口按准确安装路径检查、选择和明确确认。准备副本、目标记录、工具版本及可信 store 由 managed 层管理，位于账户主目录的 `Library/Application Support/codex-browser-liberation-patch/`，独立于临时代码和 npm cache。check 完全只读；`support`、`state`、`writeReadiness`、`allowedActions` 与 `runtime` 各有含义。incomplete 时可以只允许 recover，不能用全局 blocked 状态推断 recover 永不可用。新写命令拒绝非 TTY、EOF 自动确认和 `--json` 自动化写入；旧显式语法保留原契约。

### 结构模式与假设

当前新方案只接受有限的专用站点状态模式：请求来源与运输调用、同一响应的 `ok` 与无参 await `json()`、原 body 到 agent 严格 true 判定，再到原缓存／inflight 和对应阻断消费链。相关绑定、接收者与可见写入必须满足模式；未知相关语义、多个候选和额外消费会拒绝。不按变量名、桌面版本或历史整文件哈希准入。

对于包含 ZXing 的关联形态，仅识别同一 local factory 的有限资源加载与解码接口：configure／decoder wrapper 绑定、明确 `./zxing_reader.wasm` 及既有 `node_modules/zxing-wasm/dist/reader/zxing_reader.wasm` fallback、读取字节经 `Uint8Array` 拷贝到 `overrides.wasmBinary`、factory 内两方法 handle table、global-selector arrow 唯一作为 imports slot，并将 imports 关联到同一 factory 的 instantiate／instantiateStreaming（直接或有限 builder）。decoder 等待同一 prepare(factory,...)，再使用同一 module 的 `_malloc`、`HEAPU8`、`readBarcodesFromPixmap` 或 `readBarcodesFromImage`、`_free`。这不是对任意 ZXing 桥的普遍准入。

标准 URL／Map／Date／Object／Reflect／Error／JSON、runtime.fetch 和 response.json 按宿主契约行为；有限终端 formatter、bypass、display、origin、log 和 Error 构造保留原调用与返回用途，但展示和遥测行为不递归审计。文件内可见相关修改仍拒绝。特定资源与桥的核心前提按公开派生结果原文为：

> Only the linked finite ZXing reader resource and host bridge are assumed not to mutate the site-status chain, its configuration or standard capabilities throughout their lifetime; this noninterference is not proved. Resource bytes are not read or executed.

即只对已关联的有限资源与桥假设生命周期非干扰；没有证明完整依赖生命周期，也不读取或执行 Wasm。人类 check 和写前确认都会显示依据与假设。

结构任务在 `9756b61` 上通过 30 个纯行为测试，并仅以数据读取和解析既存历史私有副本：1,938,669 bytes，SHA-256 `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e`，结果为 supported、7 项 evidence，动态 UTF-16 半开范围 `[1084567,1084585)`。该结果由结构任务报告，不代表重新读取当前安装；不执行真实插件或资源，不验证当前安装、签名、宿主加载和网站行为，runtime 仍为 not-verified。哈希与区间仅记录该次样本事实，不成为准入常量。

### 高级旧入口

以下命令继续使用原结构分析、review plan 和显式 store，不会自动转为 CUA 托管方案。所有文件选择用绝对路径，完整说明见 `--help`。

```text
codex-browser-patch detect [--plugin-root DIRECTORY] [--json]
codex-browser-patch prepare [--plugin-root DIRECTORY] --target ABSOLUTE_ARTIFACT --output NEW_PLAN [--json]
codex-browser-patch prepare [--plugin-root DIRECTORY] --all-compatible --output NEW_PLAN [--json]
codex-browser-patch apply --plan ABSOLUTE_PLAN --store ABSOLUTE_STORE [--json]
codex-browser-patch restore --plan ABSOLUTE_PLAN --store ABSOLUTE_STORE [--json]
codex-browser-patch status --plan ABSOLUTE_PLAN --store ABSOLUTE_STORE [--json]
codex-browser-patch status --target ABSOLUTE_ARTIFACT --store ABSOLUTE_STORE [--json]
codex-browser-patch recover --store ABSOLUTE_STORE [--json]
```

`--target` 可重复。`--plan`／`--store` 包括等号形式均触发严格旧解析，缺项、空值、重复和与新参数混搭会拒绝，不回退自动管理。旧固定 CUA 仓库脚本仍使用其原准备与存储入口，见[准备切片](cua-request-wrapper-slice.md)和[应用恢复切片](cua-wrapper-application-slice.md)。未知旧记录不自动迁移或接管。

### 验证边界

```bash
npm run check -- --base <implementation-base>
```

```bash
npm run test:package
```

默认测试包含真实离线 npm exec 本地 tarball、独立 config/cache、外部最终 bin 系统夹具及合成 `.app`。macOS PTY 使用系统 expect，Linux 使用 util-linux script；Linux 通过夹具模拟 macOS 产品边界，核心场景不因无产品安装而 skip。测试不执行真实插件、不发业务请求。包文件逐项白名单并保留安装产物回归；preload、测试、源码、真实材料不进入包。测试通过不表示当前真实 bundle 已支持或运行生效。

以下原设计保留其当时的范围和术语。

## 已确认的产品边界

2026-10-16，用户接受 Q1–Q4：

- 首版为可分发的命令行工具，提供检测、预览、应用、状态和恢复，不加入任务面板或通用扩展系统。
- 正式工具采用 Node.js + TypeScript，建立依赖锁定、构建、类型检查、测试和 CI；Python 分析脚本可保留为研究资料。
- 兼容性依据明确的结构条件，不依据固定版本或整文件已知哈希。哈希用于文件身份、外部修改检测及恢复校验。目标缺失或候选不唯一时停止并输出诊断。
- 首版只承诺 macOS；安装位置发现与补丁核心分离，为其他平台留出适配位置。

## 已确认的补丁与恢复策略

用户接受 Q5–Q8：

- 使用 AST 及作用域绑定关系定位站点状态消费链；通过字段语义、请求来源和消费关系识别目标，不依赖压缩函数名或局部变量名。
- 只替换目标表达式的源码区间，不重新打印整个 bundle。容忍变量改名、引号及空白变化；结构模式不满足或候选有歧义时停止。
- 补丁范围为浏览器工具的站点状态限制，处理发现的 browser/chrome 插件；首版不修改 Electron 主进程中的侧栏评论模式。
- 检测逐一展示发现的插件版本、路径及兼容状态。应用命令明确指定目标或明确选择全部兼容目标，不推断目录名最大的版本就是正在使用的版本。
- 文件补丁状态与运行时已加载状态分别报告；仅凭文件修改成功不能宣布运行时生效。
- 使用操作锁、持久事务记录和逐文件校验。强制终止后，下次运行识别未完成操作并提供恢复。
- 恢复发现升级或用户外部修改时保留现场、报告冲突，避免覆盖未知内容。

## 已确认的运行与交付边界

用户接受 Q9–Q11：

- 应用或恢复补丁前，要求相关 Codex 浏览器工具进程已停止；工具不自动终止进程。检测到相关进程仍运行时，停止写入并列出信息；无法确认时报告检测局限，不声明运行时已生效。
- 使用标准 npm CLI 包组织项目，首版交付本地构建、安装及 npm pack 产物；公共 npm 发布另行确认。
- 自动化测试使用可随仓库分发的精简样例，不依赖真实 Codex 安装。CI 在未安装 Codex 的环境通过。
- 测试覆盖局部变量改名、格式变化、不支持结构、多候选、重复操作、外部修改及事务中断恢复。真实安装样本属于额外兼容性检查。
- “自动化验证通过”“真实插件文件兼容”“真实 Codex 加载并执行成功”分别记录。真实运行时加载和网站操作未测试时明确标记。

## 工程落实方案

以下是已确认边界的具体落实方式；作为整份设计一并确认。

### 组件边界

- 安装发现：枚举允许的 macOS 插件根目录下 browser/chrome 工件，返回实际路径、插件种类和版本元数据；版本号不作为准入条件。
- 补丁分析：输入源码，返回兼容性状态、唯一目标、证据、原始/补丁后内容及摘要；不执行被分析的 JavaScript，也不依赖文件系统或当前安装。
- 事务管理：管理操作锁、备份、清单、日志、逐文件替换及冲突恢复；只操作已明确选择且校验通过的目标。
- 命令入口：解析参数、目标选择和人类可读/JSON 输出，将操作交给组件。参数错误、不兼容、冲突和运行失败使用可区分的非零退出码。

### 命令与状态

- detect：只读枚举并诊断所有发现的工件；允许显式提供插件根目录。
- prepare：明确选择目标或全部兼容目标；生成包含证据、前后哈希、局部差异及备份的可审阅方案，不修改插件。
- apply：引用已生成的方案，先验证所有目标和备份、检查进程及未完成事务，再执行写入。prepare 后出现外部修改即拒绝该方案。
- status：区分未修改、已应用本工具补丁、不兼容、冲突及未完成事务。没有本工具记录时不把未知修改认定为本工具补丁。
- restore：按本工具已校验的备份恢复；发现外部修改则保留现场并报告冲突。
- recover：显式处理未完成事务；首版将工具已完成的修改回滚至操作前状态，不自动继续应用。所有写操作在未完成事务被处理前停止。
- JSON 输出提供稳定的结构化诊断；文件状态和运行时状态分开，不把结构兼容或文件哈希验证当作运行时验证。

### 兼容性与变换约束

- 首版支持明确且有限的 AST 结构模式，验证站点状态来源、响应对象、agent 禁止判定及消费链的绑定关系。
- 无法证明绑定、候选多于一个、相关控制流已超出模式或解析失败时，返回不兼容及诊断。
- 使用目标表达式的源码范围局部替换，保留请求、原始响应及其他字段；对输出进行语法解析验证。
- 不扩大到其他站点策略、用户授权、企业规则或 Electron 主进程。通过站点状态检查后仍可能触发原有下游检查。
- 不以检测失败为理由退回宽松的字符串替换。未来新增结构模式需要相应正反样例和审阅。

### 测试与交付验收

- 自带样例覆盖格式、压缩命名、作用域遮蔽、无关相似代码、多个候选、语义变化和已补丁状态。
- 临时文件系统测试覆盖整套准备、应用、状态、恢复、外部修改、并发锁，以及写入与进程中断的恢复路径。
- CLI 测试覆盖 JSON、退出码、目标选择和拒绝行为；打包检查覆盖 npm pack 产物的本地安装及命令执行。
- CI 运行类型检查、静态检查、测试和构建；发布包排除研究证据、真实应用 bundle、备份及本机方案。
- 真实样本静态验证可执行；修改实际安装、退出用户进程、公共发布及 Git 提交/推送分别需要相应授权。

## 关联资料

- [结构兼容性决策](../adr/0001-structural-compatibility.md)
- [领域术语](../../GLOSSARY.md)
- [当前实现与使用说明](../../README.md)
