# CUA 请求通道包装器注入位置

2026-10-18。**建议在现有 sR 运输函数中，等待原 fetch 返回后、返回响应给 fetchBlocked 之前，注入本通道专用的响应适配器。适配器仅处理 json 的解析结果，构造 feature_status.agent 为 false 的响应数据副本；原判定器 wT/aj 保持原样。** 这是源码注入请求/响应包装器，不是网络代理，也不是改变原判定调用的布尔结果。

## 身份和唯一调用

核对时间 15:30:24Z–15:30:48Z，未超过本轮 5 分钟范围。目标文件：

`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`

1,938,669 bytes；SHA-256 `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e`，与此前一致。只用已有 Acorn 解析源码字符串，没有执行真实模块、REPL 或请求，没有写补丁。

所有坐标均为零基 UTF-16 半开区间、一基行号，本文件相关位置均在第 5546 行。

| 位置 | 坐标 | 直接观察 |
| --- | --- | --- |
| sR 定义 | `[1084379,1084586)` | async 函数，三个形参 t、e、r，语义分别为 runtime、请求地址、请求选项。 |
| sR 声明标识符 | `[1084394,1084396)` | 一处声明。 |
| 原 runtime.fetch 调用 | `[1084573,1084585)` | 两个实参 e、r，以成员调用保留 runtime receiver，并 await 返回。此前有 fetch 类型检查及原错误。 |
| sR 唯一消费引用 | `[1086177,1086179)` | 完整调用 `[1086177,1086208)`，位于 Xy.fetchBlocked。 |
| fetchBlocked | `[1086141,1086311)` | 传 runtime、站点状态 endpoint、GET 选项；随后只读取响应 ok，再 await 无参 json，最后调用原 wT。 |
| 响应 ok 读取 | `[1086213,1086217)` | falsy 时抛原 HTTP 错误。 |
| 响应 json 调用 | `[1086289,1086297)` | 无参数，保留 response receiver；结果被 await。 |
| 原 wT 调用 | `[1086305,1086310)` | 接收解析数据；建议保持该调用及其参数表达式不变。 |

全文件 AST 中名为 sR 的 Identifier 共 **2 处：1 声明、1 调用**。没有找到别名赋值、导出或其他静态引用；唯一调用来自站点状态 fetchBlocked。因此在已读源码静态引用范围内，它是此通道的专用运输函数，适合注入窄包装，不必扩展到 runtime 的所有 fetch。此有限引用核对不是全 bundle 动态执行或非干扰证明。

## 包装器接口契约

包装器应保持 sR 的三个参数、原 fetch 类型检查、原调用及 await 顺序。成功取得原 response 后返回一个**自有适配对象**，只提供此消费者实际需要的两个接口：

- **ok**：在消费者读取时，明确转发原 response.ok；不能在 sR 内提前读取并缓存，以免改变原 getter 的读取时机和异常位置。可以使用一个明确具名的转发访问器；不是遍历属性、泛 Proxy 或动态猜测接口。
- **json()**：调用原 response.json，使用原 response 作为 receiver，且每次适配器调用只调用原方法一次。await 原结果后，在明确的数据结构条件下构造字段副本，再返回；不捕获或转换原读取、调用、解析错误。

原消费者使用 await，说明它接受 Promise/thenable 或直接值；**本轮没有证明原 response.json 的实现必定返回 Promise**。适配器可以明确声明为 async，返回 Promise；这对该已知 await 消费者成立，不能据此宣称对任意 Response 消费者透明。

不必保留整个标准 Response 原型，也不能声称已证明 status、headers、clone、bodyUsed 等接口的透明性：此唯一消费者没有读取它们。若后续结构核对发现新增消费者或接口，须拒绝旧包装契约并重新审阅。

数据处理应限于正常 JSON 对象及其 feature_status 对象：只在目标 agent 字段满足已确认条件时生成浅副本，将该字段设为 false，保留其余 JSON 内容；未知形状原样返回。具体数组、缺失字段、非布尔值等应在实现规格中明确，建议最窄只改原字段严格为 true 的对象响应。不要直接赋值原响应或原解析对象。

该通道的请求生成器已固定为站点状态 endpoint；若实现再校验目标，应静态明确 origin/path/method 的匹配规则，非匹配请求直接返回原 response，不读取 body。不得以泛对象探测或响应 getter 猜测目标。依据现有唯一调用，最窄选择是直接以此专用 sR 通道限定作用域。

## 必须保留与限制

- 原 fetch 的参数、receiver、请求次数、HTTP 错误、JSON 错误及拒绝传播必须保留；只在原 json 成功后修改数据副本。原 ok 检查仍在消费者中，不提前解析失败 HTTP 的 body。
- 原 wT/aj 判定器及调用保持原样；它看到的是包装器交付的数据。这与此前 `wT(o)&&false` 备选不同，后者不符合当前用户意图，不作为本建议。
- frozen nodeRepl.fetch 阻止直接赋值，**不排除在源码中包装原函数返回的响应**。本轮没有验证局部 runtime 或原 response 是否可写，建议不依赖其可写性，直接创建适配器。
- 缓存、inflight、24 小时 TTL 与已有模块加载行为仍在原链中。旧缓存 true 或旧进程仍可继续拒绝；注入后不能靠一次旧缓存结果判断是否生效。
- 这里只确认局部源码接口和引用，没有全面证明权限/企业 gate，未证明当前活跃加载、实际字段改写、生效或撤销。

下一步可据此形成具体实现规格：**在 sR 的成功返回边界引入明确 ok/json 适配器，保留原 fetch 与判定器**，再以自写响应做 receiver、时序、失败传播、非目标直通和字段保留验证。真实文件变换、安装修改与运行验证均未在本轮实施。

来源：[目标运输及消费位置](/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs:5546)、[站点状态链身份与坐标](cua-site-status-target.zh-CN.md)、[配置分支结论](browser-service-selection.zh-CN.md)。报告不复制第三方源码；没有修改安装、配置或实现文件，没有提交。
