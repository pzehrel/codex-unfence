# CUA 包装器应用与恢复工具

状态：工具切片完成，独立审查修复及最终统一检查通过。真实安装未修改，真实宿主及站点验收未执行。

## 交付

新增仓库内的限定版本 apply、status、restore、recover 命令。输入为前一切片的私有准备目录，目标必须显式指定；manifest 中的 origin 仅表示来源，不能选择写入目标。

原始身份固定为 SHA-256 `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e`、1,938,669 bytes；共享配方重新计算补丁，并要求摘要为 `705bfdb0d8e1793a5c3760a97d9c3eaf2bf6959cc5cbbfe31914bb24cbcf1940`。manifest、差异和工件均须与重算结果一致。仅相信 manifest 的摘要不足准入。

协调者把此前真实原始副本仅作为数据重算，确认补丁、manifest 和局部差异与前一切片完全一致，没有执行其源码。原 fetch、判定器和包装器行为保持前一切片的契约。

## 命令与状态

入口为 `scripts/cua-wrapper-operations.mjs`，构建后在仓库运行。apply、status、restore 显式传入 `--preparation`、`--target`、`--store`；recover 仅传同一 `--store`，回到未完成操作之前的内容。支持 `--json`，无强制、身份覆盖或跳过进程检查参数。完整命令形态见 [验收准备](../docs/design/cua-wrapper-runtime-acceptance.md)。

普通 status／restore 仍要求原准备目录，recover 使用存储副本。准备目录与操作存储必须互不包含。CUA 与旧结构方案混合存储保守拒绝，须分别保留专属存储。

CUA status 的 original 表示当前为可信原始内容；真实完成 restore 后另给出 action: restored。首次空操作 restore 不产生标记，后续空操作不抹去可信恢复历史。tool-applied 表示可信应用状态；外部内容或身份变化为冲突，未完成操作单列 incomplete。

## 文件事务与旧行为

共用原有文件事务保护：原始备份、认证操作意图、操作存储和目标旁排他锁、重复进程检查、目标与父目录身份核对、原子替换、写后校验、失败回滚和显式中断恢复。CUA 与旧结构方案使用两个封闭准入适配器，保存副本和恢复时也重新校验对应方案；恢复不重新绑定当前 inode。

旧正式 CLI 的 loadPlan、结构分析器和历史方案门禁未改。共用事务抽为 transaction-engine，其编译文件补入 npm 精确白名单，保证旧 CLI 依赖闭合；CUA 脚本、准备目录和真实源码不分发。

进程检查仍是快照，无法排除检查后新启动的进程。相关宿主、browser-service 或独立 node_repl 仍运行，以及进程枚举失败时拒绝写入；工具不终止进程或重启宿主。

## 测试与独立审查

实现提交为 `1eb557b0d1d8dc15edef2063bf3513477cae3b22`，审查修复提交为 `00146df26e12dfe226d470d4b58995e0422b186d`。首轮统一检查通过 350/350，包含类型检查、lint、构建及安装 tarball 的完整公开 CLI 验收。

新增测试通过公开 CLI 与临时文件系统验证。成功路径在 crypto 系统边界仅把两份精确自写样本的摘要映射到固定身份；其他输入及 HMAC 保持真实。关闭替身后同大小的自写样本被拒绝。生产不提供测试身份或绕过参数；这些合成测试不证明真实来源身份，真实身份与配方另行只读核对。

Standards：无硬性违规。严格 JSON 解析形状重复为一项低优先级维护建议，本轮延期，以保留各准入校验并避免扩展旧解析器重构。定向修复复核无新增硬性问题。

Spec：首轮发现两项问题，均已先红后绿修复：存储位于准备目录内会污染后续校验；status 未区分已恢复状态。原审查者独立复跑两项回归，2/2 通过，确认两项关闭且无新增发现。

修复后 CUA 9/9 与既有包装器 9/9 共 18/18 定向测试通过；旧事务在抽取后回归 54/54，通过类型、lint 及差异空白检查。覆盖闭环、篡改、别名、外部身份变化、相关进程、幂等、备份先于替换、跨存储并发、应用／恢复中断后的恢复，以及目录包含和恢复状态回归。修复后再次运行 `npm run check -- --base 1466a29995f9117da3fb5a081899feb22132079e`，差异检查、类型、lint、构建和 352/352 测试全部通过，0 失败、0 跳过，包含安装包公开 CLI 验收。该次运行的实现内容对应修复提交 00146df；后续仅更新验证文档。

## 真实目标的只读预检

2026-10-19T02:03:13Z，安装 service 与私有原始副本逐字节一致，原始和补丁摘要仍匹配。新工具对真实准备目录和目标运行只读 status，返回 success、original、transaction null、runtime not-verified；指定的不存在操作存储保持 ENOENT。冻结候选后 02:16:12Z 及修复后再次得到相同结果；安装未变，没有实际 apply。

02:06:13Z 的只读快照发现桌面宿主和多个应用内 node_repl 运行。这不证明具体 service 已加载；按工具契约应拒绝写入，本轮没有终止进程。

目标 service 在应用 `_CodeSignature/CodeResources` 的 files、files2 均有精确条目。修改会造成封存资源不一致，实际加载是否受阻未验证。修改前 `/usr/bin/codesign --verify --strict /Applications/ChatGPT.app` 返回 exit 0。工具不重新签名或绕过完整性验证；恢复原文后仍需重新核对签名及加载状态。

## 真实验收边界

[验收准备](../docs/design/cua-wrapper-runtime-acceptance.md)列出维护窗口、目标站点、加载与缓存、字段作用、其他权限及恢复的独立通过标准。真实安装应用、活跃加载、响应字段改写、站点访问、其他权限行为、实际恢复及恢复后宿主状态均为 `not-verified`。

依据：[应用与恢复规格](../docs/design/cua-wrapper-application-slice.md)、[前一切片交付](cua-request-wrapper-implementation.zh-CN.md)、[ADR 0005](../docs/adr/0005-version-scoped-empirical-validation.md)。
