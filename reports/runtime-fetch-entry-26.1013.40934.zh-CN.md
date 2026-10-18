# 26.1013.40934：runtime.fetch 入口调查

日期：2026-10-18。结论：**已找到插件内部的 runtime 构造与能力来源；未找到已证实、用户可控制的注入入口。服务加载者及宿主 fetch 实现仍缺一段包外证据，与当前桌面应用的对应关系也未证明。**

本轮依据 [ADR 0005 新版本授权](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/adr/0005-version-scoped-empirical-validation.md:11)，仅调查明确指定的 browser/chrome `26.1013.40934`。旧版调查和缺失结论保留，不追溯改写为验收成功。

## 时间与检查范围

- 预算起点：2026-10-18T05:57:48Z；实际开始记录：05:58:08Z。
- 定向源码调查结束：06:02:25Z；报告完成记录：06:03:57Z。
- 硬截止：06:27:48Z。插件包内已追到宿主边界，提前结束，不用满预算。

仅读取两个授权目录中的实际 plugin manifest、service、client、Chrome 安装 manifest 脚本及相关文件清单；对本版本依赖文本做定向引用检索。使用仓库已有 Acorn 解析**源码字符串**以记录坐标；没有加载或执行插件模块。未开展广泛官方文档研究，没有引用通用开源实现补足本地事实。

两个插件及其已检查上级目录均未发现 `AGENTS.md` 或 `CLAUDE.md`。两个 `skills/` 目录实际为空；不能据 manifest 的 `skills` 声明假设另有 bootstrap 技能。根目录没有额外 MCP 启动配置文件；实际 `.codex-plugin/plugin.json` 的顶层字段也没有 `mcpServers`、启动 `command`、`args` 或 `env`。[M-B][M-C]

## 样本身份与差异

路径基准为 `/Users/pzehrel/.codex/plugins/cache/openai-bundled/{browser,chrome}/26.1013.40934/`。下面文件均为普通文件，实际路径与规范路径一致。service、client、plugin manifest 与 ZXing 资源在调查后复核未变化。

| 代号 | 两插件相对路径 | bytes | SHA-256 |
| --- | --- | ---: | --- |
| S | `scripts/browser-service.mjs`，两份相同 | 1,462,840 | `c470cdc7f98be2724ef1c85f6b9d3757d80de022b065ca14d922d7a1a85ffc9a` |
| C | `scripts/browser-client.mjs`，两份相同 | 169,663 | `78f5a38ab02f23b68e4650e3bfe9ec2f269c5e004f30a1f59eee927a221a2e2f` |
| M-B | browser `.codex-plugin/plugin.json` | 3,432 | `188f075c18e33ff9ac5ea55bc5ac463ff385cbdf283b8afd5a45015586c8859f` |
| M-C | chrome `.codex-plugin/plugin.json` | 3,303 | `4c985d7ed75fdffab590c59fa1da639595381a1c9327a4b9cd9d09e003eb8656` |
| I | chrome `scripts/installManifest.mjs` | 12,849 | `b606b106974face8c96208a2fecee1d507527dcc3ea81f2a341b6e2acbd829ce` |
| W | `scripts/zxing_reader.wasm`，两份相同，仅读取摘要 | 1,065,866 | `0e8d688d71932ebb6b8b33f700d43d3cb997f59ed9cab3c05102d7f10288a392` |

service inode 分别为 browser `206229882`、chrome `206230343`；client 为 `206229887`、`206230346`，因此是独立路径的相同字节，不能因此认定活跃插件相同。

browser/chrome 的 manifest 名称、描述与界面不同，但都声明版本 `26.1013.40934`，并将 Interrupt、SubagentStop、Stop hook 发往 `node_repl.turn_ended`。[M-B，第 2–55 行；M-C，第 2–55 行] Chrome 另有 native extension host 与安装器；browser 没有这个安装器。两份 service、client 相同，使以下包内代码关系同时适用于两份文件；不证明两个实际服务共享进程或全局对象。

## 已确认的具体链

所有区间为源码 **零基 UTF-16 半开区间**；行号为一基。S/C 的字节身份如上。报告仅描述接口与坐标，不复制专有源码。

### 1. client 发 RPC；它不直接 import service

C 导出 `setupBrowserRuntime`，实现函数 `XC` 位于第 9 行、`[168414,169628)`；导出语句为 `[169628,169662)`。

它读取 client 所在上下文的 `globalThis.nodeRepl`，要求该对象提供 `rpc`，然后把 `setup`、`execute`、`executeWithRecovery` 发到名为 `browser` 的 RPC 服务。三个调用区间为 `[168663,168701)`、`[168713,168753)`、`[168777,168829)`。setup 的显式参数是 environment 与文档/API 选项；此函数没有提供传入自定义 service runtime 或 fetch 的参数。[C，第 9 行]

**已知的是 RPC 服务名和调用协议；未知的是谁加载 C、谁把 `browser` RPC 注册到 S。** C 没有 import declaration，文本内也没有 `browser-service.mjs` 路径。不能把 RPC 调用推断为同一上下文函数调用。

### 2. service 的 RPC 入口与 runtime 创建者已定位

S 导出 `handleRpc`（内部名 `eQe`）及 `classifyError`。`eQe` 从私有方法表 R3 选择请求方法并调用；setup 从 A3 创建 runtime，再传给 EF 初始化浏览器服务。[S，第 4481 行]

| 关系 | 源码坐标 | 已确认行为 |
| --- | --- | --- |
| RPC 方法表 R3 | `[1461776,1462537)` | 提供 setup、execute、executeWithRecovery；setup 接受四种 environment，初始化结果保存在模块局部 promise。 |
| RPC 入口 `eQe` | `[1462538,1462722)` | 按请求 method 取得方法并传递 params。 |
| setup 调 EF / A3 | `[1462047,1462126)`，A3 调用 `[1462121,1462125)` | runtime 由 service 内部创建，不从 client 的 setup 参数直接接收。 |
| A3 | `[1460344,1460820)` | 从 n2 取得宿主对象，调用 Aae，再补 config、browserContext、文件系统等能力。 |
| n2 | 第 4457 行，`[1336314,1336386)` | 读取 **service 所在上下文**的 `globalThis.nodeRepl`；要求其 config 存在。 |
| Aae | 第 4481 行，`[1461026,1461354)` | 以对象展开复制宿主对象的可枚举自有属性，并补 platform、request metadata、elicitation 包装；展开点 `[1461085,1461089)`。 |

**因此，插件局部 runtime 的创建者是 S 中的 A3/Aae；它的宿主能力源是 service 上下文的 `globalThis.nodeRepl`。** 这比此前只找到成员调用点更进一步，但仍未证明谁创建该全局对象。

Aae 没有自己定义 fetch 实现。已检查的构造路径也没有显式覆盖 fetch；运输函数实际使用复制后 runtime 上的 fetch。按源码可见路径，其来源是宿主对象展开，而不是这里定义的 HTTP 客户端。宿主对象实际属性描述符、getter、函数可写性及运行时行为均未观察，不能据此声称可替换。

### 3. runtime 确实传到站点状态链

| 关系 | S 坐标 | 已确认行为 |
| --- | --- | --- |
| EF 接收 runtime | 第 4456 行，`[1292414,1298177)` | 第二参数为 A3 返回的 runtime。 |
| EF 创建浏览器控制上下文 wh | `[1294827,1295008)` | 将该对象作为 runtime 传给 wh。 |
| wh 保存 runtime 并创建安全对象 nm | 第 4441 行，wh `[1267341,1271309)`；new nm `[1268478,1268684)` | 同一个 runtime 被转交安全对象。 |
| nm 的 siteStatus provider | 第 1073 行，`[614688,614907)` | 将 `this.runtime` 传给 ik；blocked 时产生站点状态拒绝。 |
| ik 到 Gy.checkUrl | ik `[614017,614062)` | 调用模块局部实例的 checkUrl。 |
| checkUrl、isBlocked、fetchBlocked | `[612954,613200)`、`[613200,613702)`、`[613835,614005)` | 构造请求、处理缓存/进行中请求，再经运输包装读取新结果。 |
| 运输包装 ok | `[612073,612280)`；fetch 调用 `[612267,612279)` | 检查并调用传入 runtime 的 fetch，保留 receiver。 |

本轮没有把接口调用认定为外部可控入口，也没有证明最终联网者是 Node、Rust、Electron 或网页网络栈。

## 加载者、启动 manifest 与宿主边界

实际 plugin manifest 只提供上述 hooks 和插件元数据；未给出 Node REPL 的可执行文件或 browser RPC 服务的模块注册表。[M-B][M-C]

包内定向查找未发现：service/client 的加载者、`browser` RPC 注册实现、`nodeRepl` 提供者或其 fetch 实现。依赖目录内文本检索也未定位这些实现。这是一项有限查找的结果，不是“宿主不存在此实现”的证明。

Chrome 的 I 是 **native-messaging 安装器**，不是直接启动 `browser-service.mjs` 的 manifest。其静态逻辑如下：[I，第 1–3 行]

- `[10580,10984)` 校验配置结构，包含外部传入的 `codexCliPath`、`nodePath`、`nodeReplPath` 及可选 client 路径。
- `[10984,11071)` 按插件根目录设置 client 路径。
- `[11071,11602)` 构造 `type: stdio` 的 native-messaging manifest，目标是 native extension host。
- `[11602,11767)` 把上面的运行时路径写入 native host 旁的 `extension-host-config.json`。
- 导出的安装入口从调用参数 `appServerRuntimePaths` 取得实际宿主路径。**本文件没有这些实际值；未执行安装。**

授权目录中的精确预期配置路径为：

`/Users/pzehrel/.codex/plugins/cache/openai-bundled/chrome/26.1013.40934/extension-host/macos/arm64/extension-host-config.json`

本轮仅列该目录，实际只有 `ChatGPT for Chrome` 二进制，没有上述配置。二进制仅记录身份：1,059,472 bytes，SHA-256 `2296f0eb19652d45cebe67cf26e454eef52031a40b9ed2d21184c761f67f05cd`。未运行、反汇编或用它探测宿主路径。

I 的安装逻辑还有缓存根转向 `latest` 的路径处理；本轮仅观察其源码，**没有跟随 latest、执行该逻辑或认定实际已安装 manifest 指向当前版本**。因此 native host 的实际安装位置、运行时路径及其是否与服务链相关仍未知。

## 用户入口与当前桌面对应关系

| 问题 | 结论 |
| --- | --- |
| 能否控制 client 的 `nodeRepl.rpc` 就改到 service fetch？ | 未证实。client 与 service 的执行上下文关联由缺失的 RPC 宿主决定。 |
| 能否在 service setup 前替换宿主 `nodeRepl.fetch`？ | 只能作为候选条件。对象是否向用户代码暴露、可写、处于相同 realm、是否早于 Aae 的复制，均无证据。复制后修改源属性也不保证改变已复制函数。 |
| `setupBrowserRuntime` 是否已有 fetch/runtime 注入参数？ | 所查实现没有。 |
| plugin manifest 是否提供可控 preload/启动命令？ | 所查 manifest 没有。 |
| 是否找到最终 HTTP 实现？ | 没有；断在宿主提供的 `nodeRepl.fetch`。 |
| 新插件是否对应当前桌面应用？ | **未证明。** manifest 版本、缓存路径及 service 的 release 字面值只能确认插件身份，不能证明当前桌面版本、实际选用插件或活跃加载路径。 |

没有读取 `/Applications/ChatGPT.app` 或其他未授权宿主目录。历史旧版 ASAR 不能补足新版本宿主证据，本轮未用其源码作替代。

## 最小下一步与停止条件

下一项只读问题已经缩小为：**取得为该桌面版本配置 Node REPL 的宿主材料，确认 `browser` RPC 模块注册与 `nodeRepl.fetch` 实现。** 最有价值的材料是实际 `appServerRuntimePaths`、生成的 `extension-host-config.json` 或桌面应用中提供这些值的代码/清单。当前插件无法推导它们的实际路径。

若继续，应先明确授权读取当前桌面应用身份和对应宿主材料。历史安装名只提供候选路径 `/Applications/ChatGPT.app/Contents/Info.plist`、`/Applications/ChatGPT.app/Contents/Resources/app.asar`；它们在本轮没有被验证存在或读取，不应被当作已确认安装位置。应先由用户确认实际应用路径，再记录身份和包内清单，定位 Node REPL 提供者；不要全盘扫描或启动宿主猜测。

**本轮到此停止。** 继续分析需要跨出当前插件授权范围，或者执行当前禁止的宿主实验。即使后续找到同上下文可写属性，也仍需单独批准最小实际验证，才能证明生效与撤销；本报告不实现 wrapper、不开发原型。

## 本地来源索引

源码坐标必须与本报告身份表联合复核。下面链接指向 browser 文件；同哈希的 chrome 文件也适用。

- **[S]** [browser service](/Users/pzehrel/.codex/plugins/cache/openai-bundled/browser/26.1013.40934/scripts/browser-service.mjs:4481)；[chrome service](/Users/pzehrel/.codex/plugins/cache/openai-bundled/chrome/26.1013.40934/scripts/browser-service.mjs:4481)。主要行：1073、4441、4456、4457、4481。
- **[C]** [browser client](/Users/pzehrel/.codex/plugins/cache/openai-bundled/browser/26.1013.40934/scripts/browser-client.mjs:9)；[chrome client](/Users/pzehrel/.codex/plugins/cache/openai-bundled/chrome/26.1013.40934/scripts/browser-client.mjs:9)。
- **[M-B]** [browser plugin manifest](/Users/pzehrel/.codex/plugins/cache/openai-bundled/browser/26.1013.40934/.codex-plugin/plugin.json:1)。
- **[M-C]** [chrome plugin manifest](/Users/pzehrel/.codex/plugins/cache/openai-bundled/chrome/26.1013.40934/.codex-plugin/plugin.json:1)。
- **[I]** [Chrome native-messaging 安装器](/Users/pzehrel/.codex/plugins/cache/openai-bundled/chrome/26.1013.40934/scripts/installManifest.mjs:1)。

没有启动、重启或终止 Codex；没有连接调试口、抓流量、请求站点状态、加载自定义代码、执行/import 真实 bundle、执行/编译/实例化 Wasm。没有修改安装、用户配置、代理、证书、分析器、tracker、commit、push 或 PR。本轮仅新增本报告，未保存专有源码摘录，未运行产品测试。
