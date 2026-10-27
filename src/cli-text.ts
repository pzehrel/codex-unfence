// 仅在面向人的展示中转换文案；原始诊断、证据和假设仍用于 JSON 与恢复核验。
const evidenceDescriptions: ReadonlyMap<string, string> = new Map([
  ['Only the selected awaited JSON result is adapted; fetch, Response identity, interfaces, receivers and arguments remain unchanged.', '仅调整选定的 JSON 解析结果；fetch、Response 对象、接口、接收者和参数保持不变。'],
  ['Only feature_status.agent strictly equal to true is rewritten to false; other JSON data passes through unchanged.', '仅将严格等于 true 的 feature_status.agent 改为 false，其他 JSON 数据保持不变。'],
  ['Local argument provenance reaches the site-status endpoint; surrounding request construction is retained.', '局部参数来源可追溯至站点状态端点；保留外围请求构造。'],
  ['One awaited member fetch is wrapped without changing its receiver, arguments or evaluation count.', '包装一个经过 await 的成员 fetch 调用，保留接收者、参数和求值次数。'],
  ['Response stays local and uses only ok and one awaited no-argument json(); parsed data reaches feature_status.', '响应保留在局部范围内，仅使用 ok 和一次经过 await 的无参数 json()；解析结果传入 feature_status。'],
  ['Finite URL filtering, normalized cache key and site-status endpoint with conversation/turn/source provenance.', '已识别有限范围的 URL 过滤、规范化缓存键，以及带有 conversation、turn 和 source 来源信息的站点状态端点。'],
  ['Unique guarded member fetch preserves runtime receiver, endpoint, GET options and original await.', '唯一的受条件保护的成员 fetch 调用保留运行时接收者、端点、GET 选项和原有 await。'],
  ['Same response supplies ok and awaited no-argument json; unchanged body reaches strict agent predicate.', '同一响应提供 ok 和经过 await 的无参数 json；响应体保持不变，传入 agent 的严格判定。'],
  ['Original predicate reads feature_status and the initialized agent key with strict true comparison; wrapper own-data constraints are separate.', '原判定读取 feature_status 和已初始化的 agent 键，并严格比较 true；包装器对自有数据属性的约束单独检查。'],
  ['Blocked result flows through unchanged cache/inflight and a corresponding throwing guard.', '阻止结果经过保持不变的缓存、进行中请求和对应的抛错检查。'],
  ['Finite class state, default constructor, unique local instance and closed related lexical references.', '已识别有限范围的类状态、默认构造函数、唯一局部实例和封闭的相关词法引用。'],
  ['Linked ZXing reader resource loader, byte-copy configuration, factory, handle imports and decoder interfaces identified. Resource/host-bridge lifetime noninterference is assumed, not proved.', '已识别关联的 ZXing 读取器资源加载器、字节复制配置、工厂、句柄导入和解码器接口。资源与宿主桥接在整个生命周期内互不干扰属于假设，未经证明。'],
]);

const assumptionDescriptions: ReadonlyMap<string, string> = new Map([
  ['Local site-status endpoint provenance and its awaited JSON result reaching feature_status are checked; request construction and all Response interfaces remain unchanged.', '已确认局部站点状态端点与传入 feature_status 的 JSON 解析结果；请求构造及所有 Response 接口保持不变。'],
  ['Local site-status endpoint provenance and response ok/json usage are checked; request construction, policy classes, cache and blocking consumers are not matched to a whole-chain template.', '已检查局部站点状态端点的来源和响应的 ok/json 用法；请求构造、策略类、缓存和阻止结果的使用方未按整条链路的模板匹配。'],
  ['Standard Object and Reflect interfaces retain their standard semantics; fetch/json honor their host contracts. Unrelated code and dependencies are assumed not to mutate these capabilities or the selected channel.', '假设标准 Object 和 Reflect 接口保持标准语义，fetch/json 遵守宿主契约；无关代码和依赖不会修改这些能力或选定通道。'],
  ['Static local call and property relationships identify the channel; runtime loading, endpoint configuration and website behavior remain not-verified.', '通道通过静态局部调用与属性关系识别；运行时加载、端点配置和网站行为仍未验证。'],
  ['ES2022 module syntax; finite dedicated site-status transport, request builder, strict agent predicate and cache/blocked consumption family.', '采用 ES2022 模块语法；支持有限范围的专用站点状态请求传输、请求构造、agent 严格判定，以及缓存和阻止结果使用模式。'],
  ['Standard URL, Map, Date, Object, Reflect, Error and JSON interfaces retain their standard behavior; runtime.fetch and response.json honor their host contracts.', '假设标准 URL、Map、Date、Object、Reflect、Error 和 JSON 接口保持标准行为；runtime.fetch 和 response.json 遵守宿主契约。'],
  ['Unrelated imported modules and host code do not maliciously mutate this local chain or standard capabilities; no arbitrary bundle/dependency proof is claimed.', '假设无关的导入模块和宿主代码不会恶意修改这条局部链路或标准能力；不声称已证明任意打包代码或依赖的行为。'],
  ['Bound error-message formatters receive only a literal string on the existing throwing path; their display behavior is opaque and assumed not to mutate closed chain or standard host capabilities.', '已绑定的错误消息格式化函数在现有抛错路径中仅接收一个字符串字面量；其展示行为不透明，假设不会修改封闭链路或标准宿主能力。'],
  ['Finite terminal bypass/display/origin/log helpers and local Error constructors retain their original calls and return uses. Their presentation/telemetry behavior is not recursively audited; visible mutations of the chain or standard capabilities still reject.', '有限范围的末端绕过、展示、来源和日志辅助函数，以及局部 Error 构造函数，保留原调用和返回值用法。其展示和遥测行为未递归审查；发现链路或标准能力被修改时仍会拒绝。'],
  ['Only the linked finite ZXing reader resource and host bridge are assumed not to mutate the site-status chain, its configuration or standard capabilities throughout their lifetime; this noninterference is not proved. Resource bytes are not read or executed.', '仅假设已关联且范围有限的 ZXing 读取器资源与宿主桥接，在整个生命周期内不会修改站点状态链路、其配置或标准能力；这种互不干扰未经证明。未读取或执行资源字节。'],
]);

// 同一代码可能包含不同原因，先精确匹配消息，避免把具体原因合并掉。
const diagnosticMessages: ReadonlyMap<string, string> = new Map([
  ['The complete known patch is present at the site-status JSON result. Recovery records are verified separately.', '已从目标源码确认安装了完整的本补丁；恢复材料另行检查。'],
  ['Patch detected from source, but no trusted recovery record is available. Automatic uninstall is unavailable.', '源码已安装本补丁，但缺少可信恢复记录，无法自动卸载。'],
  ['Response must be awaited into a local binding.', '响应必须经过 await，并保存到局部变量。'],
  ['Response binding is unresolved.', '无法解析响应的局部绑定。'],
  ['Response cannot be reassigned.', '响应不能被重新赋值。'],
  ['Response cannot escape its local ok/json consumers.', '响应不能传出局部的 ok/json 使用范围。'],
  ['Response ok must be read as a local condition.', '响应的 ok 必须作为局部条件读取。'],
  ['Wrapper supports only ok and awaited no-argument json().', '响应包装仅支持 ok 和经过 await 的无参数 json()。'],
  ['Expected an ok check and one awaited json() consumer.', '需要一个 ok 检查和一次经过 await 的 json() 调用。'],
  ['Wrapper Object/Reflect must resolve to host globals.', '包装器中的 Object/Reflect 必须引用宿主全局对象。'],
  ['No local site-status fetch channel found.', '未找到局部站点状态 fetch 通道。'],
  ['Multiple site-status fetch injection points found.', '发现多个站点状态 fetch 替换位置，无法唯一选择。'],
  ['Transport has consumers outside the identified site-status channel.', '请求传输函数还用于已识别站点状态通道之外的调用。'],
  ['Transport cannot escape its dedicated calls.', '请求传输函数不能传出其专用调用范围。'],
  ['Shared method transports require an explicit local binding.', '共用的请求传输方法需要明确的局部绑定。'],
  ['Parsed response must reach a feature_status consumer.', '解析后的响应必须传入 feature_status 的使用方。'],
  ['Invalid JavaScript.', 'JavaScript 语法无效。'],
  ['Unable to analyze source.', '无法分析目标源码。'],
  ['Unable to parse and bind source.', '无法解析源码及其绑定关系。'],
  ['Error formatter must receive only one literal message.', '错误格式化函数必须仅接收一个消息字面量。'],
  ['Error formatter must be an unchanged local function.', '错误格式化函数必须是未被重新赋值的局部函数。'],
  ['Only the finite guarded blocked-consumer extension is supported.', '仅支持有限范围内带条件检查的阻止结果使用扩展。'],
  ['Terminal error class must have one local standard-Error initialization.', '末端错误类必须只有一次基于标准 Error 的局部初始化。'],
  ['Guarded consumer helpers must have unchanged local bindings.', '带条件检查的使用方辅助函数必须保持局部绑定不变。'],
  ['Error message must retain the display and request fields.', '错误消息必须保留展示字段和请求字段。'],
  ['Callback error needs one standard Error class initializer.', '回调错误需要唯一的标准 Error 类初始化。'],
  ['Callback terminal helper must be a stable local binding.', '回调的末端辅助函数必须使用稳定的局部绑定。'],
  ['Callback error message must be literal.', '回调错误消息必须是字面量。'],
  ['A related local binding is unresolved.', '无法解析相关局部绑定。'],
  ['Related values use different or merged lexical bindings.', '相关值使用了不同或合并的词法绑定。'],
  ['A related literal differs from the finite pattern.', '相关字面量与支持的有限模式不符。'],
  ['Related statement, argument or property count changed.', '相关语句、参数或属性数量已变化。'],
  ['Related syntax node is missing.', '缺少相关语法节点。'],
  ['Related syntax value is missing.', '缺少相关语法值。'],
  ['Related syntax or control flow changed.', '相关语法或控制流已变化。'],
  ['Callback input escapes its finite guard.', '回调输入传出了有限条件检查的范围。'],
  ['Missing finite pattern.', '缺少所需的有限结构模式。'],
  ['Direct configuration must be initialized before policy construction and consumption.', '直接配置必须在策略构造和使用之前初始化。'],
  ['Configuration needs a top-level constant or finite once initializer.', '配置需要顶层常量或支持的有限单次初始化函数。'],
  ['Configuration assignment must be unconditional in its initializer.', '配置赋值必须在初始化函数中无条件执行。'],
  ['Initializer prefix has unknown or abrupt control flow before configuration assignment.', '配置赋值之前存在未知或可能提前中止的控制流。'],
  ['Deferred configuration must use a local once constructor.', '延迟配置必须使用局部的单次初始化构造函数。'],
  ['Unknown once constructor.', '无法识别单次初始化构造函数。'],
  ['Once constructor differs from supported task-clearing semantics.', '单次初始化构造函数不符合支持的任务清理语义。'],
  ['Once constructor is reassigned.', '单次初始化构造函数被重新赋值。'],
  ['Initializer must have a local binding.', '初始化函数必须具有局部绑定。'],
  ['Initializer binding is reassigned.', '初始化函数的绑定被重新赋值。'],
  ['Initializer escapes or has unknown arguments.', '初始化函数传出局部范围或使用未知参数。'],
  ['Configuration initializer is not reached by an unconditional module call.', '配置初始化函数未被无条件的模块调用触达。'],
  ['Related helper must be a local function declaration.', '相关辅助函数必须是局部函数声明。'],
  ['Metadata value escapes its supported parser.', '元数据值传出了支持的解析函数范围。'],
  ['Metadata parser may only be called directly with one runtime.', '元数据解析函数只能直接调用，并仅接收一个 runtime 参数。'],
  ['Related configuration needs exactly one constant initialization.', '相关配置必须且只能有一次常量初始化。'],
  ['Related configuration value is outside the finite pattern.', '相关配置值超出了支持的有限模式。'],
  ['Cache TTL must have a local constant initializer.', '缓存有效期 TTL 必须由局部常量初始化。'],
  ['Dynamic capability destructuring is unsupported.', '不支持对标准能力进行动态解构。'],
  ['Dynamic code can mutate the related chain.', '动态代码可能修改相关链路。'],
  ['Visible mutation of a standard capability or its alias is unsupported.', '发现标准能力或其别名被修改，不支持此结构。'],
  ['Reflective modification of a related standard capability is unsupported.', '不支持通过反射修改相关标准能力。'],
  ['A standard capability escapes to an unknown local call.', '标准能力传入了未知的局部调用。'],
  ['Related bindings cannot be exported to unknown consumers.', '相关绑定不能导出给未知使用方。'],
  ['A related binding has an additional use, assignment or escaped receiver.', '相关绑定存在额外使用、赋值或接收者逃逸。'],
  ['Dedicated transport must have exactly one local consumer.', '专用请求传输函数必须且只能有一个局部使用方。'],
  ['Transport consumer must belong to the supported policy class.', '请求传输函数的使用方必须属于支持的策略类。'],
  ['Policy class needs a local binding.', '策略类需要局部绑定。'],
  ['Policy must have one default local instance.', '策略必须只有一个使用默认构造函数创建的局部实例。'],
  ['Policy instance must have a local binding.', '策略实例必须具有局部绑定。'],
  ['Policy needs its finite direct entry and blocking consumer.', '策略需要有限模式内的直接入口和阻止结果使用方。'],
  ['Instance escapes or uses an unknown method.', '实例传出局部范围或使用了未知方法。'],
  ['Entry must have one finite blocking consumer.', '入口必须只有一个符合有限模式的阻止结果使用方。'],
  ['Callback family needs its corresponding guarded policy class.', '回调模式需要对应的带条件检查的策略类。'],
  ['Unknown blocking consumer.', '无法识别阻止结果的使用方。'],
  ['Blocking operation is reassigned or escapes.', '阻止操作被重新赋值或传出局部范围。'],
  ['Missing awaited transport expression.', '缺少经过 await 的请求传输表达式。'],
  ['Wrapper standard capabilities must resolve to host globals at the injection scope.', '包装器使用的标准能力必须在替换位置引用宿主全局对象。'],
  ['No dedicated awaited member-fetch transport found.', '未找到经过 await 的专用成员 fetch 请求传输。'],
  ['Multiple complete dedicated site-status channels found.', '发现多个完整的专用站点状态通道，无法唯一选择。'],
  ['No complete supported channel found.', '未找到完整且受支持的通道。'],
  ['Another plausible blocked-consumption channel is outside the supported family.', '另一个可能使用阻止结果的通道超出了支持的模式范围。'],
  ['Target must be lossless UTF-8.', '目标文件必须能以 UTF-8 无损解码并还原。'],
  ['No CUA installation found; provide --app with its absolute path.', '未找到带有浏览器组件的 Codex 应用；请通过 --app 指定应用的绝对路径。'],
  ['Select one installation with --app.', '请通过 --app 选择一个应用。'],
  ['Node.js >=22.13.0 is required.', '需要 Node.js >=22.13.0。'],
  ['Installation information and target identity changed. The current file was checked independently; previous backups will not be restored to it.', '应用信息和目标文件身份均已变化。已独立检查当前文件；不会将旧备份恢复到此文件。'],
  ['Target file identity differs from its last trusted state.', '目标文件身份与上次可信状态不同。'],
  ['No trusted managed origin exists. Unsupported or modified contents cannot be adopted or restored. Similar wrapper bytes never prove tool provenance.', '没有可信的原始记录。无法接管或恢复不支持或已修改的内容；相似的包装代码不能证明内容来自本工具。'],
  ['Target directory must permit atomic replacement without elevation.', '目标目录必须允许在不提权的情况下原子替换文件。'],
  ['Managed recovery state must permit transaction publication without elevation.', '恢复数据目录必须允许在不提权的情况下写入操作记录。'],
  ['Target coordination directory must permit lease and replacement publication without elevation.', '目标协调目录必须允许在不提权的情况下写入锁与替换记录。'],
  ['Recover the incomplete transaction before ordinary writes.', '请先运行 recover 回滚未完成的操作，再进行普通写入。'],
  ['Target or recovery state is not trusted for writing.', '目标文件或恢复数据不可信，无法写入。'],
  ['Explicit confirmation of the inspected target is required.', '需要明确确认已检查的目标。'],
  ['Target, preparation or trusted state changed after inspection; inspect and confirm again.', '目标文件、准备数据或可信状态在检查后发生变化；请重新检查并确认。'],
  ['Managed selection changed after confirmation; inspect and confirm again.', '所选应用的恢复记录在确认后发生变化；请重新检查并确认。'],
  ['No trusted managed recovery record exists for this installation.', '此应用没有可信的恢复记录。'],
  ['An incomplete transaction requires recover; recovery rolls back rather than continuing.', '存在未完成的操作，需要运行 recover；恢复会回滚此次操作。'],
  ['Current target is not a trusted original or tool-applied state.', '当前目标文件不是可信的原始状态或本工具已应用的状态。'],
  ['Replacement source is not supported.', '替换后的应用文件不兼容。'],
  ['The replacement source is not supported.', '替换后的应用文件不兼容。'],
  ['Cannot establish the confirmed replacement snapshot.', '无法确认替换后应用文件的已确认快照。'],
  ['No trusted managed preparation. Unknown modifications cannot be restored.', '没有可信的准备数据，无法恢复来源未知的修改。'],
  ['Cannot establish the confirmed source snapshot.', '无法确认原始文件的已确认快照。'],
  ['Source is not supported by the CUA structural recipe.', '目标源码不符合站点状态补丁所需的结构。'],
  ['A managed target record exists but its recovery directories are missing.', '目标文件已有恢复记录，但对应的恢复目录缺失。'],
  ['Preparation uses an unsupported admission scheme. Use the original tool version and entrypoint to restore.', '准备数据使用了不支持的兼容性判定方案。请使用原工具版本和入口恢复。'],
  ['Unknown managed source. Restore with its original tool version and entrypoint; no migration was performed.', '无法识别恢复记录的来源。请使用原工具版本和入口恢复；未迁移数据。'],
  ['Managed locator paths or target identity changed. Operation stores cannot be migrated.', '恢复记录中的路径或目标文件身份发生变化；操作记录目录不能迁移。'],
  ['Managed recovery entrypoint differs from its exact tool version.', '恢复入口与记录指定的工具版本不符。'],
  ['Prepared bytes, evidence or transformation differ from fresh structural derivation.', '准备数据中的文件字节、证据或转换结果与重新进行的结构分析不符。'],
  ['Transaction belongs to a different admission scheme.', '操作记录属于不同的兼容性判定方案。'],
  ['Transaction lacks authenticated replacement identities; preserve recovery data and use its matching tool version.', '操作记录缺少经过认证的替换文件身份；请保留恢复数据，并使用与其匹配的工具版本。'],
  ['Operation backup does not match authenticated preoperation state.', '操作备份与经过认证的操作前状态不符。'],
  ['Operation backup does not match a known plan state.', '操作备份与已知的补丁状态不符。'],
  ['Target directory contains old or interrupted transaction artifacts; offline maintenance is required. No artifacts were removed.', '目标目录中存在旧操作或中断操作的残留文件；需要退出相关应用后手动处理。未删除任何残留文件。'],
  ['Target contents or filesystem identity are not a trusted original/tool-applied state.', '目标文件内容或文件系统身份不是可信的原始状态或本工具已应用的状态。'],
  ['Unknown current contents or target identity; recovery preserves the target and journal.', '当前内容或目标文件身份未知；恢复操作会保留目标文件和操作日志。'],
  ['Rollback did not restore preoperation content.', '回滚未能还原操作前的文件内容。'],
  ['No incomplete transaction; nothing to roll back.', '没有未完成的操作，无需回滚。'],
  ['Transaction already completed while acquiring locks; nothing to roll back.', '获取锁期间操作已完成，无需回滚。'],
  ['An incomplete transaction prevents selecting a replacement installation.', '存在未完成的操作，无法选择替换后的应用。'],
  ['Operation store contains an incomplete transaction; use recover.', '操作记录中存在未完成的操作，请运行 recover 回滚。'],
  ['Target has an incomplete transaction, possibly in another store; use recover with its store.', '目标文件存在未完成的操作，记录可能位于其他目录；请使用对应记录运行 recover。'],
  ['Another transaction requires recovery.', '另一个操作需要先恢复。'],
  ['No operation store exists for recovery.', '没有可供恢复的操作记录目录。'],
  ['Store contains multiple incomplete transactions; refusing to guess.', '记录目录中存在多个未完成的操作，无法唯一选择。'],
  ['Incomplete transactions changed while acquiring locks.', '获取锁期间，未完成的操作记录发生变化。'],
  ['Owner is absent from the process snapshot but death cannot be proven; retry.', '进程快照中未找到锁的持有者，但无法确认其已退出；请重试。'],
  ['Operation lock remains contended; retry.', '操作锁仍被争用，请重试。'],
  ['Cannot prove lock ownership.', '无法确认操作锁的归属。'],
  ['Lock history exceeds supported length.', '锁的历史记录超出了支持的长度。'],
  ['Invalid process enumeration header.', '进程列表的表头无效。'],
  ['Invalid process enumeration columns.', '进程列表的列格式无效。'],
  ['Invalid process identity enumeration.', '进程列表中的身份信息无效。'],
  ['Cannot establish this process identity.', '无法确认当前进程的身份。'],
  ['Cannot prove this process identity.', '无法确认当前进程的身份。'],
  ['Cannot safely enumerate processes.', '无法可靠地读取进程列表。'],
  ['Process checks use ps snapshots and executable/argument identities; processes may start after inspection. No process is terminated. Runtime loading and website operation remain not-verified. Running applications and related services only trigger warnings; process identity enumeration is required for concurrency locks.', '进程检查依据 ps 快照、可执行文件和参数信息；检查后仍可能有进程启动。不会终止任何进程。运行时加载和网站操作仍未验证。应用及相关服务正在运行时只提示警告；并发锁仍需要进程身份，无法枚举时不能写入。'],
  ['Fully exit the application and related browser services (browser-service and node_repl), then restart the application to load the changed files.', '请完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用，使修改后的文件被加载。'],
  ['Packaged executable metadata is missing.', '工具包缺少可执行文件所需的名称或版本信息。'],
  ['Interactive stdin and stdout terminals are required for managed changes.', '修改应用文件需要交互式输入和输出终端。'],
  ['Select one listed installation number.', '请输入列表中的应用编号。'],
  ['No installation selected.', '尚未选择应用。'],
  ['Choose a listed action.', '请选择列表中的操作。'],
  ['No verified inspection token; inspect again.', '缺少有效的检查凭据，请重新检查。'],
  ['Invalid arguments.', '参数无效，请使用 --help 查看用法。'],
  ['Command failed.', '命令执行失败。'],
  ['Operation failed.', '操作失败。'],
  ['Cannot inspect installation.', '无法检查应用。'],
  ['Cannot inspect target.', '无法检查目标文件。'],
  ['Writing is blocked.', '当前条件不允许写入。'],
  ['Managed preparation is required.', '缺少此应用所需的补丁准备数据。'],
  ['Managed selection requires targets.', '需要选择目标文件。'],
  ['Status requires a managed target selection.', '查看状态前需要选择目标应用。'],
]);

// 未逐条翻译的消息仍按诊断代码说明原因；未知代码也不直接回显英文。
const diagnosticFallbacks: ReadonlyMap<string, string> = new Map([
  ['AMBIGUOUS_TARGET', '发现多个候选补丁位置，无法唯一选择。'],
  ['AMBIGUOUS_TRANSACTION', '未完成的操作记录不唯一或发生变化，无法确定恢复目标。'],
  ['BACKUP_CHANGED', '备份内容与可信记录不符。'],
  ['BLOCKED_CONSUMPTION', '阻止结果的使用方式不符合支持的结构。'],
  ['CACHE_CONFIGURATION', '缓存配置不符合支持的结构。'],
  ['CAPABILITY_ALIAS', '标准能力的别名使用方式不受支持。'],
  ['CAPABILITY_ESCAPE', '标准能力传出了可验证范围。'],
  ['CAPABILITY_MUTATION', '发现标准能力被修改。'],
  ['COMMAND_FAILED', '命令执行失败。'],
  ['CONFIGURATION_INITIALIZATION', '配置初始化不符合支持的结构。'],
  ['CONFIGURATION_WRITE', '配置赋值不符合支持的结构。'],
  ['CONFIRMATION_REQUIRED', '需要明确确认已检查的目标。'],
  ['CONSUMER_HELPER', '使用方的辅助函数不符合支持的结构。'],
  ['CONSUMER_MESSAGE', '使用方的错误消息不符合支持的结构。'],
  ['COORDINATION_NOT_WRITABLE', '无法写入目标协调目录。'],
  ['DYNAMIC_SCOPE', '动态代码可能修改相关链路。'],
  ['ERROR_FORMATTER', '错误消息格式化函数不符合支持的结构。'],
  ['ERR_PARSE_ARGS_INVALID_OPTION_VALUE', '选项的值无效，请使用 --help 查看用法。'],
  ['ERR_PARSE_ARGS_UNKNOWN_OPTION', '存在未知选项，请使用 --help 查看用法。'],
  ['IDENTITY_CHANGED', '读取或打开文件期间，文件身份或内容发生变化。'],
  ['INCOMPLETE_TRANSACTION', '存在未完成的操作，请先运行 recover 回滚。'],
  ['INSPECTION_CHANGED', '应用文件或恢复数据在检查后发生变化，请重新检查并确认。'],
  ['INSPECTION_FAILED', '检查目标文件失败。'],
  ['INSTALLATION_REPLACED', '检测到应用已被替换；已独立检查当前文件，不会恢复旧备份。'],
  ['INSTALLATION_UNAVAILABLE', '无法读取应用信息或浏览器组件。'],
  ['INTERNAL_PATTERN', '缺少分析所需的结构模式。'],
  ['INVALID_ARGUMENTS', '参数无效，请使用 --help 查看用法。'],
  ['INVALID_JOURNAL', '操作日志缺失、格式无效或与可信记录不符。'],
  ['INVALID_LOCK', '操作锁记录无效，无法确认其归属。'],
  ['INVALID_PREPARATION', '恢复文件缺失、损坏或与记录不符。请保留现有文件，不能自动恢复。'],
  ['INVALID_RECORD', '恢复记录格式无效。'],
  ['INVALID_SOURCE', '目标文件必须能以 UTF-8 无损解码并还原。'],
  ['INVALID_TOOL_IDENTITY', '工具包的名称、版本或可执行文件信息无效。'],
  ['JOURNAL_WRITE_FAILED', '保存操作日志失败，可能需要运行 recover 回滚。'],
  ['LEGACY_TARGET_ARTIFACTS', '目标目录中存在旧操作或中断操作的残留文件；未删除任何残留文件。'],
  ['LOCK_CONTENDED', '操作锁仍被争用，请重试。'],
  ['LOCK_HELD', '操作锁正被其他进程持有。'],
  ['METADATA_ESCAPE', '元数据传出了支持的解析范围。'],
  ['MISSING_CHAIN', '缺少相关链路的局部绑定。'],
  ['MIXED_BINDING', '相关值使用了不一致的词法绑定。'],
  ['NO_INCOMPLETE_TRANSACTION', '没有未完成的操作，无需回滚。'],
  ['NO_INSTALLATIONS', '未找到带有浏览器组件的 Codex 应用；请通过 --app 指定应用的绝对路径。'],
  ['NO_TARGET', '未找到符合补丁要求的站点状态通道。'],
  ['OPERATION_FAILED', '操作失败。'],
  ['OWNER_UNVERIFIED', '无法确认锁的持有进程已退出，请重试。'],
  ['PARSE_ERROR', '无法解析目标 JavaScript 源码或绑定关系。'],
  ['PATH_ALIAS', '路径不符合要求：必须使用规范化绝对路径，避免链接别名或目录重叠。'],
  ['PLAN_CHANGED', '复制补丁准备数据前后，其内容发生变化。'],
  ['POLICY_RECEIVER', '策略类或实例不符合支持的结构。'],
  ['POSTVERIFY_FAILED', '替换文件或提交操作前的校验失败。'],
  ['PROCESSES_RUNNING', '检测到应用或相关服务正在运行，仍可写入；写入成功后，请完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用。'],
  ['RESTART_REQUIRED', '请完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用，使修改后的文件被加载。'],
  ['PROCESS_CHECK_LIMITATION', '进程检查使用瞬时快照，检查后仍可能有进程启动；不会终止进程，运行时加载和网站操作仍未验证。活跃进程只触发警告；并发锁需要进程身份，无法枚举时不能写入。'],
  ['PROCESS_ENUMERATION_FAILED', '无法可靠地读取进程列表或确认进程身份，不能写入；并发锁需要进程身份来确认锁的归属。'],
  ['RECOVERY_CONFLICT', '当前文件内容或身份不符合可信状态；已保留目标文件和操作日志。'],
  ['RECOVERY_MATERIAL_MISSING', '目标文件已有恢复记录，但恢复数据缺失。'],
  ['RELATED_ESCAPE', '相关值传出了可验证范围或存在额外使用。'],
  ['RELATED_EXPORT', '相关绑定被导出给未知使用方。'],
  ['REQUEST_CONFIGURATION', '请求配置超出了支持的范围。'],
  ['RESPONSE_BODY', '解析后的响应未按要求传入 feature_status 的使用方。'],
  ['RESPONSE_CONSUMER', '响应的使用方不符合支持的结构。'],
  ['RESPONSE_ESCAPE', '响应被重新赋值或传出了局部使用范围。'],
  ['RESPONSE_INTERFACE', '响应仅支持 ok 和一次经过 await 的无参数 json()。'],
  ['RESTORE_SOURCE_REQUIRED', '缺少可信的原始文件或恢复记录，无法卸载补丁。'],
  ['ROLLBACK_FAILED', '回滚失败，请保留恢复数据并运行 recover 恢复。'],
  ['SCHEME_MISMATCH', '恢复数据使用的兼容性判定方案不匹配，请使用原工具版本和入口恢复。'],
  ['SELECTION_REQUIRED', '需要选择目标应用，并具备所需的补丁准备数据。'],
  ['SHADOWED_CAPABILITY', '标准能力被局部绑定遮蔽。'],
  ['STORE_NOT_FOUND', '找不到或无法初始化所需的恢复数据目录。'],
  ['STORE_NOT_WRITABLE', '无法写入恢复数据目录。'],
  ['TARGET_CHANGED', '操作期间目标文件或父目录发生变化，请重新检查并确认。'],
  ['TARGET_CONFLICT', '目标文件或恢复数据不是可信的可写状态。'],
  ['TARGET_NOT_WRITABLE', '目标目录不允许在不提权的情况下原子替换文件。'],
  ['TARGET_REPLACED', '目标文件身份与上次可信状态不同。'],
  ['TRANSPORT_CONSUMER', '请求传输函数存在不支持的调用或传出局部范围。'],
  ['UNKNOWN_BINDING', '无法解析相关局部绑定。'],
  ['UNKNOWN_HELPER', '相关辅助函数不符合支持的结构。'],
  ['UNPROVEN_CANDIDATE', '另一个可能使用阻止结果的通道尚未得到结构验证。'],
  ['UNSUPPORTED_INTERFACE', '相关属性或接口不符合支持的结构。'],
  ['UNSUPPORTED_MANAGED_RECORD', '不支持此恢复记录，请使用原工具版本和入口恢复；未迁移数据。'],
  ['UNSUPPORTED_PLATFORM', '仅支持 macOS。'],
  ['UNSUPPORTED_RUNTIME', '需要 Node.js >=22.13.0。'],
  ['UNSUPPORTED_SOURCE', '目标源码不符合站点状态补丁所需的结构。'],
  ['UNSUPPORTED_STRUCTURE', '相关语法或控制流不符合支持的结构。'],
  ['UNSUPPORTED_VALUE', '相关字面量不符合支持的结构。'],
  ['UNTRUSTED_RECORD', '恢复记录不可信，请保留数据并使用匹配的工具版本处理。'],
  ['UNTRUSTED_STORE', '恢复目录、文件权限或密钥不符合可信要求。'],
  ['UNVERIFIED_SOURCE', '没有可信的原始记录，无法接管或恢复未知修改。'],
  ['WRAPPER_BINDING', '响应包装器使用的标准能力必须引用宿主全局对象。'],
  ['WRITE_BLOCKED', '当前条件不允许写入。'],
]);

const systemMessages: ReadonlyMap<string, string> = new Map([
  ['EACCES', '权限不足，无法访问文件或目录'],
  ['EPERM', '系统不允许执行此操作'],
  ['ENOENT', '文件或目录不存在'],
  ['EEXIST', '文件或目录已存在'],
  ['ENOTDIR', '路径中的某一部分不是目录'],
  ['EISDIR', '需要文件，但指定路径是目录'],
  ['ENOTEMPTY', '目录非空'],
  ['EROFS', '文件系统为只读'],
  ['ENOSPC', '磁盘空间不足'],
  ['EDQUOT', '磁盘配额不足'],
  ['EIO', '文件系统读写失败'],
  ['EMFILE', '当前进程打开的文件过多'],
  ['ENFILE', '系统打开的文件过多'],
  ['EBUSY', '文件或资源正被占用'],
  ['EXDEV', '无法跨文件系统执行此操作'],
  ['ELOOP', '符号链接层级过多或存在循环'],
  ['ENAMETOOLONG', '路径名称过长'],
  ['EINVAL', '系统调用参数无效'],
  ['EBADF', '文件描述符无效'],
  ['EINTR', '系统调用被中断'],
  ['EAGAIN', '资源暂不可用，请重试'],
  ['ESRCH', '进程不存在'],
  ['ETIMEDOUT', '系统操作超时'],
  ['ECANCELED', '系统操作已取消'],
  ['ENOSYS', '系统不支持此操作'],
  ['ENOTSUP', '系统或文件系统不支持此操作'],
  ['EOPNOTSUPP', '系统或文件系统不支持此操作'],
]);

// 只读取标准系统错误格式中的代码和调用数据，保留路径，不回显英文原因。
function systemDetails(message: string): string[] {
  return Array.from(message.matchAll(/\b(E[A-Z0-9]+):[^,\n]*(?:, ([a-zA-Z][\w]* (?:'[^'\n]*'|"[^"\n]*")(?: -> (?:'[^'\n]*'|"[^"\n]*"))?))?/g), match => {
    const code = match[1]!;
    const detail = match[2];
    return `${systemMessages.get(code) ?? '系统操作失败'}（${code}）${detail ? `；系统调用：${detail}` : ''}`;
  });
}

export function diagnosticMessage(diagnostic: { code: string; message: string; systemCode?: string }): string {
  const { code, message, systemCode } = diagnostic;
  const exact = diagnosticMessages.get(message);
  let translated = exact;

  if (translated === undefined) {
    if (code === 'PROCESSES_RUNNING') {
      const prefix = 'Related processes are running: ';
      if (message.startsWith(prefix)) translated = `检测到应用或相关服务正在运行，仍可写入；写入成功后，请完整退出应用及相关浏览器服务（browser-service、node_repl），再重新启动应用：${message.slice(prefix.length)}`;
    } else if (code === 'LOCK_HELD') {
      const match = /^Operation lock held by PID (\d+) \(([\s\S]*)\)\.$/.exec(message);
      if (match) translated = `操作锁由 PID ${match[1]}（${match[2]}）持有。`;
    } else if (code === 'UNSUPPORTED_PLATFORM') {
      const match = /^Only macOS is supported; received ([a-z0-9_-]+)\.$/.exec(message);
      if (match) translated = `仅支持 macOS；当前平台为 ${match[1]}。`;
    } else if (code === 'INCOMPLETE_TRANSACTION') {
      const match = /^Recover transaction ([a-f0-9-]+) before ordinary writes; rerun install or uninstall for its installation\.$/.exec(message);
      if (match) translated = `请先回滚操作 ${match[1]}，再进行普通写入；请为对应应用重新运行 install 或 uninstall。`;
    } else if (code === 'UNSUPPORTED_STRUCTURE') {
      const match = /^Expected ([A-Za-z]+), found ([A-Za-z]+)\.$/.exec(message);
      if (match) translated = `语法节点不符：需要 ${match[1]}，实际为 ${match[2]}。`;
    } else if (code === 'UNSUPPORTED_INTERFACE') {
      const match = /^Expected property ([\w$]+)\.$/.exec(message);
      if (match) translated = `需要属性 ${match[1]}。`;
    } else if (code === 'SHADOWED_CAPABILITY') {
      const match = /^Expected unshadowed ([\w$]+)\.$/.exec(message);
      if (match) translated = `需要未被局部绑定遮蔽的 ${match[1]}。`;
    } else if (code === 'MISSING_CHAIN') {
      const match = /^Missing related ([\w$]+) binding\.$/.exec(message);
      if (match) translated = `缺少相关的 ${match[1]} 绑定。`;
    }
  }

  // 已有中文参数错误可以直接展示；未知英文消息始终使用中文兜底。
  translated ??= /[㐀-鿿]/.test(message) ? message : diagnosticFallbacks.get(code);
  const details = systemDetails(message);
  const errorCode = systemCode ?? (/^E[A-Z0-9_]+$/.test(code) ? code : undefined);
  if (errorCode && !details.some(detail => detail.includes(`（${errorCode}）`))) {
    details.push(`${systemMessages.get(errorCode) ?? '系统操作失败'}（${errorCode}）`);
  }
  if (details.length) return translated ? `${translated} ${details.join('；')}` : details.join('；');
  return translated ?? '出现未识别的诊断，请根据诊断代码排查。';
}

export function evidenceDescription(evidence: { kind: string; description: string }): string {
  return evidenceDescriptions.get(evidence.description) ?? '此项证据暂无中文说明，请查看原始结果中的证据内容。';
}

export function assumptionDescription(assumption: string): string {
  return assumptionDescriptions.get(assumption) ?? '此项假设暂无中文说明，请查看原始结果中的假设内容。';
}
