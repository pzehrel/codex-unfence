# Codex 浏览器站点状态补丁

当 Codex 因站点状态中的 `feature_status.agent === true` 拒绝浏览器访问时，本工具修改本机插件，让该通道收到 `agent: false` 的响应副本。原请求和判定器保留，其他响应字段不变。

补丁仅处理这一类站点状态限制。用户授权、企业策略、登录要求和网站自身的访问限制仍然有效。

## 使用前确认

当前支持范围：

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS |
| 运行环境 | Node.js **≥22.13.0**、npm；下方下载命令另需 Git |
| 桌面应用 | **26.1013.40934 / build 20770** |
| 内置浏览器插件 | `@oai/browser-desktop@0.1.1` 的指定文件 |

工具还会核对插件文件的大小和 SHA-256。即使版本号相同，文件不同也会拒绝；其他版本目前不支持。

**补丁会修改应用内的签名资源，应用期间严格签名校验会失败。** 工具不会重新签名或关闭系统验证。已在上述固定安装上完成真实应用与恢复，用户反馈补丁期间可用；其他系统环境可能拒绝加载修改后的应用。

具体站点的访问效果仍需自行确认。活跃模块路径、实际响应字段改写及其他权限场景尚未独立验证，不能保证某个网站一定可访问。

## 开始使用

### 1. 下载并构建

以下工具随仓库提供，请在仓库中运行。

```bash
git clone https://github.com/pzehrel/codex-browser-liberation-patch.git
```

```bash
cd codex-browser-liberation-patch
```

```bash
npm ci --ignore-scripts
```

```bash
npm run build
```

```bash
mkdir -p evidence
```

### 2. 设置路径

下面使用已验证安装的路径 `/Applications/ChatGPT.app`。产品称呼为 Codex，但此安装的应用包名为 `ChatGPT.app`；如果安装位置不同，请填写实际路径。

在仓库根目录执行这一条命令，后续步骤沿用这些变量：

```bash
export CUA_TARGET="/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs" \
  CUA_PREPARATION="$(pwd -P)/evidence/cua-preparation" \
  CUA_STORE="$(pwd -P)/evidence/cua-operations"
```

`CUA_PREPARATION` 是准备目录，必须是本仓库 `evidence/` 下尚不存在的直接子目录。`CUA_STORE` 是保存备份和操作记录的专用目录，由工具创建。两者必须分开，路径应为不经过符号链接的绝对路径。

换终端后，先回到同一仓库并重新设置这些变量。恢复时必须使用原来的目录，不能临时换一个空目录。

### 3. 准备补丁

```bash
node scripts/cua-request-wrapper.mjs --source "$CUA_TARGET" --output-dir "$CUA_PREPARATION"
```

这一步只读取安装文件，生成原始副本、补丁副本、清单和局部差异，不修改应用。文件不受支持时停止，不要继续应用。

查看本次修改：

```bash
less "$CUA_PREPARATION/local-diff.txt"
```

按 `q` 退出查看。准备目录已存在时，脚本会拒绝覆盖；请先确认是否已有可用的准备资料，不要删除旧资料来重试。

### 4. 退出应用并应用补丁

完全退出 Codex 对应的桌面应用及相关浏览器服务。工具会检查相关进程；发现仍在运行时拒绝写入，不会替你结束进程。

```bash
node scripts/cua-wrapper-operations.mjs apply --preparation "$CUA_PREPARATION" --target "$CUA_TARGET" --store "$CUA_STORE"
```

成功后，目标应显示 `tool-applied (applied)`；重复应用可能显示 `tool-applied (already-applied)`。若命令失败，先按下方说明查询状态。

### 5. 重新启动并确认结果

手动重新启动桌面应用，再使用浏览器工具访问目标网站。查询文件状态：

```bash
node scripts/cua-wrapper-operations.mjs status --preparation "$CUA_PREPARATION" --target "$CUA_TARGET" --store "$CUA_STORE"
```

`tool-applied` 表示磁盘文件是本工具应用的补丁，不证明运行进程已加载它，也不保证网站访问成功。输出中的 `Runtime: not-verified` 表示工具不自动验证运行效果。

原插件的缓存机制保留，站点状态缓存有效期为 **24 小时**。修改文件不会立即清除旧的禁止结果；旧缓存可能影响试用结果。

## 恢复原版

先完全退出桌面应用及相关浏览器服务，再执行：

```bash
node scripts/cua-wrapper-operations.mjs restore --preparation "$CUA_PREPARATION" --target "$CUA_TARGET" --store "$CUA_STORE"
```

恢复后查询状态：

```bash
node scripts/cua-wrapper-operations.mjs status --preparation "$CUA_PREPARATION" --target "$CUA_TARGET" --store "$CUA_STORE"
```

完成实际恢复时应显示 `original (restored)`，且 `Group: complete`。`original` 表示文件是原始内容；`already-original` 表示此次无需修改。

对上述默认安装，可额外检查应用签名：

```bash
codesign --verify --strict /Applications/ChatGPT.app
```

通过时退出码为 0，通常没有输出。固定安装的真实恢复已验证原文字节、目录布局和严格签名恢复；如果应用其他内容也有变化，单独恢复此插件文件不保证整个应用签名通过。

恢复完成后，手动重新启动应用。

## 出错或操作中断

先运行前面的 `status` 命令，按结果处理：

| 状态或提示 | 处理方式 |
| --- | --- |
| `original` | 当前是原始文件。需要启用补丁时运行 `apply`。 |
| `tool-applied` | 当前是可信补丁。需要撤销时运行 `restore`。 |
| `incomplete` 或 `Pending group` | 存在未完成操作，使用提示中的所属存储运行 `recover`。 |
| `conflict` | 文件、备份或操作记录存在冲突。保留资料，依据诊断排查，不强行覆盖。 |
| 相关进程仍在运行 | 完全退出对应应用和服务后重试。 |
| `LEGACY_TARGET_ARTIFACTS` | 目标附近存在旧事务残留，需要单独离线维护。不要手工删除锁文件来绕过检查。 |

只有存在未完成事务时才需要 `recover`。若提示的所属存储就是前面设置的目录：

```bash
node scripts/cua-wrapper-operations.mjs recover --store "$CUA_STORE"
```

若提示其他所属存储，请使用提示的绝对路径。`recover` 回到**中断操作开始前的状态**，不会继续完成操作：应用中断通常回到原版；恢复中断可能回到补丁状态，之后仍需运行 `restore`。完成后再次查询状态。

操作命令可追加 `--json` 获取结构化结果；准备补丁命令直接输出 JSON，无需追加此参数。

## 应用更新与资料保留

计划更新桌面应用时，先恢复原版。更新后重新核对支持范围；新版本或新文件身份不受支持时停止，不要套用旧补丁。更新已经发生并导致冲突时，也不要用旧备份覆盖新文件。

请保留：

- 准备目录：`$CUA_PREPARATION`。
- 操作存储及其中的备份和记录：`$CUA_STORE`。
- 操作系统账户主目录下的 `.codex-browser-patch/target-leases/`：工具自动管理的协调记录。

协调记录位于应用包外，不随 `HOME`、XDG 或 `--store` 设置改变。不要手工清理这些记录，也不要同时运行旧版工具。应用与协调目录之间不支持原子替换时，工具会拒绝操作。

技术细节见 [补丁作用范围](docs/design/cua-request-wrapper-slice.md)和[验证结果与限制](docs/design/cua-wrapper-runtime-acceptance.md)。
