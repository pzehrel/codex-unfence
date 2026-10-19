# CUA 包装器真实验收准备

状态：待执行。本文定义验收顺序，不是实际生效记录。应用／恢复工具实现见 [本轮切片](cua-wrapper-application-slice.md)，此前只读副本证据见 [交付报告](../../reports/cua-request-wrapper-implementation.zh-CN.md)。

## 当前目标

只接受桌面 `26.1013.40934 / build 20770` 内 `@oai/browser-desktop@0.1.1` 的既定 service。2026-10-19T02:03:13Z 再次只读复核原安装：1,938,669 bytes，SHA-256 `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e`，与私有原始副本逐字节一致；补丁摘要仍为 `705bfdb0d8e1793a5c3760a97d9c3eaf2bf6959cc5cbbfe31914bb24cbcf1940`。更新或外部变化后停止，不自动修改身份门槛。

2026-10-19 只读检查应用 `_CodeSignature/CodeResources`：目标 service 在 `files` 和 `files2` 中均有精确条目。因此修改该资源会使当前签名封存内容与文件不一致。尚未验证系统或宿主是否拒绝加载，不能承诺修改后能启动。工具不重新签名、不修改签名清单、不关闭系统验证；真实应用确认时必须明确接受这一影响，并保留恢复路径。修改前 `/usr/bin/codesign --verify --strict /Applications/ChatGPT.app` 返回 exit 0；这是静态签名基线，不是运行加载证据。恢复原文是否足以恢复完整签名状态仍需独立验证。

## 执行前必须明确

- 用户允许的真实安装写入及私有操作存储位置；明确接受封存资源不一致可能影响宿主加载，且工具不重新签名。
- 由用户退出／启动宿主，还是允许工具协助；文件事务自身只检查进程，不终止进程。
- 一个用户可访问、允许测试的具体 URL，以及允许的浏览器动作；不涉及登录凭证读取、下单、发消息或其他业务写操作。
- 验收结束后立即恢复，还是保留已应用状态；恢复工具与备份均须保留。

这些是影响下一步操作的选择，工具实现及合成验证可先完成。

## 验收步骤

1. **记录原始状态。** 重新核对版本与文件身份，保存只含必要元数据的记录。用选定站点确认原先拒绝确由站点状态触发；其他原因的拒绝不计为包装器失败或成功。
2. **退出宿主并应用。** 用户选定的维护窗口中确认相关进程退出，运行工具完成备份、意图持久化和原子替换。核对工具状态及安装补丁摘要。任何失败先读取状态，依照工具提示恢复中断事务，不手工绕过锁。
3. **重新加载并观察。** 使用明确的启动方式与同一 URL。确认实际加载对应 CUA 路径；只有文件变化，不能证明进程采用补丁。原链保留 inflight 和 24 小时缓存；旧模块或缓存导致的拒绝须单列，不能归因猜测。
4. **确认字段作用。** 所需证据是原站点状态成功解析且 agent 严格为 true 时，当前消费链收到副本中的 false；其他字段保持。浏览器访问成功仅是结果证据，不能单独证明具体字段发生改写。任何临时诊断注入须先明确范围，不能自行扩展读取账号状态或捕获无关流量。
5. **核对其他权限。** 源码保留并不等于运行时已经验证用户拒绝或企业策略。仅在现成且获准的拒绝场景核对原行为；没有场景则标记未验证，不编造企业策略或扩大账号操作。
6. **恢复与再加载。** 按用户选择恢复。恢复后核对原始字节摘要，重新加载宿主并确认可用；若恢复被外部更新或未知内容阻止，保留现场并报告，不强写覆盖。

## 准备好的命令形态

以下仅说明接口，`/absolute/...` 均需替换为审阅后的规范绝对路径。真实应用前先完成上述范围确认，并在仓库执行构建。工具不提供自动重启命令。当前 apply、status、restore 均须保留并提供原准备目录；recover 使用存储内保存并重新验证的方案，不需要原准备目录。操作存储和准备目录必须互不包含，且均应保留；不能手工清理锁来绕过未完成状态。

```bash
npm run build
```

```bash
node scripts/cua-wrapper-operations.mjs status --preparation /absolute/private-preparation --target /absolute/browser-service.mjs --store /absolute/private-operation-store
```

```bash
node scripts/cua-wrapper-operations.mjs apply --preparation /absolute/private-preparation --target /absolute/browser-service.mjs --store /absolute/private-operation-store
```

```bash
node scripts/cua-wrapper-operations.mjs restore --preparation /absolute/private-preparation --target /absolute/browser-service.mjs --store /absolute/private-operation-store
```

CUA status 以 `state: original` 表示当前字节是原始内容；存在可信、实际完成的恢复历史时，另给出 `action: restored`。首次未应用或只执行空操作 restore 不应显示该恢复标记。`state: tool-applied` 表示本工具可信应用状态；外部内容／身份变化返回冲突。

中断恢复回到该未完成操作之前的内容；这与普通 restore 返回原始内容的目的不同。只有状态报告存在未完成事务时，按提示对同一存储执行：

```bash
node scripts/cua-wrapper-operations.mjs recover --store /absolute/private-operation-store
```

## 通过标准与记录

分别记录：安装应用、活跃模块加载、目标响应改写、选定站点访问、其他权限行为、恢复原文、恢复后加载。每项使用 `verified`、`failed`、`not-verified`，并附时间和最小证据。部分通过不能汇总为全部完成。

当前这些真实运行项目均为 `not-verified`。本轮只完成工具和合成验证时，保持该结论。2026-10-19 的新工具只读 status 已确认安装为 original、没有创建操作存储；这项预检不表示已应用或加载补丁。
