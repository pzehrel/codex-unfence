# CUA 请求包装器本地副本实现

状态：本地副本切片完成。副本核对、定向测试、独立双轴审查和统一检查通过；未应用到安装，不代表真实运行生效。

## 本轮交付

在桌面 `26.1013.40934 / build 20770` 的 `@oai/browser-desktop@0.1.1` service 专用站点状态通道注入响应适配器，原 fetch 和 agent 判定器保持原样。适配器延迟转发 ok，以原 response 为 receiver 调用 json，在正常解析的对象副本中仅将严格为 true 的 agent 改为 false。未知对象形态、缺失字段及其他值原样返回。

这是仓库内的本地准备切片，采用固定文件身份和已审阅区间，不声称通用结构证明；不接入正式 CLI 的 v1/v2 方案或 apply/restore，不进入 npm 包。

## 命令与私有输出

在仓库根目录运行。`evidence/` 必须已存在；输出只能是其中尚不存在的直接子目录。以下目录已经生成，再次使用会拒绝覆盖：

```bash
node scripts/cua-request-wrapper.mjs --source /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs --output-dir /Users/pzehrel/Documents/repositories/my/codex-browser-liberation-patch/evidence/cua-wrapper-26.1013.40934-reviewed
```

输出位于 `evidence/cua-wrapper-26.1013.40934-reviewed/`，包含 `source.original.mjs`、`source.patched.mjs`、`manifest.json` 和 `local-diff.txt`。目录权限实测为 0700，四个文件均为 0600。Git 忽略整个 evidence 目录；npm 使用原有逐文件白名单。真实源码、补丁和局部源码差异保留本机，不提交。

工具不提供身份覆盖参数；原始内容不匹配固定大小或 SHA-256 时拒绝，包括已打补丁的文件。输出路径拒绝已有目录、文件、符号链接及 `.app` 路径。

## 真实源码的只读变换证据

| 项目 | 结果 |
| --- | --- |
| 原始大小 | 1,938,669 bytes |
| 原始 SHA-256 | `44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e` |
| 补丁大小 | 1,939,582 bytes |
| 补丁 SHA-256 | `705bfdb0d8e1793a5c3760a97d9c3eaf2bf6959cc5cbbfe31914bb24cbcf1940` |
| 原替换区间 | UTF-16 `[1084567,1084585)`，原 await 成员调用 |
| 补丁替换区间 | UTF-16 `[1084567,1085498)` |
| 区间外 | 字符与 UTF-8 字节一致 |
| 语法 | 原始和补丁均经 Acorn 解析；独立复核再次解析补丁 |
| 安装文件 | 生成后重新读取，与原始副本逐字节一致 |

只将真实 service 作为数据读取、解析、变换；没有 import 或执行。对固定源码额外核对：精确 await 节点唯一，运输函数作用域唯一，注入引用的 Object、Reflect 在该函数及外层词法作用域未被遮蔽。运行时标准内建能力仍为假设，未执行真实插件验证；不宣称任意 Proxy、篡改内建对象或跨 realm 对象透明。

## 合成验证

`node --test tests/cua-request-wrapper.test.mjs`：9/9 通过。覆盖冻结原响应和 runtime、fetch 参数及 receiver、请求次数、ok 延迟读取、json receiver 及单次调用、直接值和 thenable、原错误身份、未知对象形态直通、原对象不变、其他字段及自有 __proto__ 数据保留、相邻运输不变、非 ASCII UTF-16 定位、区间外字节、过期范围和 CLI 拒绝边界。测试仅执行自写样例，不依赖真实安装。

候选提交 `8484454` 上的统一检查 `npm run check -- --base 77a23b14988e35973bf180867bef1de9f1ffe913` 通过：差异空白检查、TypeScript、全仓 ESLint、构建及 343/343 测试全部通过，0 失败、0 跳过；测试含安装 tarball 的公开 CLI 验收。此前的两文件 ESLint、TypeScript 及构建也通过。真实补丁副本作为输入时被固定身份门槛拒绝，未创建输出目录。

Standards 独立审查：0 项硬性违规、0 项需处理的基线异味；未重开旧分析器证明。Spec 独立审查：0 项确认的遗漏、额外范围或错误实现；另以独立自造内存样例复核包装器行为。两轴审查范围均为 `77a23b1...8484454`，不以统一测试替代审查结论。既有真实输出再次作为输出目录时被拒绝，manifest 保持一致；Git 未追踪任何 evidence 文件。

实现及直接研究依据保存在本地提交 `8484454b1d2702072bf03c5353f7a6b2027e7ace`；最终报告随后单独提交。后续报告更新不改变已审查实现。

## 证据限制

切片完成条件是私有本地副本、合成行为验证、独立审查与统一检查通过。当前活跃模块、宿主完整性接受、模块重载、旧缓存影响、实际字段改写及应用／撤销仍为 `not-verified`。源码保留原缓存、inflight、24 小时 TTL、HTTP 检查及异常链，旧缓存 true 或旧模块仍可能继续拒绝。

本轮不改变旧分析器和历史方案门禁，也不把此前缺失样本的失败验收改为通过。后续安装及真实运行需要另行明确范围。

依据：[本轮规格](../docs/design/cua-request-wrapper-slice.md)、[注入点报告](request-wrapper-injection-point.zh-CN.md)、[限定版本决策](../docs/adr/0005-version-scoped-empirical-validation.md)。研究报告中的本机工件和临时路径仅用于本地证据定位，不作为可分发输入。
