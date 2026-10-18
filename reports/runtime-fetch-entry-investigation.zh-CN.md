# runtime.fetch 入口调查：未找到已证实入口

日期：2026-10-18。

**结论：未找到已证实、用户可控制的运行时入口。** 指定版本的服务加载者、`runtime` 创建者与 `runtime.fetch` 实现仍未知。已有历史材料只定位了请求调用点，不能视为找到注入入口。因原版本材料不可用，本轮提前停止；没有换版本继续分析。

## 时间与边界

- 预算起点：2026-10-18T04:47:48Z。
- 实际开始记录：2026-10-18T04:48:34Z。
- 只读调查结束：2026-10-18T04:49:37Z。
- 报告完成记录：2026-10-18T04:50:28Z。
- 硬截止：2026-10-18T05:17:48Z。30 分钟是上限；材料断点已明确，未继续耗时。

本轮依据 [ADR 0005](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/adr/0005-version-scoped-empirical-validation.md:3)。用户已接受限定确认版本的实际生效与可撤销目标，不再要求完整静态证明；本轮仍仅授权只读入口调查，未授权实际注入或宿主实验。

指定插件版本继续为 `26.1013.31256`。没有新确认的桌面安装身份，本轮也没有将其他版本当作新的交付基线。

## 检查范围及直接结果

仅检查当前已授权的仓库、插件缓存和已有调查指针。未请求新目录权限，未读取未授权目录。

| 检查对象 | 检查方式与结果 |
| --- | --- |
| `~/.codex/plugins/cache/openai-bundled/{browser,chrome}` | 只列顶层目录名：browser 仅 `26.1013.40934`；chrome 为 `26.1013.40934`、`latest`。未读取这些条目的源码或 manifest，未解析 latest 作为版本选择。指定 `26.1013.31256` 目录不存在，因此其 client、manifest 也不可从原目录取得。 |
| 仓库 `evidence/` | 只列文件名与大小。现有内容均位于此前的 `asar-o8o1zl6s/`，没有 `browser-service.mjs` 或 `browser-client.mjs`。该 ASAR 来源属于旧版桌面 `26.1007.71326`，不作为指定版本加载链证据，也未为本轮展开源码分析。[1] |
| 仓库及 `/tmp/codex-spec9-build.iLFenp`、`/tmp/codex-spec-1.AVikSX` | 排除 `.git`、`node_modules`、`dist`，按 service/client 文件名列候选，再按原身份大小筛选；共 21 个 `browser-service.mjs` 名称候选，没有一个为原 1,462,840 bytes；`browser-client.mjs` 名称候选为 0。没有可核对为原样本的副本。未分析这些不同大小候选的源码。 |
| 原调查记录与已有定向摘录 | 读取既有 `current-real-samples.md`、协调记录及相关调查；对既有 JSON 摘录只检查是否包含 client、加载者、runtime 构造相关指针。未找到服务加载者、runtime 创建者或 fetch 实现记录。原记录确认 client 的历史身份，但未保留可供本轮追踪的 client 原文。[2][3] |

以上文件系统结果是本轮直接观察，记录于本报告；不是旧记录的当前存在性推断。四固定文件缺失已有独立记录，本轮没有反复轮询这些文件。[4]

原身份筛选依据：[2] 记录 service 为 1,462,840 bytes，SHA-256 `67f78205a36436e511de3687c104d10d39d91784593bb885883439ef8f2236bd`；client 为 169,663 bytes，SHA-256 `78f5a38ab02f23b68e4650e3bfe9ec2f269c5e004f30a1f59eee927a221a2e2f`。本轮候选无相同大小，未以其他摘要替换基线。

## 链条确认情况

| 关系 | 状态与直接来源 | 断点 |
| --- | --- | --- |
| 谁加载指定 `browser-service.mjs` | **未知。** 历史样本记录只证明模块导出 `classifyError`、`handleRpc`，并有 Node 标准模块导入。[2，第 38 行] | 没有原 client/启动 manifest/同版本加载器，不能确定 import 调用者、实际执行进程和启动选项。 |
| 谁创建传入的 `runtime` | **未知。** 历史运输包装接受 runtime 参数；未记录构造点。[2，第 33 行] | 没有对象创建、能力注册与 service RPC 入口的直接关联。 |
| 谁实现 `runtime.fetch` | **未知。** 历史调查明确只确认接口调用形状，不证明实现。[2，第 33 行] | 无法追踪到 Node fetch、IPC/RPC 对端、Rust HTTP 客户端或其他网络栈。 |
| 站点状态链是否调用这个成员 | **历史静态观察已定位。** 包装检查成员为函数后保留 receiver 调用；`fetchBlocked` 请求 GET、检查同一 HTTP 对象并解析 JSON。[2，第 32–37 行；3，第 15–17 行] | 这只是调用点，不是用户可控制入口，也不证明当前活跃路径。 |
| 用户是否能在初始化前控制相关入口 | **未证实。** | 缺少上述三环；没有同版本、同上下文可控启动/装载入口的直接证据。 |

“未知”不表示该机制不存在；表示当前材料不足以确认。没有用通用开源实现补足专有宿主事实，也未重复广泛官方文档研究。

## 停止原因与最小后续问题

**停止原因是指定对象及其直接加载材料缺失。** 放宽完整静态证明要求不能补出不存在的源材料。本轮既不能确证运行时入口，也没有证据证明运行时路线不可能。

唯一需要先解决的问题：**下一阶段由用户确认哪个桌面版本，并提供/授权访问与该版本对应的完整原始插件目录或已核对备份，至少包含 service、client、plugin/MCP 启动 manifest。** 若继续原版本，先取得 `26.1013.31256` 的对应材料；若用户改选新版本，应明确更新身份基线后再分析。不得自动选现有 `26.1013.40934` 或 latest。

取得材料后的最小只读动作是从 client/manifest 找 service 加载点，再追 runtime 的构造及 fetch 赋值。如果该链最终依赖插件包外的宿主代码，先明确所需目录和访问授权。本报告不要求立即运行宿主，也不建议先实现 wrapper 猜测入口。

## 来源与操作记录

1. [旧桌面调查的身份与 ASAR 来源](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/reports/codex-browser-restrictions.zh-CN.md:11)，第 11–21 行和第 179 行。仅用于识别现有证据目录的历史来源。
2. [指定版本历史只读样本记录](/tmp/codex-spec-1.AVikSX/current-real-samples.md:13)，service/client 身份第 13–18 行；请求包装、receiver、缓存及导出第 32–38 行。
3. [请求链历史定向调查](/tmp/codex-spec9-build.iLFenp/ticket-11.md:15)，第 15–17 行；真实静态拒绝与边界第 47–70 行。
4. [固定样本缺失记录](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/.scratch/spec9-real-acceptance/missing-fixed-samples.json:1)。
5. [原样本授权与调查指针](/tmp/codex-spec9-build.iLFenp/context.md:14)，第 14–16 行；[ADR 0005](/Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/docs/adr/0005-version-scoped-empirical-validation.md:7)。

本轮仅新增本报告。未复制专有源码进报告；未执行/import 真实 bundle，未执行/编译/实例化 Wasm；未启动、重启、终止 Codex；未连接调试口、抓流量、加载自定义代码或实现原型；未修改安装、用户配置、代理、证书、分析器、commit、push、PR 或 tracker。无需产品测试。
