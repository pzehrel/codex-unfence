# CUA 站点状态补丁目标的定向核对

日期：2026-10-18。**已找到唯一、具体的最小变换候选：在 CUA service 的站点状态响应完成 HTTP/JSON 检查后，保留原 agent 判定的求值，再将其布尔结果转为 false。** 这是本轮新增的备选，与此前“响应副本的 agent=false”方案不同，尚未由用户选定，不自动取代原方案。本轮只确定候选，没有写 patch、修改安装或执行真实模块。

## 文件身份与范围

目标为 `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`，规范路径与真实路径相同，位于已授权 app 内。

| 项目 | 结果 |
| --- | --- |
| 首次身份记录 | 2026-10-18T07:17:44.799711Z |
| bytes | 1,938,669 |
| SHA-256 | `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e` |
| 与缓存 browser/chrome service 是否同字节 | 否；缓存为 1,462,840 bytes、SHA-256 `c470cdc7f98be2724ef1c85f6b9d3757d80de022b065ca14d922d7a1a85ffc9a`。 |
| 分发/包版本 | 桌面 `26.1013.40934 / build 20770`；`@oai/browser-desktop` 包版本 `0.1.1`。 |

仅对该文件做摘要、定向文本查找和现有可信 Acorn 的源码字符串解析；没有 import/执行该模块，没有启动辅助或桌面运行时，也没有读取其他用户数据。Acorn 在仓库可信工作目录运行，不在工件目录运行。未复制源码到报告或新提取目录。

本轮预算最多 10 分钟；找到明确单一调用点后停止，不展开完整证明或泛研究。此前[分支配置报告](browser-service-selection.zh-CN.md)与[宿主报告](host-runtime-entry-investigation.zh-CN.md)独立保留。

## 目标链与源码坐标

以下均为一基行号、零基 UTF-16 半开区间，必须结合本报告文件身份复核。压缩名仅标识这份工件。

| 位置 | 坐标 | 相关行为 |
| --- | --- | --- |
| wT | 第 5478 行，`[595229,595260)` | 将响应交给 aj，并使用 agent 字段名。 |
| aj | 第 5478 行，`[595260,595345)` | 检查响应及 feature_status 为非 null 对象，然后严格比较对应字段是否为 true；否则返回 false。 |
| agent 名称初始化 | 第 5478 行，UTF-16 起点 596679 | tj 被初始化为 agent。 |
| vT / lj | 第 5478 行，`[595345,595940)`、`[595940,596303)` | URL 预处理及站点状态 endpoint 构造；目标为 `https://chatgpt.com/backend-api/aura/site_status`。 |
| sR | 第 5546 行，`[1084379,1084586)` | 要求 runtime.fetch 为函数，并保留 receiver 调用。 |
| Xy | 第 5546 行，`[1084605,1086312)` | 站点状态请求、缓存、inflight 与阻止判定。 |
| checkUrl | 第 5546 行，`[1085260,1085506)` | 构造请求，等待 isBlocked；本次所读实现捕获该过程异常并返回无结果。 |
| isBlocked | 第 5546 行，`[1085506,1086008)` | 每次先开始新请求，再检查缓存或已有 inflight；维护结果和缓存。 |
| cachedBlocked | 第 5546 行，`[1086008,1086141)` | 过期检查；TTL 常量 Zz `[1084590,1084604)` 为 24 小时。 |
| fetchBlocked | 第 5546 行，`[1086141,1086311)` | GET → 检查 response.ok → await response.json → agent 判定。 |
| **最小变换候选调用点** | **第 5546 行，`[1086305,1086310)`** | fetchBlocked 最后的 wT 调用；这份文件中只定位到这一处 wT 消费调用。 |
| 单例与转发 aR | 第 5546 行，Qz `[1086313,1086322)`，aR `[1086323,1086368)` | 复用 Xy 单例，将 URL 检查转给它。 |
| 安全对象的 siteStatus provider | 第 5546 行，aR 调用 `[1087025,1087063)` | 结果 blocked 时产生 site_status_blocked；旁边仍有 host URL、origin policy/approval、history 等独立门禁。 |

与旧缓存 service 的对应链相比，**核心语义相同、文件和坐标不同**：严格 `feature_status.agent === true` 表示阻止，GET/JSON 后取布尔结果，24 小时缓存与先发新请求再查缓存的顺序一致。不能把旧工件摘要、偏移或现有分析器验收直接套到 CUA 文件。

## 可评审的最小拟议变换

仅在上表 fetchBlocked 的最终调用点，将“直接返回原 agent 判定结果”改为“**先完成原判定求值，再返回 false**”。一种自写表达式形式是 `originalAgentDecision(response) && false`；这里是拟议逻辑，不是复制的第三方源码或已生成补丁。

静态复核确认：wT 返回 aj 的结果；aj 的对象检查失败分支返回 false，其末尾条件表达式的两支分别为严格相等比较和 false，因此在正常返回时确为 boolean。AST 中 wT 消费调用唯一，区间 `[1086305,1086310)`，唯一实参为标识符 o；它是 return 的整个实参，return 区间 `[1086298,1086310)`。拟议的 `return wT(o)&&false;` 与 `return (wT(o)&&false);` 经独立自写字符串 AST 解析均为同一逻辑结构：先完成调用，再求右侧 false；本位置不需要额外括号，明确包裹也可。没有修改或执行目标源码。

因此该备选只改变成功解析响应后的布尔结果；原调用求值中的属性读取及可能抛错仍发生，调用若抛异常，右侧 false 不会执行。它不伪造 HTTP/JSON 错误，无需修改共用 aj helper、字段名常量、RPC 或 runtime.fetch。与“响应副本 agent=false”相比，它不构造或修改响应副本，而是在原判定后处理结果；两者不能未经审查视为同一实现。

上述保留结论只针对已定位的源码局部顺序与未改动的相邻调用；没有完成所有用户权限、企业策略或其他 gate 的全面证明，也没有取得真实运行验证。

限定版本方案应以当前目标 SHA-256 和精确结构检查拒绝未知工件，备份原文件并提供恢复；应用与真实生效验证仍属后续步骤，本轮未实施。按照 [ADR 0005](../docs/adr/0005-version-scoped-empirical-validation.md)，可以定向审查、关键回归和明确授权的真实验证交付，不需要恢复全 bundle 静态证明，也不能声称本次已完成实际验收。

以下行为必须保留：

- GET 请求、response.ok 检查、JSON 解析及原异常路径；不改 catch 为其他策略，不靠制造异常触发放行。
- 用户拒绝、持久拒绝、企业策略、host URL 和其他权限门禁；不修改通用权限 bypass 或 security mode。
- 缓存 key、24 小时 TTL、inflight 复用、请求顺序与清理。已经存在的 blocked 缓存不会因磁盘文件改变而自动清除；已有运行中模块与函数也不会因文件改变自动重载。
- 目标只限站点状态 agent 判定；不改其他 feature 字段、响应内容或浏览器网络拦截。

## 限制与下一步

[现有配置](browser-service-selection.zh-CN.md)高置信选择 CUA browser 映射，因此本文件比传统缓存文件更适合作为下一方案候选。**但没有观察当前活跃加载，磁盘候选仍不是运行事实。**

当前证据足够给用户提出具体方案选择：一项是此前的响应副本字段方案，另一项是本轮新增的“在唯一调用点保留原求值、再归 false”备选。第二项若被选定，应限定本版本和目标身份，配备原文件恢复，再在明确授权的真实实验中确认目标分支、生效及撤销；旧缓存 true 仍可能拒绝，已有进程也可能继续使用原模块。当前没有替用户选定方案。若不接受修改 app 内文件或重启/加载验证，则应停止在方案阶段，不把运行时 fetch 写入路线当作已可用替代。

本轮没有写 patch、备份或安装文件，没有执行真实模块/Wasm，没有启动桌面或 Node REPL，没有请求接口、抓流量、修改用户配置/代理/证书，也没有 tracker、commit、push、PR 或新代理。

来源：[目标 service](/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs:5546)、[包导出](/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/package.json:6)、[旧缓存链报告](runtime-fetch-entry-26.1013.40934.zh-CN.md)、[隔离 fetch 诊断](isolated-node-repl-diagnostic.zh-CN.md)。
