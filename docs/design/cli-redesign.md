# 浏览器补丁 CLI 设计

当前产品仅使用托管 CUA 请求／响应结构模式。2026-10-21，用户明确废弃另一套显式 review plan 结构方案；其命令、插件缓存发现与完整依赖证明不再作为产品入口或实现契约。原设计保留在[历史规格](cli-redesign-spec.md)，当前使用见 [README](../../README.md)。工具尚未公共发布，没有旧发布版本兼容负担；历史调查与验收只证明当时的工具及样本。

## 命令与安装发现

项目、npm 包和可执行文件统一命名为 `codex-unfence`。普通入口为：

```text
codex-unfence install [--app <absolute-app-path>]
codex-unfence check [--app <absolute-app-path>] [--json]
codex-unfence uninstall [--app <absolute-app-path>]
```

默认发现 `/Applications` 与操作系统账户的 `~/Applications` 中的应用安装；`--app` 指定应用绝对路径。只检查相应应用内的 CUA service，不扫描插件 cache，不依据版本大小推断活跃安装。

- `check` 只读检查全部发现的安装，逐项报告结构支持、文件状态、写入条件和阻断原因。JSON 的 `data.inspections` 为完整结果，单一安装时提供 `data.inspection`。混合结果按运行失败、冲突、不兼容、成功聚合退出码，分别为 `1`、`4`、`3`、`0`；参数错误为 `2`。
- `install`／`uninstall` 在多个安装时交互选择，写前精确输入 `yes`。遇到未完成事务时，先单独确认回滚；成功后重新检查，再确认继续原请求。拒绝或恢复失败时停止，未知内容不能覆盖。
- 重复安装／卸载保持幂等；受支持的原版文件可直接报告未安装补丁。所有托管写入保留进程检查、来源校验、备份与事务门禁。相关进程仍运行或状态无法核实时拒绝写入，工具不结束或启动应用。

无子命令时进入默认交互 guide：选择安装、查看检查结果，再选择可用动作、重新检查或取消。保留的高级命令也使用同一托管流程及账户存储：

```text
codex-unfence apply [--app <absolute-app-path>]
codex-unfence restore [--app <absolute-app-path>]
codex-unfence status [--app <absolute-app-path>] [--json]
codex-unfence recover [--app <absolute-app-path>]
```

`apply`／`restore` 请求托管安装／卸载动作；`recover` 单独回滚未完成操作到开始前的状态，不继续原操作。`status` 只读查询一个安装，多安装时需用 `--app` 选择。默认 guide 和所有写入口要求真实 stdin/stdout 终端，拒绝 `--json` 自动写入；只有 `check`、`status` 支持 JSON。不再提供 `detect`、`prepare`、`--plan`／`--store` 或显式插件目标参数。

## 恢复资料与文件状态

原文、补丁副本、目标记录、工具版本、密钥及事务备份由托管层管理，位于 `~/Library/Application Support/codex-unfence/`；账户级协调历史位于 `~/.codex-unfence/target-leases/`。目录按操作系统账户身份确定，不受调用方 `HOME`／XDG 覆盖影响，独立于仓库和 npm cache。

保留匹配工具版本和完整本机恢复资料。历史开发方案、备份与维护证据仍须保留，但不作为当前产品自动接管的可信记录；删除废案代码不授权删除这些资料。不要移动存储或手工删除记录、密钥与锁，也不要用旧备份覆盖升级后的未知文件。历史 GitHub issue 和验收记录保留当时地址及身份。

`support`、`state`、`writeReadiness`、`allowedActions` 与 `runtime` 分别表示结构支持、磁盘状态、写入条件、可用动作和运行验证。未完成操作可以允许 `recover`，不能仅凭 blocked 状态推断恢复永不可用。回滚后取消后续动作时，报告必须承认已发生的恢复。目标旁旧事务残留和未知内容保留现场并报告，不提供跳过保护的入口。

补丁会使应用严格资源签名校验失败，工具不重新签名或关闭系统验证。恢复目标原文也不自动证明整个应用签名、宿主加载或网站访问成功。

## 结构模式与假设

当前模式只接受有限的专用站点状态链：请求来源与运输调用、同一响应的 `ok` 与无参 await `json()`、原 body 到 agent 严格 true 判定，再到原缓存／inflight 和对应阻断消费链。相关绑定、接收者与可见写入必须满足模式；未知相关语义、多个候选和额外消费会拒绝。不按变量名、桌面版本或历史整文件哈希准入。

对于包含 ZXing 的关联形态，仅识别同一 local factory 的有限资源加载与解码接口：configure／decoder wrapper 绑定、明确 `./zxing_reader.wasm` 及既有 `node_modules/zxing-wasm/dist/reader/zxing_reader.wasm` fallback、读取字节经 `Uint8Array` 拷贝到 `overrides.wasmBinary`、factory 内两方法 handle table、global-selector arrow 唯一作为 imports slot，并将 imports 关联到同一 factory 的 instantiate／instantiateStreaming（直接或有限 builder）。decoder 等待同一 prepare(factory,...)，再使用同一 module 的 `_malloc`、`HEAPU8`、`readBarcodesFromPixmap` 或 `readBarcodesFromImage`、`_free`。此处 prepare 是被分析源码中的调用，不是 CLI 命令；这不是对任意 ZXing 桥的普遍准入。

标准 URL／Map／Date／Object／Reflect／Error／JSON、runtime.fetch 和 response.json 按宿主契约行为；有限终端 formatter、bypass、display、origin、log 和 Error 构造保留原调用与返回用途，但展示和遥测行为不递归审计。文件内可见相关修改仍拒绝。特定资源与桥的核心前提按公开派生结果原文为：

> Only the linked finite ZXing reader resource and host bridge are assumed not to mutate the site-status chain, its configuration or standard capabilities throughout their lifetime; this noninterference is not proved. Resource bytes are not read or executed.

即只对已关联的有限资源与桥假设生命周期非干扰；没有证明完整依赖生命周期，也不读取或执行 Wasm。人类检查和写前确认都会显示依据与假设。ADR 0002–0004 的旧完整证明义务不再作为当前实现契约。

## 验证性能与交付

CUA 候选定位一次扫描 awaited member fetch，再沿父节点保留所有相关异步声明，避免为每个无关函数重扫整个 AST。每次公开托管操作只复用该操作内相同源码的纯结构分析结果；操作之间不共享缓存，返回值独立。目标文件、准备材料、权限、来源签名和事务备份仍按原有边界重新读取并验证。重复安装／卸载保留确认与事务保护，不替换已处于目标状态的文件。

Node.js >=22.13.0；开发与打包使用固定版本 pnpm：

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

```bash
pnpm pack
```

打包会构建产品。以实际返回的文件名运行本地包；当前 `0.2.0` 未公共发布：

```bash
npx --offline --package /absolute/path/codex-unfence-0.2.0.tgz codex-unfence --help
```

统一检查使用明确基线：

```bash
pnpm run check --base <implementation-base>
```

默认测试包含真实离线 npx 本地 tarball、独立 config/cache、外部最终 bin 系统夹具及合成 `.app`。macOS/Linux PTY 由 TypeScript helper 驱动系统 script 命令；Linux 通过夹具模拟 macOS 产品边界，核心场景不因无产品安装而 skip。测试不执行真实插件、不发业务请求。发布清单按 `dist/` 目录声明，构建先清理旧产物；测试、preload、源码与真实材料不进入包。工程隔离和当前测试入口见[协作协议](retro-guardrails.md)。

## 历史证据边界

结构任务在 `9756b61` 上通过 30 个纯行为测试，并仅以数据读取和解析既存历史私有副本：1,938,669 bytes，SHA-256 `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e`，结果为 supported、7 项 evidence，动态 UTF-16 半开范围 `[1084567,1084585)`。该结果由结构任务报告，不代表重新读取当前安装；不执行真实插件或资源，不验证当前安装、签名、宿主加载和网站行为，runtime 仍为 not-verified。哈希与区间仅记录该次样本事实，不成为准入常量。

后续真实往返、签名核验、用户反馈及未验证项见[真实验收记录](cua-wrapper-runtime-acceptance.md)。固定配方的[准备切片](cua-request-wrapper-slice.md)与[应用恢复切片](cua-wrapper-application-slice.md)只保存历史开发记录；测试通过、磁盘修改和用户反馈各自保留证据范围，不追溯扩大为本轮或任意版本验收。
