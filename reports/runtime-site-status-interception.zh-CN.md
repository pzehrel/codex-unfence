# 运行时改写 Codex 浏览器站点状态响应：可行性研究

日期：2026-10-18。范围：用户本机软件自定义的只读研究；不实现拦截。

## 结论与证据强度

**可以把“在判定前令 `feature_status.agent` 为 `false`”作为运行时方案的设计目标，但目前不能认定它是这个安装版本可用的替代方案。** 已有指定样本调查表明，插件通过传入的 `runtime.fetch` 请求站点状态，再检查 HTTP 成功、解析 JSON，最终仅把严格的 `agent === true` 判为禁止。若确实控制了这条链上、缓存判定之前的新响应，改变该字段会改变这一次新结果。这里的前提仍未在真实宿主中验证。[L1]

最关键的缺口不是 JSON 如何改，而是：**谁创建 `runtime`、谁实现它的 `fetch`、请求在哪个进程联网，以及用户能否在首次使用前控制那个入口。** 本地证据没有闭合这些关系。官方文档和开源代码能证明普通 Node preload、MCP 启动配置、部分 Codex HTTP 客户端的代理与 CA 支持；不能证明专有浏览器插件继承这些入口。[L1][O1–O6]

**推荐顺序：先做有明确停止条件的入口核对；若确认可控制同一上下文的 `runtime.fetch`，优先评估窄请求包装；暂不优先开发私有函数替换或 HTTPS 中间代理。** 这是一项后续验证建议，不是已可用承诺。切换路线会改变现有保证边界，需要单独决定。[L4–L6]

| 证据层 | 本次能支持的结论 | 不能支持的结论 |
| --- | --- | --- |
| 指定版本历史只读调查 | 请求、解析、判定、缓存及模块导出的结构线索 | 当前运行进程、当前真实请求、可注入入口 |
| 官方文档、固定提交的开源代码 | 各机制及配置在其明确范围内存在 | 专有插件使用同一网络栈，或安装版本具有相同行为 |
| 当前文件状态 | 四个指定安装文件仍缺失；未换样本 | 真实静态验收完成、任何运行时路线已验证 |

指定对象为 browser/chrome `26.1013.31256` 的 `scripts/browser-service.mjs` 和相邻 `zxing_reader.wasm`。原 service 身份为 1,462,840 bytes、SHA-256 `67f78205a36436e511de3687c104d10d39d91784593bb885883439ef8f2236bd`。历史记录不能替代当前验收；2026-10-18 的缺失记录和本次只读存在性复核均为四文件 `ENOENT`。未选择 `latest`、其他版本或恢复安装。[L1][L2]

本地实现检查点是 `77a23b14988e35973bf180867bef1de9f1ffe913`，已有 334 项检查通过记录；真实路径验收仍未通过，依赖证明的 `acceptedContract:null`、`incompatible`、`target:null` 与 `runtime:not-verified` 状态不能被本研究改写。本次未重新运行产品测试。[L3]

## 实际架构：已知与未知

### 请求的逻辑发起者已经定位，物理联网者没有定位

指定版本的历史调查记录了以下关系：[L1]

- `browser-service.mjs` 构造 `https://chatgpt.com/backend-api/aura/site_status` 的 GET 请求。
- 参数包含目标 `site_url`、`url_request_source`，以及可选 conversation/turn 上下文。目标 URL 保留 origin、path、query，不包含凭证或 fragment。
- 运输包装检查传入对象的 `fetch` 是否为函数，随后保留 receiver 调用它。该包装**不是证明调用了 `globalThis.fetch`**。
- 同一个响应先检查 `ok`，再调用 `json()`；判定只读 `feature_status.agent` 的严格布尔值。
- service 存在 Node 标准模块导入，导出为 `classifyError` 和 `handleRpc`。这些线索支持服务/桥接设计，不能单凭它们断言实际进程拓扑。

| 对象 | 可以确定 | 仍缺证据 |
| --- | --- | --- |
| Codex CLI | 当前官方 npm 入口是 Node 启动器，随后 spawn 平台原生 `codex` 可执行文件。[O1] | CLI 启动器的 JavaScript 修改是否能到达桌面浏览器服务；没有证据。 |
| Codex 桌面应用 | 当前官方文档把内置浏览器列为桌面/Web 功能；CLI/IDE 不提供该浏览器表面。[O7] | 原批准安装版本如何启动服务、使用何种 Node/其他运行时、如何转发认证请求。 |
| browser-service | 历史指定样本中，站点状态链调用注入的 `runtime.fetch`。[L1] | `runtime` 的构造点、能力注册、IPC/RPC 对端及最终 HTTP 客户端。 |
| 网页页面上下文 | CDP 的 Fetch 域可拦截其浏览器目标中的请求。[O8] | 页面请求是否包含这次站点状态查询；没有证据证明属于同一上下文。 |

因此，在网页内替换 `window.fetch`，或在 npm CLI 启动器内替换全局 `fetch`，**都不能据现有证据推出会影响插件查询**。普通 Node 全局 `fetch` 基于 Undici，并支持 dispatcher；这也不说明注入的 `runtime.fetch` 使用它。[L1][O1][O6]

当前官方浏览器文档描述了用户批准的 Full CDP 能力；CDP 协议也确实提供响应暂停、读取及 `fulfillRequest`。但“产品有 CDP”不等于“存在可连接的服务调试端口”，也不等于“这个请求归属该 CDP target”。本次没有启动或连接调试接口。[O7][O8]

### 缓存会让“响应已改”与“本次判定已变”分离

指定样本每次先启动新请求，再检查旧缓存和进行中的请求。有效缓存可直接返回旧结果；这条分支丢弃的新响应不会刷新旧缓存。历史 TTL 为 24 小时。因此，安装运行时包装、看到改写响应，仍不足以证明当前命令采用了它；已有缓存和旧 promise 必须纳入后续验证。不得用故意制造 HTTP/JSON 错误来替代响应字段改写。[L1][L4]

## 三条运行时路线与磁盘补丁对照

| 路线 | 必须满足的前提 | 当前实际可行证据 | 脆弱点与作用范围 | 回滚成本 |
| --- | --- | --- | --- | --- |
| **A. 请求接口包装**：包装真实 `runtime.fetch`，仅调整目标成功响应 | 首次使用前能在同一上下文取得/提供 runtime；入口持续生效；保留 receiver、异步、HTTP/JSON 与原错误语义 | 已定位插件调用接口；普通 Node 有 preload。**未证明内置插件有受支持入口**。[L1][O2–O4] | 若运行时转发到宿主，修改全局 fetch 无效；已捕获旧函数、独立 realm、重建 runtime 均可能失效。包装响应影响所有通过该包装读取的匹配消费者。 | 移除加载配置并重新建立相关运行时；旧模块、缓存和 promise 可能仍在。实际卸载方式未知。 |
| **B. 运行时函数/实例替换**：改判定器或实例方法 | 能取得私有绑定、实例或真实 inspector 执行上下文；在正确时序替换 | 指定样本实例及判定器为模块局部绑定；未发现实例导出或词法别名。[L1] **无外部替换入口证据**。 | 私有名称随打包改变；暂停点、初始化顺序、引用捕获及缓存状态均敏感。方法替换可能扩大到所有调用者，绕开原链语义。 | 需恢复精确原函数，或重建运行时；调试会话与缓存清理另计。 |
| **C. HTTPS 本地中间代理**：终止 TLS 后改 JSON | 实际请求经过代理；对应网络栈信任其 CA；没有阻止中间代理的额外认证/pinning；可精确识别目标 | 官方 Codex 部分 HTTP/WebSocket 客户端支持代理/CA；**未证明覆盖该 `runtime.fetch`**。[O5][O9] | CONNECT 隧道本身不能改 HTTPS 正文；需真正 TLS 中间代理。独立网络栈、代理绕行、证书策略及 HTTP 编码处理仍未知。匹配过宽会影响其他 ChatGPT 流量。 | 移除代理路由、信任配置及本地密钥/证书材料，重建相关连接；操作面大于 A。 |
| **现有插件文件补丁**：只改唯一判定调用的局部响应副本 | 指定工件存在；满足有限结构证明与已批准前提；通过方案及文件身份校验 | 实现与合成检查存在；**指定真实工件尚未验收**。[L3][L4] | 打包结构与依赖证明成本高；安装更新可覆盖；已加载模块/旧缓存不立即改变。目标范围是一个消费点。 | 已有备份、身份校验与恢复事务设计；仍须处理文件冲突和模块重载。[L7] |

### A：有 Node preload，不代表有 Codex 插件 preload

普通 Node 官方支持 `--require`、`--import` 和 `NODE_OPTIONS` 中的允许选项；preload 可在应用模块前执行。这给出了一种机制，前提是**真正执行目标模块的 Node 进程**接受对应启动选项。[O2]

官方 MCP 文档提供普通 stdio server 的 `command`、`args`、`env`、`env_vars`。但插件提供的 server，其 transport 由插件 manifest 管理；用户覆盖项是启用、认证/工具策略等。固定官方源码明确把插件 policy overlay 与 launch transport 分开。因此，“配置自己的 MCP server”不能直接当作“给内置浏览器 server 加 preload”的受支持方法。[O3][O4]

固定官方 MCP 子进程代码也不是无条件继承整个环境：Unix 默认名单没有 `NODE_OPTIONS` 或代理变量；显式 `env_vars`/`env` 与 CA 变量另行处理。即使某变量能显式传入，还必须确认内置插件使用这个启动路径、配置可持续生效、具体运行时接受该变量。[O4]

Codex hooks 的公开事件处理器是外部命令或已连接 MCP 工具调用；其工具反馈能力不等于替换浏览器服务内部 HTTP 响应。未找到文档承诺 hook 在该服务初始化前、同一 JavaScript 上下文运行。[O10]

此外，Electron 官方对打包应用中的 `NODE_OPTIONS` 有严格限制，`nodeOptions` fuse 也可能使其被忽略。此事实只说明不能套用普通 Node 推论；**没有核验指定 Codex 应用的 Electron 版本、fuse 或独立子进程设置**。[O11]

### B：闭包限制是实际门槛

ES 模块绑定保存在模块环境中，不能假设它们是 `globalThis` 的属性。指定样本历史导出只有错误分类和 RPC 入口；目标 class/实例未发现导出。因而，外部脚本不能仅凭压缩函数名访问并重新赋值这些绑定。拿到导出 `handleRpc` 也不等于拿到内部判定实例。[L1][O12]

这不证明调试器永远不能访问局部状态，而是说明这种方案需要额外证明：目标进程有可用 inspector、可选中正确上下文/暂停点、替换时机正确且宿主允许。已有 Full CDP 文档不补足这些证据。本次没有探测端口或连接宿主。[O7][O8]

### C：官方代理支持的范围必须分开看

1. **Codex 客户端 HTTP/WebSocket**：官方认证文档说明 `CODEX_CA_CERTIFICATE`，无值时回退 `SSL_CERT_FILE`，覆盖其 login、普通 HTTPS 和 secure WebSocket。固定开源实现给使用该 helper 的 reqwest/rustls 客户端加载 CA；直接创建其他客户端会绕过它。出站代理工厂有默认行为与启用系统代理解析两类策略，启用时支持系统解析、环境回退及直连回退。这不证明专有插件使用该工厂。[O5][O9]
2. **sandbox 命令网络代理**：官方 permissions 文档明确，其域名策略代理只控制 sandbox 内本地命令；浏览器动作、MCP、客户端服务请求等有各自控制面。不能把 `permissions.<name>.network.proxy_url` 当成覆盖站点状态查询的保证。[O13]
3. **Node 自己的网络栈**：官方 `NODE_USE_ENV_PROXY`/`--use-env-proxy` 和 `NODE_EXTRA_CA_CERTS` 有版本与启动时机条件；后者在启动时读取，显式 `ca` 可绕过默认与额外根证书。插件实际运行时版本及是否使用 Node fetch 未知。[O2][O6]

正向代理的 CONNECT 成功后建立双向盲转发隧道；端到端 TLS 下，代理不能仅靠转发就读取并改写 JSON。响应改写要求在中间终止 TLS、建立另一侧连接，并被实际客户端信任。**当前没有证据证明目标无 pinning、沿用系统证书库，或接受上述 CA 变量；也没有证据证明它存在 pinning。** 两者都应标为未知。[O14][O5]

固定官方 `codex-network-proxy` 源码已有管理 TLS 中间代理功能，但公开 MITM action 类型提供的是请求头删除/注入；没有在所查 action 接口中找到 JSON 响应体改写配置。它不是现成的目标字段改写开关；其存在也不改变上述流量范围边界。[O15][O13]

代理还可能扩大作用范围：旧版独立调查曾发现桌面侧栏评论模式也查询同一路径并读取相同字段。此观察属于 `26.1007.71326`，**不作为指定版本架构证据**；它只说明设计时不能默认“同域名、同路径就是同一插件消费点”。仅按 host/path 改响应，比现有局部消费点补丁的保证更宽。[L8]

## 最小后续验证与停止条件

以下仅为计划；本研究未执行宿主或流量验证。

### 1. 先恢复可核对的研究对象，保持只读

由用户确认原授权样本副本或原版本是否可取得。核对两份 service 与相邻资源身份、适用 manifest/client、运行时入口配置。只追踪一条链：**服务模块加载者 → runtime 构造者 → fetch 实现 → IPC/RPC 对端 → 实际 HTTP 客户端**。不扩大到通用静态分析器。[L1][L2][L4]

**停止条件**：指定对象不存在、身份改变，或只能取得其他版本。报告阻断并重新确认身份基线；不选 latest、不自动恢复安装、不把其他版本源码当原样本。[L4]

### 2. 只验证一个最有希望的入口

若只读证据表明存在用户可控、受支持的同上下文入口，先为 A 写清启动时序和作用域。后续可用自行编写的微型服务/响应验证：receiver 与参数传递、HTTP 错误、JSON 错误、非目标请求直通、字段外数据保留及卸载。合成验证只能证明包装器自身，不能替代 Codex 实际路径验证。

**停止条件**：入口只影响 CLI wrapper、网页 renderer 或另一个 MCP 进程；变量被过滤/不支持；需要修改安装或依赖未确认的调试口。此时不继续“先写一个 preload 试试”。

### 3. 真实宿主阶段另行授权，先观察，再决定是否改写

若用户之后批准运行验证，先证明哪个进程/网络栈发起一个新查询，以及入口确实在首次使用前生效。记录最少元数据，不保存认证头、cookie、conversation/turn 明文或完整目标查询。随后才考虑一次窄范围字段改写实验；保留服务器请求、HTTP 状态、解析错误和非目标流量，记录旧缓存/旧 promise 是否参与。[L1][L4]

A 不成立时，C 的下一个验证目标也应是“请求能否经过指定代理并通过受支持 CA 配置完成 TLS”，而非立即部署 JSON 改写。B 仅在已证实有受支持调试上下文且用户选择接受维护成本时再研究。

**共同停止条件**：不能归因实际请求、无法隔离其他流量、需要关闭证书校验、只有请求失败后放行、只有旧缓存结果、出现不可回滚配置，或需突破当前未授权的宿主操作范围。出现这些情况不能报告替代成功。

## 切换路线前需要的决策

现有 ADR 0001–0004约束结构兼容、相关链证明、特定 ZXing 依赖契约与窄环境属性前提。它们没有授权运行时注入、修改代理/CA、调试宿主或扩大消费范围。[L5][L6]

需要明确决定：

- 是否把交付从“有限静态证明后生成局部文件变换”改为“限定版本/入口的运行验证与持续维护”。运行时入口减少打包结构耦合，不会自动证明相同的语义保证。
- 改写范围是否仍只针对插件站点状态的新响应；是否接受其他消费者看到改写值。若选代理，需说明调用者隔离不足时的处理方式。
- 失败、未知字段、更新、重建 runtime、缓存与并发请求如何处理；保留错误与原行为，不能把网络失败视为成功。
- 是否授权下一阶段运行宿主、加载自定义代码或配置局部代理/信任材料；明确配置恢复、密钥材料清理与可审阅验证记录。

**目前最合理的工程投入是补齐入口证据，而不是继续扩大静态证明器，也不是立即实现劫持。** 在这些证据出现前，运行时方案与当前磁盘方案都应继续标记真实运行未验证。[L3]

## 来源

本次仅读取既有本地材料、复核固定路径存在性并检索官方资料。未执行/import 真实 bundle，未执行/编译/实例化 Wasm，未改安装、代理、证书或用户配置，未启动/重启/终止 Codex，未连接调试口，未请求站点状态接口，未修改 tracker、commit、push 或 PR。报告未复制专有源码。

本地引用属于历史静态观察或项目决策。临时目录来源仅在本机可复核。官方开源代码固定于 `openai/codex@7b44ac1661433ae3a6f375fde873fa7123c935fe`（提交时间 2026-10-17），与专有插件及已安装宿主**不是同一个被证明对象**。官方网页为 2026-10-18 读取的当前文档；部分原 developers 地址重定向至 ChatGPT Learn。

- **[L1]** [指定样本只读调查](/tmp/codex-spec-1.AVikSX/current-real-samples.md:13)，身份 13–18 行；请求/包装/私有实例/缓存/导出 24–40 行；运行证据限制 42–57 行。原样本源码坐标保存在该记录中。
- **[L2]** [固定样本缺失记录](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/.scratch/spec9-real-acceptance/missing-fixed-samples.json:1)，四个路径及 ENOENT。研究中另以只读存在性检查复核相同四路径，结果一致。
- **[L3]** [实现检查点](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/.scratch/spec9-real-acceptance/checkpoint-report.md:5)，候选、334 项检查记录、未闭合条件与缺失样本，尤其 23、34–44 行。
- **[L4]** [真实插件适配的已确认范围](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/design/real-plugin-adaptation.md:9)，特别是 12–20、35–41 行；本地提交 `77a23b1`。
- **[L5]** [ADR 0001](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/adr/0001-structural-compatibility.md:3)、[ADR 0002](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/adr/0002-relevant-chain-proof-boundary.md:3)；本地提交 `77a23b1`。
- **[L6]** [ADR 0003](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/adr/0003-specific-zxing-dependency-contract.md:3)、[ADR 0004](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/adr/0004-specific-ambient-property-premise.md:3)；本地提交 `77a23b1`。
- **[L7]** [现有工具的应用、恢复与运行验证边界](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/README.md:54)。具体文件事务保证见该文档对应章节；本地提交 `77a23b1`。
- **[L8]** [2026-10-16 独立旧版本调查](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/reports/codex-browser-restrictions.zh-CN.md:11)，版本身份 11–21 行；侧栏独立查询 141–147 行。仅作历史旁证。
- **[O1]** OpenAI：[npm CLI 启动器](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-cli/bin/codex.js)，`findCodexExecutable`、`spawn(binaryPath, ...)`。
- **[O2]** Node.js：[preload、NODE_OPTIONS](https://nodejs.org/api/cli.html#node_optionsoptions)、[--import](https://nodejs.org/api/cli.html#--importmodule)、[--require](https://nodejs.org/api/cli.html#-r---require-module)、[NODE_USE_ENV_PROXY](https://nodejs.org/api/cli.html#node_use_env_proxy1)、[NODE_EXTRA_CA_CERTS](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)。当前文档列出代理开关的版本条件；不能当作目标运行时版本证据。
- **[O3]** OpenAI：[MCP 官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，stdio 配置及 plugin-provided server policy 范围。
- **[O4]** OpenAI：[PluginMcpServerConfig](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/config/src/types.rs#L1139-L1179)；[普通 MCP transport 字段](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/config/src/mcp_types.rs#L365-L377)；[MCP 环境构建](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/rmcp-client/src/utils.rs#L16-L57)及[Unix 默认名单](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/rmcp-client/src/utils.rs#L162-L175)。
- **[O5]** OpenAI：[认证与自定义 CA 文档](https://learn.chatgpt.com/docs/auth)；[custom_ca.rs](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/http-client/src/custom_ca.rs#L165-L199)，含绕过 helper 的限制。
- **[O6]** Node.js：[全局 fetch 与 dispatcher](https://nodejs.org/api/globals.html#fetch)。
- **[O7]** OpenAI：[浏览器官方文档](https://learn.chatgpt.com/docs/browser?surface=app)，产品表面与 Full CDP 的批准和控制范围。
- **[O8]** Chromium：[固定版 Fetch 协议](https://github.com/ChromeDevTools/devtools-protocol/blob/a07da3c859be8526571a69be9c1f3c6e91cc0a26/pdl/domains/Fetch.pdl#L7-L34)，[enable / fulfillRequest](https://github.com/ChromeDevTools/devtools-protocol/blob/a07da3c859be8526571a69be9c1f3c6e91cc0a26/pdl/domains/Fetch.pdl#L76-L116)、[getResponseBody / requestPaused](https://github.com/ChromeDevTools/devtools-protocol/blob/a07da3c859be8526571a69be9c1f3c6e91cc0a26/pdl/domains/Fetch.pdl#L164-L234)。协议存在不证明目标请求可见。
- **[O9]** OpenAI：[outbound_proxy.rs](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/http-client/src/outbound_proxy.rs#L1-L5)，[策略选择](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/http-client/src/outbound_proxy.rs#L342-L401)。
- **[O10]** OpenAI：[Hooks 官方文档](https://learn.chatgpt.com/docs/hooks)，handler 类型、生命周期与工具反馈边界。
- **[O11]** Electron：[环境变量 NODE_OPTIONS 及 fuse 限制](https://www.electronjs.org/docs/latest/api/environment-variables#node_options)。只用于条件分析。
- **[O12]** ECMA-262：[Module Environment Records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-module-environment-records)，§9.1.1.5；[NewModuleEnvironment](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-newmoduleenvironment)，§9.1.2.6。
- **[O13]** OpenAI：[Permissions：网络代理及不控制的流量](https://learn.chatgpt.com/docs/permissions#what-the-network-proxy-does-not-control)。
- **[O14]** IETF：[RFC 9110 §9.3.6 CONNECT](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.6)、[§3.7 Intermediaries](https://www.rfc-editor.org/rfc/rfc9110.html#section-3.7)、[§4.2.2 HTTPS](https://www.rfc-editor.org/rfc/rfc9110.html#section-4.2.2)。
- **[O15]** OpenAI：[network-proxy README](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/network-proxy/README.md)；[MITM action 配置类型](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/network-proxy/src/mitm_hook.rs#L26-L51)及[运行时 action 类型](https://github.com/openai/codex/blob/7b44ac1661433ae3a6f375fde873fa7123c935fe/codex-rs/network-proxy/src/mitm_hook.rs#L94-L98)。
