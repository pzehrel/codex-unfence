# Codex Browser Site Status Patch

针对本机已分析的 Codex Desktop `26.1007.71326`，在浏览器插件的站点状态响应消费点，将本地 `feature_status.agent` 固定为 `false`。

该项目包含静态逆向记录和可恢复的本地补丁工具。当前只生成了补丁副本，未修改已安装应用，未验证应用运行时是否接受修改后的插件。

## 补丁改了什么

浏览器插件 `Zy.fetchBlocked()` 的响应判断，从：

```javascript
return vS(o)
```

改为：

```javascript
return vS({...o,feature_status:{...o?.feature_status,agent:!1}})
```

它为当前消费点构造一个副本，将 `agent` 固定为 `false`，再交给原来的解析器。其他字段和原始响应对象保持不变。请求、HTTP 状态及 JSON 解析逻辑仍然保留。

补丁仅处理站点状态判断。企业策略、用户已保存的拒绝、协议校验、Auto-review 和 Full CDP 权限仍走原有路径。修改后的对象仅用于浏览器插件这一处判断，不会改变 Electron 主进程另一条用于侧栏评论模式的站点状态读取。

## 支持范围

| 项目 | 当前支持 |
| --- | --- |
| 插件版本 | `26.1007.71326` |
| 目标 | `browser` 与 `chrome` 两份 `scripts/browser-service.mjs` |
| 原始 SHA-256 | `4295ad5e22e0504b53e32daa4844169610fd65a613290593649b97277b12978f` |
| 补丁 SHA-256 | `5dc1e7a40806089a9d1aff93120dcfc4135b6e2debf9118b798297c8b5d14b44` |
| 安装目录 | `~/.codex/plugins/cache/openai-bundled` |

未知哈希、不同版本或不唯一的代码匹配都会拒绝。应用升级后应重新分析，不能直接复用此版本补丁。

## 使用

以下命令在项目根目录执行。Python 仅使用标准库。

检查当前状态：

```bash
python3 -I scripts/site_status_patch.py status
```

生成原始备份、补丁副本和记录目标路径及哈希的清单。输出目录必须尚不存在；本机已生成 `patch-plans/codex-26.1007.71326`：

```bash
python3 -I scripts/site_status_patch.py prepare --output patch-plans/codex-26.1007.71326
```

审阅补丁后，完整退出 Codex，再应用已准备的方案：

```bash
python3 -I scripts/site_status_patch.py apply --plan patch-plans/codex-26.1007.71326
```

重新启动应用和浏览器工具运行时，使修改后的模块加载，并清除旧进程内的 24 小时站点状态缓存。仅修改磁盘文件不能清除已加载模块或现有缓存；独立 CLI 会话中的浏览器工具进程也可能继续运行。脚本不自动终止进程。

再次检查文件状态：

```bash
python3 -I scripts/site_status_patch.py status
```

恢复前同样退出应用及相关工具运行时：

```bash
python3 -I scripts/site_status_patch.py restore --plan patch-plans/codex-26.1007.71326
```

`apply` 和 `restore` 先验证全部目标及备份内容，再逐文件原子替换。重复执行可识别当前状态。若文件已被升级或另行修改，会拒绝覆盖。第二个目标写入失败时，会尝试恢复第一个目标；若回滚不完整，会明确报告具体文件。备份和提取的专有应用文件已由 `.gitignore` 排除。

## 为什么选插件层

| 方式 | 所处位置 | 对本任务的取舍 |
| --- | --- | --- |
| 插件源码定点补丁 | Node 执行的 `browser-service.mjs` | 已找到唯一消费点；改动小，可记录哈希并恢复。当前实现采用此方式。 |
| Node 启动注入 | preload / loader / 启动包装器 | 需要验证工具进程启动方式、环境变量是否透传，以及 fetch 是否来自独立 transport。当前未实现。 |
| Electron 主进程补丁 | `app.asar` 中的 main bundle | 可处理侧栏评论模式的独立读取点，但还涉及打包、完整性和签名。浏览器插件判断不在这一进程，单改 Electron 不保证覆盖。当前未实现。 |
| Renderer 注入 | 页面或 DevTools 执行环境 | 页面里的 `window.fetch` 不等于插件的 `runtime.fetch`，不能据此认为能修改浏览器工具收到的策略响应。 |
| HTTPS 代理响应改写 | 网络层 | 依赖实际传输路径与证书信任；改动范围更广。当前未实现。 |

本补丁是对本地插件文件的定点修改，不属于运行时注入。它避免修改主应用归档，但这不代表插件完整性检查一定会接受它。应用可能校验插件、重新投影缓存、恢复原文件或在更新时覆盖；这些都需要应用实测确认。脚本没有禁用签名或完整性检查。

用户提到的第三方 API 界面没有给出具体项目，本项目不对其技术实现作推断。自建界面调用 API、修改 Desktop 前端、注入工具进程是不同路线。

## 验证

在临时插件目录中测试应用、恢复、重复执行、未知文件拒绝、补丁文件被改动、恢复时保护后续修改、写入失败回滚，以及响应副本对其他字段的保留：

```bash
python3 -I -B tests/test_site_status_patch.py
```

测试依赖本机仍保留已分析版本的原始 `browser` 插件副本；若文件存在但哈希不符会跳过。响应语义测试使用自行编写的短 JavaScript，不执行应用 bundle。

仅做补丁后的语法检查，不执行插件：

```bash
node --check patch-plans/codex-26.1007.71326/browser.patched.mjs
```

已完成：7 项测试及 browser/chrome 两份补丁语法检查。尚未完成：已安装应用中的运行时加载、插件完整性验证及真实网站工具操作。

## 分析资料

- [网站限制逆向报告](reports/codex-browser-restrictions.zh-CN.md)
- [原始关键代码摘录及哈希](reports/static-evidence.md)
- [结构化证据](reports/static-evidence.json)
- [补丁脚本](scripts/site_status_patch.py)
- [临时副本测试](tests/test_site_status_patch.py)
