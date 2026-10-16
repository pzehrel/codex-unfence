# Codex Browser Site Status Patch

## Node.js CLI (current implementation)

The npm CLI provides macOS plugin discovery, finite AST structural compatibility
analysis, review plans, and durable apply/status/restore/recover transactions for
selected browser/chrome versions. Real Codex loading and website operation remain
**not verified**. Detection never executes plugin sources, modifies targets, or
creates plans/backups. The Python tools below are historical research and are not
used by the Node.js CLI.

Requires Node.js 22.13.0 or newer and npm. Build and install locally:

```bash
npm ci --ignore-scripts
npm run build
npm pack
npm install --global ./codex-browser-liberation-patch-0.1.0.tgz
codex-browser-patch --help
codex-browser-patch detect
codex-browser-patch detect --plugin-root /path/to/openai-bundled --json
```

Only the local install prefix receives CLI files. Do not run npm publish for this
local workflow. The npm package allowlist contains `dist/`; npm also includes
`package.json`, this README, and the bundled Acorn/eslint-scope runtime dependency
closure for offline local installation. Tests, test process fixtures, research,
real application artifacts, local plans, and backups are excluded.

Discovery enumerates `<root>/{browser,chrome}/<version>/scripts/browser-service.mjs`.
Default root is `~/.codex/plugins/cache/openai-bundled`, based on the current home
directory; `--plugin-root` overrides it. Relative paths resolve from the working
directory. Version metadata is the directory name, preserved verbatim without
semantic version filtering or selecting a maximum/running version. Symlinks are
followed for discovery; each entry reports its lexical absolute `path` and
canonical `realPath`. Aliases remain separate entries. This read-only discovery
behavior grants no permission for future write commands to follow aliases.
Artifacts sort by plugin (`browser`, then `chrome`), then version name using
lexical order. Missing roots/empty discovery succeed. Missing, non-file, or
unreadable artifacts produce errors while retaining other discovered entries.

### Output contract (schemaVersion 1)

Human-readable and JSON output share one command result. `--json` writes exactly
one JSON object and a newline to stdout, including command errors; stderr is
reserved for unexpected process-level failures. `--help` is plain text.

```json
{
  "schemaVersion": 1,
  "command": "detect",
  "outcome": "incompatible",
  "exitCode": 3,
  "data": {
    "pluginRoot": "/absolute/plugin/root",
    "artifacts": [
      {
        "plugin": "browser",
        "version": "directory-name",
        "path": "/absolute/plugin/root/browser/directory-name/scripts/browser-service.mjs",
        "realPath": "/canonical/path/scripts/browser-service.mjs",
        "availability": "readable",
        "compatibility": "incompatible",
        "analysis": {
          "patternVersion": "site-status-v1",
          "compatibility": "incompatible",
          "runtime": "not-verified",
          "target": null,
          "evidence": [],
          "diagnostics": [{"code": "NO_TARGET", "severity": "error", "message": "No complete supported site-status consumption chain found."}]
        }
      }
    ],
    "runtime": "not-verified"
  },
  "diagnostics": [{"code": "NO_TARGET", "severity": "error", "message": "No complete supported site-status consumption chain found.", "path": "/absolute/plugin/root/browser/directory-name/scripts/browser-service.mjs"}]
}
```

| Exit code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `success` | Every discovered readable target is compatible, or discovery is empty. |
| 1 | `runtime-error` | Unsupported platform, unreadable root/target, or discovery failure. |
| 2 | `usage-error` | Missing/unknown command, unknown/duplicate option, missing option value. |
| 3 | `incompatible` | At least one analyzed target is incompatible, including mixed results. |

Runtime errors take precedence over incompatibility; all available per-target
results and diagnostics remain visible. `data` is null when discovery could not
start. `command` is null for unrecognized/missing commands. `availability` is
`readable` or `unavailable`; `realPath` is null if resolution failed. Unavailable
targets retain `not-analyzed` and have no analysis. Readable targets have
`compatible` or `incompatible` plus `analysis`.

Diagnostics have `code`, `severity`, `message`, optional `path`, optional
`systemCode` (for example `EACCES`), and optional source `range`. Discovery codes
remain `NO_ARTIFACTS`, `INVALID_ARGUMENTS`, `UNSUPPORTED_PLATFORM`,
`ROOT_UNAVAILABLE`, `DISCOVERY_FAILED`, and `ARTIFACT_UNAVAILABLE`. Analysis codes
are `PARSE_ERROR`, `NO_TARGET`, `AMBIGUOUS_TARGET`, `UNPROVEN_CANDIDATE`,
`UNSUPPORTED_CHAIN`, `UNSUPPORTED_BINDING`, `REASSIGNED_BINDING`,
`ESCAPED_BINDING`, `UNSUPPORTED_INITIALIZATION`, `UNSUPPORTED_MUTATION`,
`UNSUPPORTED_SCOPE`, `UNPROVEN_SOURCE`, `UNPROVEN_RESPONSE`, `CHANGED_SEMANTICS`,
and `UNTRUSTED_PATCHED_SHAPE`. The last code identifies the supported response-copy
shape without claiming it was applied by this tool. Detection has no trusted
operation records. Automate against codes and fields, not prose. New fields and
codes may be added within schema 1; incompatible changes require a new schema.

### Selected multi-target transactions

Prepare selects exact paths reported by detect, or explicitly filters all
compatible artifacts. A plan can contain browser/chrome and multiple versions;
apply and restore operate on that exact selection and never infer a running
version. For example, using synthetic or explicitly authorized plugin roots:

```bash
codex-browser-patch prepare --plugin-root /absolute/plugins --all-compatible --output /absolute/new-plan
codex-browser-patch apply --plan /absolute/new-plan --store /absolute/private-store --json
codex-browser-patch status --plan /absolute/new-plan --store /absolute/private-store --json
codex-browser-patch status --target /absolute/plugins/browser/version/scripts/browser-service.mjs --target /absolute/plugins/chrome/version/scripts/browser-service.mjs --store /absolute/private-store --json
codex-browser-patch restore --plan /absolute/new-plan --store /absolute/private-store --json
codex-browser-patch recover --store /absolute/private-store --json
```

Before any target write, apply/restore validate every selected target, all plan
artifacts, authenticated store records and backups, process checks, and unfinished
transactions. An unknown state causes zero target writes. The store lock comes
first, followed by canonical, lexically sorted, deduplicated sibling target locks.
These target locks exclude operations using another store. Keep the private store
(mode 0700) and sibling `.codex-browser-patch.lock` successor history. A dead owner
alone never permits bypassing a published incomplete transaction.

Each target retains its actual before snapshot and bytes, desired after identity,
final snapshot, and previous provenance. Known original/applied mixtures and no-op
entries remain distinct; no-op targets are not renamed. Provenance follows each
path across plans with the same verified original/patched artifacts. Patch-shaped
contents alone never prove tool application. New authenticated journals use
`formatVersion: 2` with `targets[]`; existing v1 journals are authenticated in their
original representation before in-memory normalization. Reading never rewrites
v1 records, and recovering a pending v1 transaction retains its v1 representation.

Each replacement is atomic and fsyncs its file and parent directory. The group is
not a filesystem-wide atomic exchange. A later write failure rolls back targets
whose actual contents changed, including rename-then-error failures. Failed
rollback or journal persistence retains recovery evidence and does not report
success. SIGKILL recovery uses actual current before/after contents, rather than a
progress counter; recover can itself be interrupted and repeated. Recovery always
returns each target to this transaction's actual before state. An interrupted
restore normally returns to tool-applied content; an interrupted mixed operation
returns to its individual mixture. Recovery preflights the entire group: unknown
external contents anywhere preserve every target and the journal. Each backup is
also revalidated immediately before its rollback replacement. Locks cannot exclude
external updaters; changed identities or unknown contents are conflicts.

`schemaVersion: 1` remains stable. Transaction outcomes use exit 0 for success,
1 for runtime failure, 2 for usage errors, 3 for incompatibility and 4 for conflict.
Successful apply/restore/recover include per-target `state` and `action`. Status is
read-only and returns these additive group fields:

| Field | Meaning |
| --- | --- |
| `data.targets` | Exactly the selected paths, in plan or repeated `--target` order. States are `original`, `tool-applied`, `incompatible`, `conflict`, or `incomplete`. |
| `data.groupState` | `complete`, `incomplete`, `conflict`, or `incompatible`. Pending-group conflicts take precedence, then incompleteness, then incompatibility. |
| `data.pendingTransactions` | All incomplete groups in the selected store, plus groups found through selected target locks in other stores. Each includes owning `store`, `transaction`, `operation`, `state`, and every group target, including unselected members. |
| `targets[].pending` | Present for pending members. Includes owning `store`, `transaction`, `operation`, actual `before` state, `desired` state and `current`: `before`, `after`, `before-and-after` (no-op), or `unknown`. An unknown current state reports target/group conflict. |
| `data.transaction`, `data.operation` | Compatibility shorthand for exactly one pending group; null when no group or multiple groups exist. Use `pendingTransactions` for complete information. |

A pending group remains incomplete even when every target currently equals its
before state; only an authenticated terminal journal completes recovery. A
selected target can report `incomplete` while its group reports `conflict` because
another member has unknown contents. Status exits 4 for any discovered pending
conflict, 3 for selected incompatibility otherwise, and 0 for known states including
incomplete groups. Ordinary apply/restore remain blocked until explicit recovery.
Use the pending group's owning store for `recover`; another store cannot recover
its records. Human output displays the same state and recovery location.

Process checks fail closed, cover Codex/ChatGPT and browser-service executable
identities, and never terminate processes. They are `ps` snapshots, so new
processes may start afterward. Directory fsync and synthetic SIGKILL tests do not
establish power-loss durability. Same-user hostile edits able to read the private
HMAC key remain outside the local provenance trust boundary. File changes do not
establish runtime loading, cache refresh, host integrity acceptance or website
operation.

### Finite structural support: site-status-v1

The pure boundary is `analyzeSource(source: string): SourceAnalysis` in
`src/analysis.ts` (built as `dist/analysis.js`). It takes only source text and
returns `patternVersion`, `compatibility`, `runtime`, `evidence`, `diagnostics`,
and `target`. It performs no source execution or filesystem access. A compatible
result has exactly one target: the simple parsed-response identifier passed to
the agent-specific predicate. Target and evidence ranges are half-open JavaScript
UTF-16 code-unit offsets (`unit: "utf16"`), suitable for `source.slice(start, end)`;
they are not UTF-8 byte offsets. Incompatible results always have `target: null`.
`transformSource(source)` uses that boundary to generate a local response-copy
expression and reparse the output; prepare retains the original and transformed
artifacts for review and verified transactions.

The supported complete chain is intentionally narrow:

1. A module-level function with one simple parameter creates
   `new URL('https://chatgpt.com/backend-api/aura/site_status')`, calls
   `url.searchParams.set('site_url', parameter)`, and returns only
   `{endpoint: url.toString()}`. The unshadowed global URL constructor is required.
2. An async module-level transport function returns
   `await runtime.fetch(endpoint, options)` with its three parameters unchanged.
3. An async class method receives runtime/request, awaits that transport with
   `request.endpoint` and `{method: 'GET'}`, throws on `!response.ok`, awaits
   `response.json()`, then returns `agentPredicate(body)`.
4. A synchronous module function returns `genericPredicate(body, agentKey)`.
   The key is literal `'agent'` or a module-level `const` directly initialized to
   it before the class. The generic predicate returns false for non-object input,
   reads `feature_status`, and returns `isObject(features) ? features[key] === true : false`.
   Both object guards resolve to the same function implementing
   `typeof value === 'object' && value != null`. `==` for typeof, `!== null`, and
   minified `!0`/`!1` booleans are supported. Arrays retain JavaScript object
   semantics; no stricter schema is invented.
5. A second async method awaits the response method and returns only `{blocked}`.
   A third builds the request from its checked-site parameter, awaits the second
   method with the same runtime/request bindings, and throws on `result.blocked`.
   Both calls use the same class's `this` and static method names.

All helper parameters and relevant local bindings must be simple identifiers with
one definition and no reassignment. Functions and classes must be module-level
declarations; function bindings may only be referenced as direct callees. The
class has unique instance methods, no inheritance, constructor, fields, accessors,
static or computed definitions. Reads may use dot properties or static string
computed properties; the generic feature lookup uses its bound key. Object
literal keys must be static noncomputed fields. Function/local/method names,
quotes, comments and whitespace do not determine compatibility. Versions and
whole-file hashes do not determine compatibility.

Additional statements, aliases, destructuring, inline/split predicates, dynamic
keys, nested/expression classes, or other control flow are unsupported. A complete
chain plus any other class method containing a plausible `.blocked` consumption
is refused if the latter cannot be proven; two complete chains are ambiguous.
Unrelated similar predicates without a consumption chain do not create targets.
For conservative alias protection, any property assignment/update/delete,
`eval`, or recognized reflective object mutation anywhere in the source is
rejected, even if apparently unrelated. This is a finite static proof under
ordinary JavaScript built-in behavior, not a general runtime integrity guarantee.

**Known real-sample bound:** the researched bundle uses uninitialized `var`
constants assigned inside a deferred bundler initializer, URL construction split
across helpers, and cache/inflight query control flow. None is supported by
`site-status-v1`. A single textual assignment cannot prove initializer order.
Deferred keys receive `UNSUPPORTED_INITIALIZATION` when the surrounding chain
matches; more complex bundles may fail an earlier structural check. No actual
installed bundle was analyzed for this implementation, and no real-sample
compatibility or runtime success is claimed. Broadening these patterns requires
new positive/negative proof fixtures.

### Development and independent verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` builds and runs real CLI child processes against temporary plugin
roots and isolated homes, plus packs, installs offline into a temporary prefix,
and executes the installed public bin. All plugin sources are synthetic. Core
tests never require Codex and never skip because Codex is absent. On CI, explicit
`--require` fixtures in `tests/fixtures/` inject macOS or unsupported platform
identity into test children only; the production CLI exposes no platform bypass.
Permission tests use temporary files with denied read permissions and expect an
unprivileged runner. GitHub Actions runs all checks on Linux and macOS with Node
22 and 24. Source responsibilities are command entry/output (`src/cli.ts`,
`src/result.ts`), installation discovery (`src/discovery.ts`), and pure structural
analysis (`src/analysis.ts`), review plans (`src/plan.ts`), and persistent
transactions (`src/transactions.ts`, `src/transaction-storage.ts`, and
`src/transaction-locks.ts`). Transaction tests inject filesystem/process boundaries
only through an explicit test-child `--require` fixture. They cover group preflight,
mixed provenance, cross-store locks, later-target failures, rollback failure,
authenticated v1 compatibility, real child SIGKILL windows, repeated interrupted
recovery and external modifications. Production exposes no guard bypass.

## Historical fixed-sample Python research

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
