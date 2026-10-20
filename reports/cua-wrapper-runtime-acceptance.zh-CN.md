# CUA 包装器真实验收记录

状态：2026-10-20 本轮应用、用户试用及恢复验收完成。补丁生效期间用户反馈效果良好；随后按约恢复原始文件，归档清理终态租约，严格签名校验通过。用户确认恢复后默认安全策略重新生效，属于预期正确行为。字段改写的直接运行证据等未验证项仍单独保留。已获准在当前固定版本写入已审阅补丁，使用淘宝首页只打开和读取，并在验收后恢复；宿主退出／重新打开由用户操作。不重新签名、不关闭验证。

## 2026-10-19 应用前检查

用户确认已退出。07:22:28Z 只读预检未发现相关宿主或 node_repl 阻断进程；安装仍为 1,938,669 bytes，SHA-256 `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e`。

首次真实 apply 返回 exit 4、PROCESSES_RUNNING，识别到的 PID 属于应用命令自身。其 --target 参数包含 browser-service.mjs，原进程检测把它误判为服务脚本。拒绝发生在创建操作存储及目标写入前。未绕过检查，转为修复该错误。

## 自进程误判修复

将进程替身中的 synthetic-cli 改为实际 process.argv 后，公开命令合成回归于 0.25 秒内复现相同 PROCESSES_RUNNING：预期 exit 0，实际 exit 4。最小修复为排除当前事务进程 PID；事务自身不加载目标模块，其他进程仍按原保守规则检查。新增独立 node browser-service 进程的阻断断言。

定向 18/18、构建、类型、lint 通过。统一检查 `npm run check -- --base a614d74` 通过 352/352，0 失败、0 跳过，独立复核无新增问题，修复提交 20bb0a9。本次实际写入前再次执行 codesign --verify --strict，exit 0。

## 应用目录权限阻断

修复后真实 apply 在创建目标旁 .publish 临时文件时返回 EPERM；沙箱外执行同一已授权命令仍失败。只读 status 返回 original，无未完成事务；原始摘要保持一致，安装目录未发现事务残留。操作存储已创建，但未发布目标事务。

07:30:02Z 的 TCC 精确请求 36090.11 明确：service=kTCCServiceSystemPolicyAppBundles，responsible identifier=com.anthropic.claude-code，accessing=node，AUTHREQ_RESULT authValue=0。责任路径为 Claude 内置 claude-code 的 claude.app/Contents/MacOS/claude。故当前阻断是 macOS 应用管理权限拒绝，不是文件属主、只读标记或工具沙箱；没有改权限、移除属性或绕过系统验证。等待用户在系统设置中处理应用管理授权后继续既有应用范围。真实安装再次应用需在这些检查完成后执行既有授权，无需重复询问。

## 用户开启权限后的重试

用户报告已开启应用管理权限。07:39:59Z 预检仍为固定原始摘要、1,938,669 bytes、0644，相关阻断进程为空。随后按既有授权重试 apply，仍在创建目标旁 `.publish-30924561-3143-459d-b5c7-794e1631e8bd` 时返回 EPERM。失败后 status 为 original、pendingTransactions 为空、transaction 为 null。

07:40:12Z 的 TCC 请求 36090.56 仍明确拒绝 `kTCCServiceSystemPolicyAppBundles`：subject 为 `com.anthropic.claude-code`，`authValue=0`、`authReason=2`。责任应用为 `/Users/pzehrel/Library/Application Support/Claude-3p/claude-code/2.1.299/4fa9694b7975/claude.app`。因此用户报告的权限变更尚未对本次责任进程生效；不能据此断言用户开启了哪个条目或必须重启。下一步是在系统设置中核对或添加该准确应用，不更换执行渠道规避系统拒绝。

## 2026-10-20 成功应用

用户报告已添加准确的责任应用，并随后确认已退出 Codex。04:15:49Z 预检阻断进程为空；目标仍为固定原始摘要和大小。随后真实 apply 返回 success，事务 `85925e56-7176-4f69-af29-447c44f26687` 已提交。此前 04:01:12Z 的预检曾发现宿主及 node_repl 仍运行，当时没有执行写入。

04:16:08Z 独立核对：安装为 1,939,582 bytes，SHA-256 `705bfdb0d8e1793a5c3760a97d9c3eaf2bf6959cc5cbbfe31914bb24cbcf1940`；事务 before.mjs 为 1,938,669 bytes、固定原始摘要，与准备目录原始副本逐字节一致。journal 为既定 CUA scheme、operation=apply、phase=committed；操作存储及事务目录 0700，备份和 journal 0600，安装文件 0644，所核对路径均非符号链接。

公开 status 返回 tool-applied、groupState=complete、pendingTransactions 为空。补丁后 `codesign --verify --strict /Applications/ChatGPT.app` 返回 exit 1：`a sealed resource is missing or invalid`，与用户已接受的资源封存不一致风险相符；没有重新签名或关闭验证。此结果不能证明宿主是否仍可启动。等待用户重新打开 Codex，只打开和读取淘宝首页；完成后退出宿主，立即按既定范围恢复并核对原始摘要、签名及恢复后的启动。

## 用户运行反馈

2026-10-20，用户反馈：“codex在工作了。效果很好”。据此确认用户观察到宿主能够运行，且使用效果良好；该反馈未明确描述淘宝首页的访问结果，也未提供活跃模块路径或原始站点状态响应，故不把它升级为具体字段改写、淘宝访问或其他权限行为的独立验证。未读取用户会话、凭证或业务内容。

按已确认的验收结束后立即恢复安排，已请用户结束测试并退出 Codex。恢复写入将在重新确认无阻断进程后执行，不在宿主运行时强行替换，也不主动终止用户进程。

## 2026-10-20 恢复原文与签名排查

用户确认已退出后，04:39:18Z 预检无阻断进程，安装仍为固定补丁摘要。真实 restore 成功，事务 `b7ec68d7-91b7-4ee6-86af-5268b2a8b513` 已提交。04:39:36Z 独立核对安装为 1,938,669 bytes、SHA-256 `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e`，与准备目录原文逐字节一致；文件为 0644、非符号链接。status 为 original、action=restored、groupState=complete，无未完成事务。

恢复后严格签名校验仍返回 exit 1。verbose=4 只报告目标 scripts 目录新增的四个租约链文件：`.codex-browser-patch.lock` 及三个 `.next` 文件；未报告恢复后的 service 内容不匹配。原文恢复与恢复整个签名状态必须分别记录。独立核对确认现有工具通过追加释放记录保留租约历史，没有内建终态清理命令。该遗漏会使签名在源码恢复后仍因新增文件失败；不代表存在未完成事务。没有重新签名或关闭验证。

04:43:07Z 在宿主退出、没有其他补丁事务运行的离线窗口完成定向清理：先验证完整四文件链、最后一条 released=true、两个所有者进程均已不存在、两份 HMAC 认证 journal 均为 committed、引用的存储与事务完全匹配、安装原始摘要正确；将四文件及摘要／inode 清单归档到私有操作存储的 `completed-target-lease-archive-b7ec68d7`。删除前再次验证完整链、字节和文件身份，仅移除这四个已核验文件并同步目录；未删除操作存储、备份、准备工件或 journal，未绕过活跃或未完成事务。一次性脚本 `.scratch/cua-released-lease-cleanup.mjs` 仅用于此验收现场，不是生产通用清理接口。

04:43:16Z 最终核对：原始摘要及大小保持一致，scripts 目录无本工具事务残留；公开 status 仍为 original、action=restored、groupState=complete、pendingTransactions 为空。`codesign --verify --strict /Applications/ChatGPT.app` 返回 exit 0。恢复后的实际启动留给用户重新打开确认。

## 恢复后用户确认

用户重新使用后报告安全策略拦截。再次只读 status 确认为 original／restored、无未完成事务，严格签名校验仍为 exit 0。用户随后明确：“就是补丁撤销之后的默认安全策略起作用了。这只预计的正确行为。”据此记录恢复后宿主已可使用，默认策略重新生效符合用户预期，不作为恢复故障继续排查。

本轮已取得真实应用、用户试用反馈、逐字节恢复、签名恢复及恢复后默认策略行为的证据。总体运行反馈与撤销后的策略恢复构成用户观察到的前后差异；未捕获原始站点状态响应，也未直接观察字段改写，不据此宣称所有策略或权限场景均通过。

## 验收状态

| 项目 | 状态 |
| --- | --- |
| 当前固定原始身份 | verified |
| 应用前相关进程退出 | verified，2026-10-20T04:15:49Z 快照 |
| 淘宝补丁前访问基线 | not-verified，尚未收到结果 |
| 安装应用 | verified，固定补丁摘要、可信已提交事务及原始备份均已核对 |
| 活跃模块加载 | not-verified |
| 目标响应字段改写 | not-verified |
| 淘宝补丁后访问 | not-verified |
| 其他权限行为 | not-verified |
| 实际恢复原文 | verified，逐字节一致、可信 restored 状态、恢复事务已提交 |
| 恢复后签名 | verified，归档清理已释放租约后严格校验 exit 0 |
| 恢复后加载 | verified，用户确认默认安全策略重新生效，属于预期正确行为 |

测试地址为 `https://www.taobao.com/`。没有基线时可记录补丁后行为，但不能单凭访问成功归因于补丁。依据：[验收准备与授权](../docs/design/cua-wrapper-runtime-acceptance.md)。
