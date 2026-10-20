# Codex 浏览器站点状态补丁

当 Codex 因站点状态中的 `feature_status.agent === true` 拒绝浏览器访问时，本工具修改本机插件，让选定通道收到 `agent: false` 的响应副本。原请求和判定器保留，其他响应字段不变。

补丁仅处理这一类站点状态限制。用户授权、企业策略、登录要求和网站自身的访问限制仍然有效。

## 使用前确认

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS |
| 运行环境 | Node.js **≥22.13.0**、npm |
| 插件 | 代码满足当前支持的有限结构模式；未知形态或多个注入候选会拒绝 |
| 写入前 | 自行完全退出对应桌面应用及相关浏览器服务，按提示明确确认 |

版本号不决定支持与否。工具读取并解析实际代码，检查站点状态来源、请求运输、同一响应的 `ok/json` 使用、严格布尔判定和对应阻断消费关系；变量改名或位置变化本身不会使受支持模式失效。哈希用于本次文件身份、外部变化和恢复校验。

分析依赖标准能力遵守宿主契约；匹配到特定 ZXing 资源与桥接口时，还采用其生命周期不干扰站点状态链的假设，不证明任意依赖安全。确认前会显示这些前提，详细范围见[结构模式与假设](docs/design/cli-redesign.md#结构模式与假设)。

**补丁会修改应用内的签名资源，应用期间严格签名校验会失败。** 工具不会重新签名、关闭系统验证、提权或替你结束与启动应用。其他系统环境可能拒绝加载修改后的应用。

检查通过、磁盘补丁成功和实际运行生效分别报告。新结构入口的合成测试不证明当前真实安装受支持或某个网站可访问；输出保持 `Runtime: not-verified`。历史固定安装的应用、恢复与签名结果见[验证记录](docs/design/cua-wrapper-runtime-acceptance.md)。

## 开始使用

当前仓库版本为 `0.2.0`，**尚未发布到公共 npm registry**。需要取得此版本构建出的本地 `.tgz` 产物；不能直接把公共 registry 下载当作可用步骤。下列命令通过 npm 临时获取本地包，无需全局安装。请将路径替换为实际产物的绝对路径，并保留该文件用于恢复。

```bash
export PATCH_PACKAGE="/absolute/path/codex-browser-liberation-patch-0.2.0.tgz"
```

### 1. 检查

```bash
npm exec --offline --yes --package "$PATCH_PACKAGE" -- codex-browser-patch check
```

工具只读发现安装并报告代码支持、文件状态和写入阻断；不会创建恢复存储。多个安装时，查看候选路径，再明确指定：

```bash
npm exec --offline --yes --package "$PATCH_PACKAGE" -- codex-browser-patch check --app /Applications/ChatGPT.app
```

产品称呼为 Codex，实际应用包名可能是 `ChatGPT.app`。请按发现结果填写准确路径，不根据名称或版本推断正在使用的安装。可追加 `--json` 获取结构化检查结果。

### 2. 退出应用并应用补丁

默认进入交互引导，先检查，再选择动作；多个安装必须主动选择：

```bash
npm exec --offline --yes --package "$PATCH_PACKAGE" -- codex-browser-patch
```

也可直接选择应用动作：

```bash
npm exec --offline --yes --package "$PATCH_PACKAGE" -- codex-browser-patch apply --app /Applications/ChatGPT.app
```

工具展示准确目标、支持依据、作用范围、签名影响和恢复材料保留说明。输入 `yes` 才修改文件，其他输入或 EOF 取消。npm 的 `--yes` 只确认获取包，不能代替工具的写入确认；无交互终端或写入命令带 `--json` 时拒绝。

相关宿主仍运行或进程无法核实时，写入停止。自行退出后可选择 `recheck` 重新检查，再确认。工具不会结束进程。检查后文件或可信材料变化，也会拒绝旧确认。

### 3. 重新打开并查询

成功后手动重新打开应用。补丁默认持续保留，不随工具退出而撤销。

```bash
npm exec --offline --yes --package "$PATCH_PACKAGE" -- codex-browser-patch status --app /Applications/ChatGPT.app
```

`tool-applied` 表示磁盘文件具有可信应用记录，不证明运行进程已加载它或网站访问成功。原缓存逻辑保留；修改文件不会清除旧的站点状态结果。历史固定安装的缓存有效期为 24 小时，不能据此推断所有受支持代码都有同一时长。

## 恢复原版

自行完全退出应用及相关服务，使用**同版本本地产物**执行：

```bash
npm exec --offline --yes --package "$PATCH_PACKAGE" -- codex-browser-patch restore --app /Applications/ChatGPT.app
```

仍需明确确认。完成实际恢复显示 `original (restored)`；重复恢复显示 `already-original`。再运行 `status`，确认后手动重新打开应用。

可自行额外检查整个应用签名：

```bash
codesign --verify --strict /Applications/ChatGPT.app
```

固定历史安装曾验证恢复后的原文字节、目录布局及严格签名。新入口不会自动运行签名验证；应用其他内容发生变化时，恢复此文件不保证整个应用签名通过。

## 出错或操作中断

先运行 `check` 或 `status`，保留恢复材料，依据诊断处理：

| 状态或提示 | 处理方式 |
| --- | --- |
| `original` | 当前是原文；满足支持条件时可以应用。 |
| `tool-applied` | 当前是可信补丁；需要撤销时运行 `restore`。 |
| `incomplete` | 存在未完成操作，选择 `recover`。 |
| `conflict` | 目标、准备材料、备份或记录不可信；不要强行覆盖。 |
| 进程阻断或枚举失败 | 自行退出相关进程；无法核实时停止写入。 |
| 未知结构或多个候选 | 等待适配；不按相似字符串猜测修改。 |
| 旧方案或旧目标旁残留 | 使用原工具及原存储处理，不能自动迁移，也不要手工删除锁。 |

中断恢复使用同一入口：

```bash
npm exec --offline --yes --package "$PATCH_PACKAGE" -- codex-browser-patch recover --app /Applications/ChatGPT.app
```

`recover` 回到**中断操作开始前的状态**，不会继续完成操作：应用中断通常回到原版，恢复中断可能回到补丁状态。恢复中断后仍可能需要再执行 `restore`。它与正常撤销补丁的 `restore` 不同。

## 应用更新与资料保留

计划更新桌面应用时，先恢复原版。更新后重新检查实际代码；已发生外部变化时，不要用旧备份覆盖新文件。

工具在操作系统账户主目录下自动保存私有恢复材料：

- `Library/Application Support/codex-browser-liberation-patch/`：准备副本、存储、备份、目标记录及确切工具版本。
- `.codex-browser-patch/target-leases/`：账户级协调历史。

目录不依赖调用位置、npm cache、包安装目录、`HOME` 或 XDG 设置。清理 npm **代码缓存**不会删除恢复资料，但再次运行仍需重新取得同版本工具；当前未公共发布，请保存原 `.tgz`。不要移动内部存储到新绝对路径，或手工删除准备材料、备份、记录与租约。恢复资料丢失时，工具不会仅凭补丁形状强行恢复。

高级旧入口、构建与本地打包方法见[CLI 与开发说明](docs/design/cli-redesign.md)。历史限定版本工具见[原准备切片](docs/design/cua-request-wrapper-slice.md)与[应用恢复切片](docs/design/cua-wrapper-application-slice.md)，其固定身份门禁保持不变。
