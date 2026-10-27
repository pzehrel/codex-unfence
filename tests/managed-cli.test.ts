function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import type { CheckResult, OperationResult } from '../src/result.js';
type ManagedResult<C extends string> = C extends 'check' ? CheckResult : OperationResult;
import type { TestContext } from 'node:test';
import { repositoryRoot, sourceFixture } from './helpers/paths.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from './helpers/cli.js';
import { deriveCua } from '../src/cua-analysis.js';

const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));
const service = 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs';
async function sandbox(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'managed-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, 'home/Applications/Synthetic.app');
  const target = join(app, service);
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
  return { directory, app, target, source };
}
function run<C extends string>(box: Awaited<ReturnType<typeof sandbox>>, args: [C, ...string[]], env: NodeJS.ProcessEnv = {}) {
  const child = runCli([...args, '--json'], { directory: box.directory, fixture, env });
  assert.equal(child.stderr, '', child.stderr);
  const parsed: ManagedResult<C> = JSON.parse(child.stdout);
  return { code: child.status, result: parsed };
}

test('public check warns about active applications without blocking writes or creating recovery state', async (t: TestContext) => {
  const box = await sandbox(t);
  const { code, result } = run(box, ['check', '--app', box.app], {
    CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 987654, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }]),
  });
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.command, 'check');
  assert.equal(result.schemaVersion, 1);
  assert.equal(required(required(result.data).inspection).support, 'supported');
  assert.equal(required(required(result.data).inspection).writeReadiness, 'ready');
  assert.equal(required(result.data).runtime, 'not-verified');
  assert.deepEqual(required(required(result.data).inspection).blockers, []);
  assert.ok(required(required(result.data).inspection).allowedActions.includes('apply'));
  assert.ok(result.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning'));
  assert.deepEqual(await readFile(box.target), box.source);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
  const human = runCli(['check', '--app', box.app], { directory: box.directory, fixture, env: {
    CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 987654, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }]),
  } });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /警告.*PROCESSES_RUNNING.*仍可写入/);
  assert.match(human.stdout, /完整退出.*browser-service.*node_repl.*重新启动/);
  assert.ok(human.stdout.includes('PID 987654 /Applications/Codex.app/Contents/MacOS/Codex'));
});

test('check identifies the installed patch from source without any local recovery files', async (t: TestContext) => {
  const box = await sandbox(t);
  const change = required(deriveCua(box.source.toString('utf8')).change);
  await writeFile(box.target, change.patchedSource);
  const checked = run(box, ['check', '--app', box.app]);
  assert.equal(checked.code, 0, JSON.stringify(checked.result));
  const inspection = required(required(checked.result.data).inspection);
  assert.equal(inspection.state, 'tool-applied');
  assert.equal(inspection.sourcePatch?.status, 'detected');
  assert.equal(inspection.recovery, null);
  assert.deepEqual(inspection.allowedActions, []);
  const human = runCli(['check', '--app', box.app], { directory: box.directory, fixture });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /源码补丁：已安装/);
  assert.match(human.stdout, /自动卸载：不可用/);
  assert.match(human.stdout, /缺少可信恢复记录/);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
  assert.equal(await readFile(box.target, 'utf8'), change.patchedSource);
});

test('check reports process enumeration failure as runtime failure without changing structural support or file state', async (t: TestContext) => {
  const box = await sandbox(t);
  const { code, result } = run(box, ['check'], { CODEX_TEST_PROCESS_FAILURE: '1' });
  assert.equal(code, 1, JSON.stringify({ outcome: result.outcome, diagnostics: result.diagnostics }));
  assert.equal(result.outcome, 'runtime-error');
  assert.equal(required(required(result.data).inspections[0]).support, 'supported');
  assert.equal(required(required(result.data).inspections[0]).state, 'original');
  assert.equal(required(required(result.data).inspections[0]).writeReadiness, 'unknown');
  assert.deepEqual(required(required(result.data).inspections[0]).allowedActions, []);
  assert.equal(required(result.data).runtime, 'not-verified');
  assert.ok(result.diagnostics.some(entry => entry.code === 'PROCESS_ENUMERATION_FAILED' && entry.installation === box.app));
  const human = runCli(['check', '--app', box.app], { directory: box.directory, fixture, env: { CODEX_TEST_PROCESS_FAILURE: '1' } });
  assert.equal(human.status, 1, human.stdout + human.stderr);
  assert.match(human.stdout, /PROCESS_ENUMERATION_FAILED.*并发锁.*进程身份/);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
});

test('check classifies a discovered path alias as conflict while retaining other installation results', async (t: TestContext) => {
  const box = await sandbox(t);
  const alias = join(box.directory, 'home/Applications/Alias.app');
  await symlink(box.app, alias);
  const { code, result } = run(box, ['check']);
  assert.equal(code, 4, JSON.stringify(result));
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(required(result.data).inspections.map(entry => entry.candidate.appPath), [box.app]);
  assert.equal(required(required(result.data).inspections[0]).state, 'original');
  assert.ok(result.diagnostics.some(entry => entry.code === 'PATH_ALIAS' && entry.path === alias));
  const explicit = run(box, ['check', '--app', alias]);
  assert.equal(explicit.code, 4, JSON.stringify(explicit));
  assert.equal(explicit.result.outcome, 'conflict');
  assert.deepEqual(required(explicit.result.data).inspections, []);
  assert.deepEqual(await readFile(box.target), box.source);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
});

test('managed status is read-only while abandoned commands and selectors are rejected including equals forms', async (t: TestContext) => {
  const box = await sandbox(t);
  const status = run(box, ['status', '--app', box.app]);
  assert.equal(status.code, 0, JSON.stringify(status));
  assert.equal(required(required(status.result.data).targets[0]).state, 'original');
  for (const args of [
    ['detect'], ['prepare'], ['detect', '--app', box.app], ['prepare', '--app', box.app],
    ['apply', '--plan='], ['apply', '--store='], ['apply', '--plan', box.directory],
    ['apply', '--store', box.directory], ['restore', `--plan=${box.directory}`],
    ['recover', `--plan=${box.directory}`, `--store=${box.directory}`],
    ['status', `--store=${box.directory}`, '--app', box.app],
    ['apply', '--store'], ['status', '--store=', '--store', box.directory],
    ['check', '--app', box.app, '--app=' + box.app],
    ['status', '--app', box.app, '--wat'], ['check', '--app', box.app, 'extra'],
    ['check', '--', '--store=' + box.directory],
  ] satisfies [string, ...string[]][]) {
    const rejected = run(box, args);
    assert.equal(rejected.code, 2, JSON.stringify({ args, rejected }));
    assert.equal(rejected.result.outcome, 'usage-error');
  }
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
  assert.deepEqual(await readFile(box.target), box.source);
});

test('human check explains structural evidence and semantic assumptions without JSON details', async (t: TestContext) => {
  const box = await sandbox(t);
  const child = runCli(['check', '--app', box.app], { directory: box.directory, fixture });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /依据：.*fetch/);
  assert.match(child.stdout, /前提：.*(?:宿主|应用).*(?:约定|契约|接口)/);
  assert.match(child.stdout, /运行效果：未验证/);
  assert.ok(child.stdout.includes(`\n\n应用：${box.app}\n  目标文件：${box.target}\n`));
  assert.ok(child.stdout.includes('\n  结构兼容：支持\n  文件状态：原始文件\n  写入条件：满足\n'));
  assert.ok(child.stdout.includes('\n  兼容性详情：\n'));
  assert.equal(child.stderr, '');
});

test('help lists options and examples and scopes help to each command', async (t: TestContext) => {
  const box = await sandbox(t);
  for (const flag of ['-h', '--help']) {
    const child = runCli([flag], { directory: box.directory, fixture });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(child.stderr, '');
    for (const section of ['用法：', '命令：', '选项：', '示例：', '退出码：']) assert.ok(child.stdout.includes(section));
    assert.match(child.stdout, /-h, --help/);
    assert.match(child.stdout, /-v, --version/);
  }
  for (const command of ['install', 'uninstall', 'check', 'apply', 'status', 'restore', 'recover']) {
    const child = runCli([command, '-h'], { directory: box.directory, fixture });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(child.stderr, '');
    assert.ok(child.stdout.includes(`codex-unfence ${command} [--app`));
    if (command === 'check' || command === 'status') assert.match(child.stdout, /--json/);
    else assert.match(child.stdout, /交互终端/);
    assert.doesNotMatch(child.stdout, /--plan|--store|codex-unfence (?:detect|prepare)/);
  }
});

test('version uses package metadata without discovering installations or creating recovery data', async (t: TestContext) => {
  const box = await sandbox(t);
  const metadata: { version: string } = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  for (const flag of ['-v', '--version']) {
    const child = runCli([flag], { directory: box.directory, fixture, env: { CODEX_TEST_PROCESS_FAILURE: '1' } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(child.stdout, `${metadata.version}\n`);
    assert.equal(child.stderr, '');
  }
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
  assert.deepEqual(await readFile(box.target), box.source);
});

test('argument errors use stderr and a help hint while JSON errors remain parseable on stdout', async (t: TestContext) => {
  const box = await sandbox(t);
  for (const args of [
    ['--unknown'], ['check', '--app'], ['check', '--app', 'relative.app'], ['check', 'extra'],
    ['--version', '-v'], ['--help', '-h'], ['--version', '--help'], ['check', '--version'],
    ['--version', '--app', box.app], ['--help', '--json'], ['--version', '--json'],
  ]) {
    const child = runCli(args, { directory: box.directory, fixture });
    assert.equal(child.status, 2, child.stdout + child.stderr);
    if (args.includes('--json')) {
      assert.equal(child.stderr, '');
      const result: OperationResult = JSON.parse(child.stdout);
      assert.equal(result.outcome, 'usage-error');
      assert.equal(result.diagnostics[0]?.code, 'INVALID_ARGUMENTS');
    } else {
      assert.equal(child.stdout, '');
      assert.match(child.stderr, /INVALID_ARGUMENTS/);
      assert.match(child.stderr, /--help 查看用法/);
    }
  }
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
});

test('managed writes require real confirmation and missing status preserves its command', async (t: TestContext) => {
  const box = await sandbox(t);
  for (const command of ['install', 'uninstall', 'apply', 'restore', 'recover']) {
    const child = run(box, [command, '--app', box.app]);
    assert.equal(child.code, 2, JSON.stringify(child));
    assert.equal(child.result.command, command);
  }
  const missing = run(box, ['status', '--app', join(box.directory, 'missing.app')]);
  assert.equal(missing.code, 1);
  assert.equal(missing.result.command, 'status');
  assert.equal(missing.result.data, null);
  assert.deepEqual(await readFile(box.target), box.source);
});


test('new product namespace leaves old recovery records untouched', async (t: TestContext) => {
  const box = await sandbox(t);
  const oldRoot = join(box.directory, 'home/Library/Application Support/codex-browser-liberation-patch');
  await mkdir(oldRoot, { recursive: true });
  const previous = Buffer.from('old recovery data must not be read or migrated');
  await writeFile(join(oldRoot, 'key'), previous);
  const { code, result } = run(box, ['check', '--app', box.app]);
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(required(required(result.data).inspections[0]).state, 'original');
  assert.deepEqual(await readFile(join(oldRoot, 'key')), previous);
  assert.deepEqual(await readdir(join(box.directory, 'home/Library/Application Support')), ['codex-browser-liberation-patch']);
});

test('check reports all installations including unsupported sources without creating recovery state', async (t: TestContext) => {
  const box = await sandbox(t);
  const unsupported = join(box.directory, 'home/Applications/Unsupported.app', service);
  await mkdir(join(unsupported, '..'), { recursive: true });
  await writeFile(unsupported, 'const unsupported = true;');
  const { code, result } = run(box, ['check']);
  assert.equal(code, 3, JSON.stringify(result));
  assert.equal(required(result.data).inspections.length, 2);
  assert.deepEqual(required(result.data).inspections.map(entry => entry.support), ['supported', 'unsupported']);
  assert.equal(required(result.data).inspection, null);
  assert.equal(required(result.data).discovery.selection, 'required');
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every(entry => entry.path === unsupported));
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
  const human = runCli(['check'], { directory: box.directory, fixture });
  assert.equal(human.status, 3, human.stdout + human.stderr);
  assert.ok(human.stdout.includes(box.app));
  assert.ok(human.stdout.includes('Unsupported.app'));
  assert.match(human.stdout, /可以安装：是/);
  assert.match(human.stdout, /可以安装：否/);
});
