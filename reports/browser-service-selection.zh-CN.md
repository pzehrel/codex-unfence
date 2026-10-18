# browser 服务分支的配置核对

日期：2026-10-18。**当前磁盘配置明确启用 CUA 的 browser surface，目标映射为 `@oai/browser-desktop/service`。传统 `node_repl` 的缓存 browser-service 映射同时保留，但 browser/chrome 指令字段为空，符合宿主配置 CUA 时的处理。**

配置层结论可信度高；没有读取运行进程、日志或会话，因此不能证明当前活跃模块，也不能认定传统服务绝不被调用。

## 范围与时间

用户 Q7 仅授权读取决定服务分支所需的少量配置字段，预算为 2026-10-18T07:13:40Z–07:28:40Z。本轮首次记录 07:14:03Z，最后配置字段核对 07:15:58Z，报告完成记录 07:16:48Z；已获得配置层答案，提前结束。

先检查已提取、已记录身份的当前宿主代码，再读取下面两个精确文件。两个文件均先核对真实路径，没有 symlink 越出已授权 `/Users/pzehrel/.codex`。没有递归搜索 `.codex`，没有读取 auth、token、sessions、history、conversations、logs、状态数据库或进程环境；没有启动或重启应用、执行 Node REPL、发业务请求或改设置。

初次系统 `python3 -I` 因没有 `tomllib` 在导入阶段失败，尚未读取配置；随后用本机 `python3.14 -I` 和标准库 `tomllib` 解析。只输出指定字段及归类结果，没有输出整份配置、无关模型/账号字段或环境值。

## 最少实际配置

第一份文件：`/Users/pzehrel/.codex/config.toml`，真实路径相同。

| 字段 | 结果 |
| --- | --- |
| `plugins."browser@openai-bundled".enabled` | true |
| `plugins."chrome@openai-bundled".enabled` | true |
| `plugins."unified-computer-use@openai-bundled".enabled` | true |
| `mcp_servers.node_repl` | 存在；未显式设置 enabled。 |
| `mcp_servers.node_repl.env.BROWSER_USE_TINYSKY_ENABLED` | `"1"`。 |
| 同一 env 的 `NODE_REPL_TRUSTED_SERVICES.browser` | 分类为传统 `.codex/plugins/cache/…/scripts/browser-service.mjs` 映射；未输出其他服务或完整环境。 |
| 同一 env 的 `NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER` | 空字符串。 |
| 同一 env 的 `NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME` | 空字符串。 |
| `mcp_servers.cua_repl` | 此文件顶层不存在；不能据此判断插件 CUA 服务未启用。 |

仅列精确 `plugins/cache/openai-bundled/unified-computer-use/` 目录的版本子目录，实际仅有 `26.1013.40934`；未自动选择 latest 或其他版本。

第二份文件：`/Users/pzehrel/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1013.40934/.mcp.json`，真实路径相同。身份为 2,274 bytes，SHA-256 `d8077727843322fcba05bab28bc9c6a63026bf205f2a0a958622fe9752e51c3b`。

| 字段 | 结果 |
| --- | --- |
| `mcpServers.cua_repl.enabled` | true |
| `env.CUA_REPL_ENABLED_SURFACES` | browser、computer |
| `env.NODE_REPL_TRUSTED_SERVICES.browser` | `@oai/browser-desktop/service` |
| command | 精确匹配当前 app 的 `cua_node/bin/node`。 |
| args | 精确匹配当前 app 的 `@oai/cua-repl/bin/cua-repl.mjs` 单一路径。 |

因此，**不能只看 config.toml 的传统缓存映射就选缓存文件作为补丁目标**。已启用插件自己的 MCP 配置是另一层直接证据。

## 静态读取、条件与优先关系

来源为当前版本提取的 `main-CLu1A25j.js`，SHA-256 复核仍为 `8aedee047ec0a078e65b24dc917c64ad544220395e773feb6740f4447008a495`。以下位置为一基行号、零基 UTF-16 起点；完整应用与归档身份见[宿主调查](host-runtime-entry-investigation.zh-CN.md)。

| 代码位置 | 与选择有关的行为 |
| --- | --- |
| 第 8 行，`browserUseTinysky` 默认值起点 68668 | 初始 feature 默认 false；这只是初始化默认，不能覆盖后续收到的值。 |
| 第 8 行，`q` / `hi` 起点 69447 / 69854 | q 读取当前内存 feature state；hi 以已有状态加新字段更新。 |
| 第 8 行，`gi` 起点 70225 | `CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES` 仅 Dev flavor 解析；当前分发为 prod。本轮不读取进程环境。 |
| 第 1346 行，`electron-desktop-features-changed` 处理起点约 3631817 | 从渲染端消息接收 `browserUseTinysky`、in-app/external browser 等字段，再交主进程更新；本轮未追渲染端上游远程 feature/default 来源。 |
| 第 32 行，`Ss` 起点 156573、`Jne` 起点 158245 | CUA 需要 browserUseTinysky、非 WSL、Node/REPL 路径、app-server 的 mcpToolExposure 支持，以及 unified-computer-use 已安装、启用、AVAILABLE；还需存在 browser backend 才加入 browser surface。 |
| 第 20 行，`ka` 紧接起点 100422 的 Oa | 按已安装插件 localVersion 找 `.mcp.json`，读取并合并 Aa 生成的 cua_repl 配置。 |
| 第 20 行，`Aa` 起点 101126 | 把原 node_repl command 放入 `CUA_REPL_NODE_REPL_PATH`，以 Node 启动 CUA launcher，browser 映射改为 `@oai/browser-desktop/service`。 |
| 第 33 行，`Ure` 起点 177667 | 生成并保存 node_repl 配置，同时配置插件 cua_repl；CUA 启用时调用 Oa 清空传统 browser/chrome 指令字段。Oa **没有删除**传统 trusted-service 映射。 |
| 第 33 行，`Zs` 起点 179843 | 本地请求在 browserUseTinysky 条件下使用先前 selection/cuaReplEnabled；未满足时回退普通配置。满足时加入 Aa 的 CUA 配置并清空传统指令。部分配置组装还依赖本轮未读取的运行状态。 |

这是**条件化的配置组装关系**，不是静态配置永远压过实时 feature state 的简单全序。config.toml 保存的 `BROWSER_USE_TINYSKY_ENABLED="1"` 与插件 `.mcp.json` 启用状态，支持“磁盘配置选择 CUA”；初始 false 默认不能推翻这些实际字段。反过来，磁盘字段也不能证明当前内存 feature、插件可用性、app-server 能力或已运行进程状态。

没有找到必须读取新的 `~/Library/Application Support` 文件才能解释已见配置的必要性，本轮不越出授权目录追远程特性缓存或其他用户状态。

## 补丁对象候选与最小后续动作

若后续继续限定版本的插件文件补丁路线，**优先核对 CUA 包的 service 文件**：

`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`

依据是该包 `package.json` 的 `exports["./service"]` 指向 `./scripts/browser-service.mjs`，包名 `@oai/browser-desktop`、包版本 `0.1.1`；这是桌面 `26.1013.40934` 分发内的模块路径。这个候选来自包导出与配置映射，并非本轮已验证的运行中补丁对象。本轮只读其 package.json，没有读取/执行该 service，没有写 patch，也没有将缓存 browser/chrome 的源码坐标套用过去。

最小后续动作是在明确后续范围后，先记录此候选文件身份并定向核对站点状态链；若需要证明活跃加载，须另行明确运行验证范围。当前证据足够避免优先修改错误的传统缓存文件，尚不足以宣称补丁必然作用于活跃请求。

本轮没有修改任何配置、安装文件、分析器或 tracker；没有提交、push、PR、新代理或额外实验。报告不保存配置正文或第三方源码。

来源：[当前宿主 main](../evidence/host-runtime-entry/asar-jr_a89ry/.vite/build/main-CLu1A25j.js:33)、[config.toml](/Users/pzehrel/.codex/config.toml)、[CUA 插件 MCP 配置](/Users/pzehrel/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1013.40934/.mcp.json)、[browser-desktop package.json](/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/package.json:6)。本地配置链接只供定位，不应整份打印或发布。
