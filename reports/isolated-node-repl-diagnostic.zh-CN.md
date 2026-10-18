# 隔离 Node REPL 诊断

日期：2026-10-18。**一次隔离实验成功完成：MCP 握手、工具调用和自写可信 RPC 服务均可用；服务中的 `nodeRepl` 在模块求值时已经冻结，`fetch` 是不可写、不可配置的自有数据属性。普通用户上下文没有此 fetch，向服务 fetch 写回同一原值也返回 false。**

这为当前原生运行时提供了直接动态证据：不能依赖普通用户 JS 修改服务的 `nodeRepl.fetch`。本轮没有尝试突破隔离、替换全局对象、修改原型或改变属性描述符。结果只适用于下面的隔离进程和自写服务，不能当作真实桌面服务或站点状态拦截的生效验收。

## 授权与时间

用户 Q6 明确接受一次最多 30 分钟的隔离诊断，允许执行指定 `node_repl` 辅助进程，使用临时配置和自写服务检查加载、上下文可见性、属性与恢复。此前宿主只读调查的禁止执行范围，仅对这次明确限定的实验作了调整。

- 预算起点：2026-10-18T07:01:02Z；硬截止：07:31:02Z。
- 首次本轮时间记录：07:01:33Z。
- 单次辅助进程实验：07:03:17.407585Z–07:03:17.878183Z，约 0.47 秒，包含进程退出与临时根删除。
- 无协议重试、无第二次实验、无产品测试或提交。

没有启动桌面应用，没有加载真实 browser/chrome service、CUA browser service 或真实 JS bundle；没有调用 fetch、请求站点状态、修改 feature 字段或实施拦截。

## 运行时身份

执行前重新读取并核对以下关键文件，均与上一轮身份完全一致。文件路径相对于 `/Applications/ChatGPT.app/Contents/Resources/`。

| 工件 | bytes | SHA-256 |
| --- | ---: | --- |
| `cua_node/bin/node_repl` | 19,255,584 | `190b225f83ee6a3e1c4ca532bbf2178ddf21747d113c706b8dfcfcd33f5db0f0` |
| `cua_node/bin/node` | 122,127,712 | `5cdbcfcbbae201df8af79027fed814f4b379c55a00f4a20c9bcafb3d2f7cf47f` |
| `cua_node/manifest.json` | 482 | `b64afbf6eda206e63d1fb0367d6f450fd7d153ef4becdd793c483378e3492974` |

驱动在启动前再次断言 `node_repl` 摘要。直接启动的可执行文件为第一项，空参数；通过 `NODE_REPL_NODE_PATH` 指定第二项，供原生 REPL 使用其配套 Node。没有直接执行 Node CLI、包内 launcher 或 bundle。运行时 manifest 声明 Node binary version `24.21.0`、darwin/arm64；未另行执行版本命令。

宿主所属分发版本为 `26.1013.40934 / build 20770`，精确应用与归档身份、插件字节对应关系见[宿主入口报告](host-runtime-entry-investigation.zh-CN.md)。这不证明当前桌面活跃分支。

## 协议与可重现驱动

先只读随附 `@oai/cua-repl/README.md`、运行时 manifest、已有宿主配置构造证据与官方 MCP 文档。随附说明用于理解 trusted services 和 banner；没有执行其默认 CUA banner。另一份随附 CUA API 文档是使用说明，没有补足 stdio 协议。

官方 MCP stdio 要求 UTF-8、逐行 JSON-RPC；初始化为 `initialize`、响应后 `notifications/initialized`。本驱动随后调用 `tools/list`，按实际返回的 js inputSchema 生成参数，再执行一次 `tools/call`。关闭 stdin 作为正常结束；仅在等待退出超时后，才会对本驱动创建的进程发 TERM/KILL。本次没有触发信号分支。[MCP-T][MCP-L]

自写文件均位于仓库 `.scratch/isolated-node-repl-diagnostic/`，与 `evidence/` 提取工件分开；不包含第三方源码：

- [driver.py](../.scratch/isolated-node-repl-diagnostic/driver.py)：Python 标准库 stdio 驱动、最小环境、身份断言、超时、筛选输出和清理。
- [diagnostic.mjs](../.scratch/isolated-node-repl-diagnostic/diagnostic.mjs)：自写 `handleRpc`/`classifyError` 服务；无 import、文件或网络调用。
- [result.json](../.scratch/isolated-node-repl-diagnostic/result.json)：仅筛选后的元数据结果；不保存原始 stdout/stderr。

本次执行命令为：

```sh
python3 -I /Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/.scratch/isolated-node-repl-diagnostic/driver.py
```

该命令会启动新的辅助进程，只有在相同授权范围内才适合复现。Python 从可信仓库工作目录运行；子进程 cwd 是新建空临时目录，不在提取工件目录。驱动不使用 MCP SDK 或包内第三方代码。

## 临时隔离与输出筛选

唯一临时根为 `/var/folders/4x/dsx65jpx6qq4dkk4h7hz9j8m0000gn/T/isolated-node-repl-4aa_k6fp`，其 home、codex、config、cache、data、tmp、cwd 子目录均为本次新建。实验结束后整个根已删除。

子进程环境从新字典构造，没有复制 `os.environ`。`HOME`、`CODEX_HOME`、XDG 配置/缓存/数据目录及 TMPDIR 均指向此临时根；没有携带真实 HOME、账号、认证 token、代理、证书或宿主会话数据。

除上述隔离目录外，环境只设置：

| 项目 | 本次值或用途 |
| --- | --- |
| PATH、LANG | `/usr/bin:/bin`、`C.UTF-8`。 |
| `NODE_REPL_NODE_PATH` | 精确配套 Node 路径。 |
| `NODE_REPL_NODE_MODULE_DIRS` | 空字符串；未提供 app 的模块目录。 |
| `NODE_REPL_TRUSTED_CODE_PATHS` | 仅自写诊断脚本目录。 |
| `NODE_REPL_TRUSTED_SERVICES` | 唯一 `isolated_diagnostic` 名称映射到自写 diagnostic.mjs。 |
| `NODE_REPL_JS_BANNER` | 空字符串，不导入默认 browser/CUA 模块。 |
| `NODE_REPL_DISABLE_ANALYTICS` | `1`；本轮没有检验其内部实现。 |

没有提供 Codex CLI 路径、账号配置、host-services pipe、browser backend 或真实服务映射。没有因缺少权限或账号而调整安全设置。

驱动只保留 initialize 的版本/能力、tools schema，以及自写 `DIAG_JSON`/`DIAG_CLEAN` 标记后的结构化元数据。未匹配工具文本只记录粗类别，不保存正文；stderr 只计数并检查固定错误类别。本次所有诊断输出均已审阅，无账号、token、环境值、文件内容或网络信息，stderr 为 0 字节。

未做网络抓包或系统调用审计；“未调用 fetch/未发业务请求”指自写驱动及服务的明确执行动作。不能将没有 stderr、没有业务模块的结果扩张为底层运行时绝无任何后台网络行为的独立证明。

## 分层结果

### 1. MCP 握手及工具可用

`initialize` 成功协商 `2025-06-18`，serverName 为 `rmcp`，能力包含 tools。`tools/list` 返回：

- `js`：required 参数仅 `code`，可选 `timeout_ms`、`title`。
- `js_add_node_module_dir`、`js_reset`、`turn_ended`。

仅调用一次 `js`，显式 `timeout_ms: 10000`。未调用其他工具。`tools/call` 返回 `isError: false`，无服务端额外请求、协议错误或账号要求。

驱动每条响应等待最多 18 秒，并设置整体请求截止与进程清理超时；本次未接近任一超时。

### 2. 自写可信 RPC 服务装载

用户 JS 调用 `nodeRepl.rpc("isolated_diagnostic", {method:"inspect", params:{}})`，成功返回自写服务结构化结果。由此直接证明：**该隔离运行时接受唯一自写 trusted service 映射，并调用其导出的 handleRpc。**

服务在模块顶层记录求值时的属性快照，在 handleRpc 中检查同一对象、执行受限写入检查，再返回后续快照。模块内没有导入真实服务或读取业务材料。

### 3. 用户上下文与服务上下文

| 观察 | 用户 JS | 自写服务 |
| --- | --- | --- |
| `typeof nodeRepl` | object | object |
| `typeof nodeRepl.rpc` | function | undefined |
| `typeof nodeRepl.fetch` | undefined | function，通过数据属性确认 |
| 用户 global 标记 | 安装成功，RPC 返回后仍存在 | 模块求值与 RPC 中均不可见 |

用户先在 globalThis 安装固定诊断标记，再调用 RPC；服务看不到该标记。服务的本地 `Function.prototype` 与 fetch 函数的直接 prototype 相等；nodeRepl 的直接 prototype 不等于本地 `Object.prototype`。

这些结果直接支持**双方没有共享同一个可见全局对象，暴露能力也不同**。本实验没有跨 RPC 传递可比较的对象引用，因此未完整证明 V8 realm、进程、VM 或隔离实现架构。不能把 prototype 比较当作完整 realm 识别。

服务标记在返回前已经删除；用户随后看不到它只能用于清理检查，不能单独作为“服务标记从未向用户可见”的证据。

### 4. fetch 描述符与初始化时机

以下结果在模块求值、handleRpc 写入前、写入后三个快照中一致：

| 属性 | 结果 |
| --- | --- |
| nodeRepl 是 globalThis 自有属性 | true |
| `Object.isFrozen(nodeRepl)` | true |
| `Object.isExtensible(nodeRepl)` | false |
| fetch 所有者 | nodeRepl 自有属性，prototypeDepth 0 |
| fetch 描述符 | data；enumerable true；writable false；configurable false |
| getter / setter | 均无 |
| fetch 值类型 | function |
| function name | `value`，名称不揭示内部 HTTP 实现 |
| 模块求值与 RPC 时 nodeRepl 是否同一对象 | true |

因此，**在自写可信服务的第一段模块代码执行时，该能力对象已存在且已冻结**。本轮没有找到一个服务内部、冻结之前的初始化窗口；没有尝试更早注入或改变原生初始化。

### 5. 写入与恢复

服务仅执行一次 `Reflect.set(nodeRepl, "fetch", originalFetch)`，即把同一个原函数值写回。返回 `false`，无抛错。

因原属性 `writable: false`，没有尝试赋值临时 wrapper，也没有尝试 defineProperty、全局替换、原型修改或其他突破。自写代码中保留的临时 wrapper 分支没有进入，wrapper 从未安装或调用。

恢复检查结果：

- fetch 仍为原始函数：true。
- writable/enumerable/configurable 与原描述符一致：true。
- 模块求值捕获的 fetch 仍与当前值相同：true。
- 服务诊断标记已删除：true。
- 用户诊断标记已删除：true。

本次没有实际改变 fetch；“恢复”指检查原值与属性未变化，以及清除自写标记。

## 进程退出与清理

本驱动直接启动的 PID 为 `56444`。正常关闭 stdin 后，进程自行退出，退出码 `0`；未发送 SIGTERM 或 SIGKILL，没有使用 pkill 或扫描/终止其他进程。

stderr 为 0 字节，无认证要求或错误类别。整个临时隔离根已删除，结果中 `isolationRemoved: true`。未对运行时内部子进程另做全系统扫描，因此不声称取得所有后代进程的独立清单。

保留的自写脚本和筛选结果只在仓库 `.scratch/isolated-node-repl-diagnostic/`，没有写入真实用户配置、安装目录或归档工件目录。本轮未改安装、代理、证书、安全设置、分析器、tracker；未 commit、push 或创建 PR。

## 能得出的决定与仍缺证据

**建议停止“从普通用户 JS 直接改服务 nodeRepl.fetch”这条路线。** 在这份精确原生运行时的隔离实验中，用户上下文没有该 fetch，可信服务模块开始执行时的 fetch 也已是不可写、不可配置属性。不要把剩余时间用于尝试突破这一边界。

如果后续继续完成站点状态限制的限定版本目标，最小下一决策是：是否改选已明确授权范围的插件文件补丁，或者先独立确认真实桌面活跃服务分支。后者关系到应审查缓存 `browser-service.mjs` 还是 CUA 的 `@oai/browser-desktop/service`；当前实验没有加载任一真实服务，不能自动选定补丁对象。

本轮仍没有证明：真实桌面采用哪条分支、业务 service 的实际运行状态、fetch 内部网络栈、是否支持可接受的启动前宿主扩展、字段改写的实际效果、缓存影响或真实撤销。没有改 `feature_status.agent`，没有替代已有真实验收。

## 来源

- [MCP-T] [官方 MCP stdio transport，2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。
- [MCP-L] [官方 MCP lifecycle，2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)。
- [运行时 manifest](/Applications/ChatGPT.app/Contents/Resources/cua_node/manifest.json:1)。
- [随附 CUA REPL README](/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/README.md:17)，尤其 trusted service 与 banner 行为说明。
- [宿主入口调查](host-runtime-entry-investigation.zh-CN.md)：当前应用身份、启动配置与服务分支的静态证据。
- [自写驱动](../.scratch/isolated-node-repl-diagnostic/driver.py)、[自写诊断服务](../.scratch/isolated-node-repl-diagnostic/diagnostic.mjs)、[筛选结果](../.scratch/isolated-node-repl-diagnostic/result.json)。
