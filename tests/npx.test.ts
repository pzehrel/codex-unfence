function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import type { CheckResult, OperationResult, CommandResult } from '../src/result.js';
interface FinalBinObservation {entry: string; pid: number; cwd: string; home: string; stdinTTY: boolean; stdoutTTY: boolean}
function finalBin(text: string): FinalBinObservation { return JSON.parse(text); }
function checkOutput(text: string): CheckResult { return JSON.parse(text); }
function operationOutput(text: string): OperationResult { return JSON.parse(text); }
function commandOutput(text: string): CommandResult { return JSON.parse(text); }
import type { PtyStep } from './helpers/npm-package.js';
interface FileSnapshot { [name: string]: FileSnapshot | {bytes: Buffer; mode: number} }
import type { TestContext } from 'node:test';
import { repositoryRoot, sourceFixture } from './helpers/paths.js';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import * as npmPackage from './helpers/npm-package.js';

async function packageBox(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-npx-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = npmPackage.packPackage(directory);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const [metadata]: [{filename: string}] = JSON.parse(packed.stdout);
  const cwd = join(directory, 'unrelated working directory');
  await mkdir(cwd);
  return { directory, cwd, tarball: join(directory, metadata.filename) };
}

const { syntheticInstallation } = npmPackage;

async function snapshotFiles(directory: string): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    snapshot[entry.name] = entry.isDirectory() ? await snapshotFiles(path) : {
      bytes: await readFile(path), mode: (await stat(path)).mode & 0o7777,
    };
  }
  return snapshot;
}

function help(result: {status: number | null; stdout: string; stderr: string}) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /codex-unfence/);
  assert.match(result.stdout, /macOS/);
  assert.match(result.stdout, /--help/);
}

function inside(root: string, path: string) {
  const suffix = relative(root, path);
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), path);
}

test('offline npx runs the packed public bin from an unrelated cwd with isolated final-bin boundaries', async (t: TestContext) => {
  const box = await packageBox(t);
  help(npmPackage.runNpmExec(['--help'], box));
  const observed = finalBin(await readFile(join(box.directory, 'final-bin.json'), 'utf8'));
  inside(join(box.directory, 'npm-cache'), observed.entry);
  assert.ok(observed.entry.endsWith('/node_modules/codex-unfence/dist/cli.js'));
  assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
  assert.equal(observed.cwd, box.cwd);
  assert.equal(observed.home, join(box.directory, 'home'));
  assert.equal(observed.stdinTTY, false);
  assert.equal(observed.stdoutTTY, false);
  const metadata: { version: string } = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  for (const flag of ['-v', '--version']) {
    const version = npmPackage.runNpmExec([flag], box);
    assert.equal(version.status, 0, version.stdout + version.stderr);
    assert.equal(version.stdout, `${metadata.version}\n`);
    assert.equal(version.stderr, '');
  }
  for (const args of [[], ['--json'], ['apply'], ['restore'], ['recover']] as const) {
    const rejected = npmPackage.runNpmExec(args, box);
    assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
  }
});

test('packed npx check uses genuine structural admission and remains read-only', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Synthetic.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const child = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = checkOutput(child.stdout);
  assert.equal(required(required(result.data).inspection).support, 'supported');
  assert.equal(required(required(result.data).inspection).state, 'original');
  assert.deepEqual(await readFile(target), source);
  await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-unfence/key')), { code: 'ENOENT' });
});

test('offline npx exposes help through a real PTY and propagates the public bin exit status', async (t: TestContext) => {
  const box = await packageBox(t);
  const documented = await npmPackage.runNpmExecPty(['--help'], box);
  help(documented);
  assert.match(documented.stdout, /check 汇总所有应用，按运行失败、冲突、不兼容、成功的顺序确定结果/);
  assert.match(documented.stdout, /未找到应用时，check 返回退出码 1/);
  assert.doesNotMatch(documented.stdout, /codex-unfence (?:detect|prepare)|--plan|--store/);
  assert.match(documented.stdout, /写入条件单独报告；检查成功不代表可以写入/);
  const observed = finalBin(await readFile(join(box.directory, 'final-bin.json'), 'utf8'));
  inside(join(box.directory, 'npm-cache'), observed.entry);
  assert.equal(observed.stdinTTY, true);
  assert.equal(observed.stdoutTTY, true);
  const invalid = await npmPackage.runNpmExecPty(['--unknown'], box);
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
});

test('confirmed npx install and uninstall survive code-cache removal and repeated operations', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Lifecycle.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const change = (command: string) => npmPackage.runNpmExecPty([command, '--app', app], {
    ...box, steps: [{ waitFor: '输入 yes 确认', send: 'yes\n' }],
  });
  const applied = await change('install');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /已安装补丁（安装完成）/);
  const patched = await readFile(target);
  assert.notDeepEqual(patched, source);
  assert.match((await change('install')).stdout, /已安装补丁（补丁已安装）/);
  const previous = finalBin(await readFile(join(box.directory, 'final-bin.json'), 'utf8')).entry;
  await rm(join(box.directory, 'npm-cache'), { recursive: true });
  await assert.rejects(readFile(previous), { code: 'ENOENT' });
  const status = npmPackage.runNpmExec(['status', '--app', app, '--json'], box);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(required(required(operationOutput(status.stdout).data).targets[0]).state, 'tool-applied');
  assert.match((await change('uninstall')).stdout, /原始文件（卸载完成）/);
  assert.deepEqual(await readFile(target), source);
  assert.match((await change('uninstall')).stdout, /原始文件（已是原始文件）/);
});

test('npx discovers interrupted apply after reacquisition and can recover after recovery is interrupted again', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Interrupted.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const change = (command: string) => npmPackage.runNpmExecPty([command, '--app', app], {
    ...box, steps: [{ waitFor: `输入 yes 确认 ${command === 'apply' ? 'install' : command === 'restore' ? 'uninstall' : command}，`, send: 'yes\n' }],
  });
  const scenario = join(box.directory, 'boundary.json');
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  const interrupted = await change('apply');
  assert.notEqual(interrupted.status, 0, interrupted.stdout + interrupted.stderr);
  const patched = await readFile(target);
  assert.notDeepEqual(patched, source);
  await rm(scenario);
  await rm(join(box.directory, 'npm-cache'), { recursive: true });
  const state = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  assert.equal(required(required(checkOutput(state.stdout).data).inspection).state, 'incomplete');
  assert.deepEqual(required(required(checkOutput(state.stdout).data).inspection).allowedActions, ['recover']);
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  assert.notEqual((await change('recover')).status, 0);
  await rm(scenario);
  const recovered = await change('recover');
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.match(recovered.stdout, /已回滚/);
  assert.deepEqual(await readFile(target), source);
  assert.equal((await change('apply')).status, 0);
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  assert.notEqual((await change('restore')).status, 0);
  await rm(scenario);
  assert.equal((await change('recover')).status, 0);
  assert.deepEqual(await readFile(target), patched);
  assert.equal((await change('restore')).status, 0);
  assert.deepEqual(await readFile(target), source);
});

test('npx refuses a target changed after inspection instead of applying to new bytes', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Changed.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const changed = Buffer.concat([Buffer.from(source), Buffer.from('\n// external change\n')]);
  const child = await npmPackage.runNpmExecPty(['install', '--app', app], { ...box, steps: [
    { waitFor: '输入 yes 确认', beforeSend: () => writeFile(target, changed), send: 'yes\n' },
  ] });
  assert.equal(child.status, 4, child.stdout + child.stderr);
  assert.match(child.stdout, /INSPECTION_CHANGED/);
  assert.doesNotMatch(child.stdout, /请手动重新打开应用/);
  assert.deepEqual(await readFile(target), changed);
});

test('npx check reports process failures while the guide permits installation with the host running', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Blocked.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const scenario = join(box.directory, 'boundary.json');
  await writeFile(scenario, JSON.stringify({ processFailure: true }));
  const failed = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  assert.equal(required(required(checkOutput(failed.stdout).data).inspection).writeReadiness, 'unknown');
  await writeFile(scenario, JSON.stringify({ processRows: [{ pid: 998877, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }] }));
  const blocked = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  const inspected = required(checkOutput(blocked.stdout).data).inspection;
  assert.equal(required(inspected).support, 'supported');
  assert.equal(required(inspected).writeReadiness, 'ready');
  assert.deepEqual(required(inspected).allowedActions, ['apply']);
  assert.ok(required(inspected).diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning'));
  const guided = await npmPackage.runNpmExecPty([], { ...box, steps: [
    { waitFor: '选择操作（install', send: 'apply\n' },
    { waitFor: '输入 yes 确认', send: 'yes\n' },
  ] });
  assert.equal(guided.status, 0, guided.stdout + guided.stderr);
  assert.match(guided.stdout, /警告.*PROCESSES_RUNNING.*仍可写入/);
  assert.match(guided.stdout, /RESTART_REQUIRED.*完整退出.*browser-service.*node_repl.*重新启动/);
  assert.match(guided.stdout, /已安装补丁（安装完成）/);
  assert.notDeepEqual(await readFile(target), source);
});

test('multiple installations require selection and confirmation EOF leaves the selected bytes unchanged', async (t: TestContext) => {
  const box = await packageBox(t);
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  const targets = [];
  for (const name of ['First', 'Second']) {
    const target = join(box.directory, `home/Applications/${name}.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, source);
    targets.push(target);
  }
  const ambiguous = npmPackage.runNpmExec(['check', '--json'], box);
  assert.equal(ambiguous.status, 0, ambiguous.stdout + ambiguous.stderr);
  assert.equal(required(checkOutput(ambiguous.stdout).data).inspections.length, 2);
  const guided = await npmPackage.runNpmExecPty([], { ...box, steps: [
    { waitFor: '请输入应用编号', send: '2\n' },
    { waitFor: '选择操作（', send: 'apply\n' },
    { waitFor: '输入 yes 确认', send: '\u0004' },
  ] });
  assert.equal(guided.status, 0, guided.stdout + guided.stderr);
  assert.ok(guided.stdout.includes(`目标文件：${targets[1]}`));
  assert.match(guided.stdout, /已取消/);
  for (const target of targets) assert.deepEqual(await readFile(target), source);
});

test('guide offers only admitted actions and EOF never confirms a write', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Unsupported.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, 'const unknown = true;');
  const guided = await npmPackage.runNpmExecPty([], { ...box, steps: [{ waitFor: '选择操作（', send: '\u0004' }] });
  assert.equal(guided.status, 0, guided.stdout + guided.stderr);
  assert.match(guided.stdout, /选择操作（recheck, cancel）/);
  assert.equal(await readFile(target, 'utf8'), 'const unknown = true;');
});

test('default npx guide displays the selected target and cancels without changing installation', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Guide.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const child = await npmPackage.runNpmExecPty([], { ...box, steps: [
    { waitFor: '选择操作（', send: 'apply\n' }, { waitFor: '输入 yes 确认', send: 'no\n' },
  ] });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.ok(child.stdout.includes(target));
  assert.doesNotMatch(child.stdout, /请输入应用编号/);
  assert.match(child.stdout, /签名校验失败/);
  assert.match(child.stdout, /前提：.*(?:宿主|应用).*(?:约定|契约|接口)/);
  assert.match(child.stdout, /已取消/);
  assert.deepEqual(await readFile(target), source);
});


test('npx install and uninstall are repeatable and original uninstall needs no backup', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Public.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const change = (command: string) => npmPackage.runNpmExecPty([command, '--app', app], {
    ...box, steps: [{ waitFor: '输入 yes 确认', send: 'yes\n' }],
  });
  const original = await change('uninstall');
  assert.equal(original.status, 0, original.stdout + original.stderr);
  assert.match(original.stdout, /补丁已卸载，原始文件未修改/);
  await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-unfence/key')), { code: 'ENOENT' });
  const installed = await change('install');
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(installed.stdout, /install：成功/);
  assert.notDeepEqual(await readFile(target), source);
  assert.match((await change('install')).stdout, /已安装补丁（补丁已安装）/);
  const state = npmPackage.runNpmExec(['check', '--json'], box);
  assert.equal(required(required(checkOutput(state.stdout).data).inspections[0]).state, 'tool-applied');
  const removed = await change('uninstall');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.match(removed.stdout, /uninstall：成功/);
  assert.deepEqual(await readFile(target), source);
  assert.match((await change('uninstall')).stdout, /原始文件（已是原始文件）/);
});

test('npx uninstall of an original warns about running processes and reports unchanged-file success', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/BlockedOriginal.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  await writeFile(join(box.directory, 'boundary.json'), JSON.stringify({
    processRows: [{ pid: 998877, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }],
  }));
  const child = await npmPackage.runNpmExecPty(['uninstall', '--app', app], box);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /警告.*PROCESSES_RUNNING.*仍可写入/);
  assert.match(child.stdout, /uninstall：成功/);
  assert.match(child.stdout, /补丁已卸载，原始文件未修改/);
  assert.deepEqual(await readFile(target), source);
  await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-unfence/key')), { code: 'ENOENT' });
});

test('npx install and uninstall report a missing explicit installation as runtime failure', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'missing.app');
  for (const command of ['install', 'uninstall']) {
    const child = await npmPackage.runNpmExecPty([command, '--app', app], box);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(child.stdout, new RegExp(`${command}：运行失败`));
    assert.match(child.stdout, /ENOENT/);
  }
});

test('npx install requires the exact yes confirmation and preserves bytes for other input and EOF', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Confirmation.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  for (const send of [' yes \n', 'YES\n', 'yes please\n', '\n', 'no\n', '\u0004']) {
    const child = await npmPackage.runNpmExecPty(['install', '--app', app], {
      ...box, steps: [{ waitFor: '输入 yes 确认 install，', send }],
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /已取消，应用文件未修改/);
    assert.match(child.stdout, /依据：/);
    assert.match(child.stdout, /前提：.*(?:宿主|应用).*(?:约定|契约|接口)/);
    assert.match(child.stdout, /签名校验失败/);
    assert.ok(child.stdout.includes(`目标文件：${target}`));
    assert.deepEqual(await readFile(target), source);
    await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-unfence/key')), { code: 'ENOENT' });
  }
});

test('npx install and uninstall reject an aliased explicit installation as a conflict', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Canonical.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const alias = join(box.directory, 'Alias.app');
  await symlink(app, alias);
  for (const command of ['install', 'uninstall']) {
    const child = await npmPackage.runNpmExecPty([command, '--app', alias], box);
    assert.equal(child.status, 4, child.stdout + child.stderr);
    assert.match(child.stdout, /PATH_ALIAS/);
    assert.doesNotMatch(child.stdout, /输入 yes 确认/);
    assert.deepEqual(await readFile(target), source);
  }
});

test('npx install and uninstall select among multiple installations and auto-select a single installation', async (t: TestContext) => {
  const box = await packageBox(t);
  const first = await syntheticInstallation(box, 'First');
  const second = await syntheticInstallation(box, 'Second');
  const change = (command: string) => npmPackage.runNpmExecPty([command], { ...box, steps: [
    { waitFor: '请输入应用编号', send: '2\n' },
    { waitFor: `输入 yes 确认 ${command}，`, send: 'yes\n' },
  ] });
  const installed = await change('install');
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.ok(installed.stdout.includes(`目标文件：${second.target}`));
  assert.deepEqual(await readFile(first.target), first.source);
  assert.notDeepEqual(await readFile(second.target), second.source);
  const removed = await change('uninstall');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.deepEqual(await readFile(second.target), second.source);
  await rm(second.app, { recursive: true });
  const single = await npmPackage.runNpmExecPty(['install'], { ...box, steps: [
    { waitFor: '输入 yes 确认 install，', send: 'yes\n' },
  ] });
  assert.equal(single.status, 0, single.stdout + single.stderr);
  assert.doesNotMatch(single.stdout, /请输入应用编号/);
  assert.ok(single.stdout.includes(`目标文件：${first.target}`));
  assert.notDeepEqual(await readFile(first.target), first.source);
});

test('npx public writes reject pipes, JSON and relative app paths without creating recovery state', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target, source } = await syntheticInstallation(box, 'Noninteractive');
  for (const command of ['install', 'uninstall']) {
    const piped = npmPackage.runNpmExec([command, '--app', app], box);
    assert.equal(piped.status, 2, piped.stdout + piped.stderr);
    assert.match(piped.stderr, /需要交互终端/);
    const json = await npmPackage.runNpmExecPty([command, '--app', app, '--json'], box);
    assert.equal(json.status, 2, json.stdout + json.stderr);
    assert.equal(commandOutput(json.stdout).outcome, 'usage-error');
    const relative = await npmPackage.runNpmExecPty([command, '--app', 'Relative.app'], box);
    assert.equal(relative.status, 2, relative.stdout + relative.stderr);
    assert.match(relative.stdout, /--app 需要应用的绝对路径/);
  }
  assert.deepEqual(await readFile(target), source);
  await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-unfence/key')), { code: 'ENOENT' });
});

test('npx public writes refuse permissions and unknown process state with accurate exit codes', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target, source } = await syntheticInstallation(box, 'Readiness');
  const scenario = join(box.directory, 'boundary.json');
  const parent = join(target, '..');
  const blocked = (command: string) => npmPackage.runNpmExecPty([command, '--app', app], {
    ...box, steps: [{ waitFor: '选择操作（recheck, cancel）', send: 'cancel\n' }],
  });
  await chmod(parent, 0o500);
  try {
    for (const command of ['install', 'uninstall']) {
      const child = await blocked(command);
      assert.equal(child.status, 4, child.stdout + child.stderr);
      assert.match(child.stdout, /TARGET_NOT_WRITABLE/);
    }
  } finally { await chmod(parent, 0o700); }
  await writeFile(scenario, JSON.stringify({ processFailure: true }));
  for (const command of ['install', 'uninstall']) {
    const child = await blocked(command);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(child.stdout, /PROCESS_ENUMERATION_FAILED/);
  }
  assert.deepEqual(await readFile(target), source);
  await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-unfence/key')), { code: 'ENOENT' });
});

test('npx check and confirmed install follow application updates without restoring old files', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target, source } = await syntheticInstallation(box, 'Updated');
  const plist = join(app, 'Contents/Info.plist');
  await writeFile(plist, '<plist><dict><key>CFBundleVersion</key><string>1</string></dict></plist>');
  const installed = await npmPackage.runNpmExecPty(['install', '--app', app], { ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n' }] });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  await rename(target, join(box.directory, 'old-patched.mjs'));
  const updated = Buffer.concat([Buffer.from('// updated application\n'), Buffer.from(source)]);
  await writeFile(target, updated, { mode: 0o640 });
  await writeFile(plist, '<plist><dict><key>CFBundleVersion</key><string>2</string></dict></plist>');
  const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
  const before = await snapshotFiles(root);
  const checked = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const inspection = required(checkOutput(checked.stdout).data?.inspection);
  assert.equal(inspection.state, 'original');
  assert.equal(inspection.support, 'supported');
  assert.ok(inspection.allowedActions.includes('apply'));
  assert.deepEqual(await snapshotFiles(root), before);
  const uninstalled = await npmPackage.runNpmExecPty(['uninstall', '--app', app], box);
  assert.equal(uninstalled.status, 0, uninstalled.stdout + uninstalled.stderr);
  assert.deepEqual(await readFile(target), updated);
  assert.deepEqual(await snapshotFiles(root), before);
  const stale = await npmPackage.runNpmExecPty(['install', '--app', app], { ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n', beforeSend: () => writeFile(plist, '<plist><dict><key>CFBundleVersion</key><string>3</string></dict></plist>') }] });
  assert.equal(stale.status, 4, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /INSPECTION_CHANGED/);
  assert.deepEqual(await readFile(target), updated);
  assert.deepEqual(await snapshotFiles(root), before);
  const reapplied = await npmPackage.runNpmExecPty(['install', '--app', app], { ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n' }] });
  assert.equal(reapplied.status, 0, reapplied.stdout + reapplied.stderr);
  const restored = await npmPackage.runNpmExecPty(['uninstall', '--app', app], { ...box, steps: [{ waitFor: '输入 yes 确认 uninstall，', send: 'yes\n' }] });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.deepEqual(await readFile(target), updated);
});

test('npx public writes preserve an externally replaced identity even when bytes are unchanged', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target, source } = await syntheticInstallation(box, 'Identity');
  const before = await stat(target);
  const installed = await npmPackage.runNpmExecPty(['install', '--app', app], { ...box, steps: [{
    waitFor: '输入 yes 确认 install，', send: 'yes\n', beforeSend: async () => {
      await rename(target, join(box.directory, 'retained-original.mjs'));
      await writeFile(target, source, { mode: 0o640 });
    },
  }] });
  assert.equal(installed.status, 4, installed.stdout + installed.stderr);
  assert.match(installed.stdout, /INSPECTION_CHANGED/);
  assert.notEqual((await stat(target)).ino, before.ino);
  assert.deepEqual(await readFile(target), source);
  const confirmed = await npmPackage.runNpmExecPty(['install', '--app', app], {
    ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n' }],
  });
  assert.equal(confirmed.status, 0, confirmed.stdout + confirmed.stderr);
  const patched = await readFile(target);
  const appliedIdentity = await stat(target);
  await rename(target, join(box.directory, 'retained-patched.mjs'));
  await writeFile(target, patched, { mode: 0o640 });
  assert.notEqual((await stat(target)).ino, appliedIdentity.ino);
  const refused = await npmPackage.runNpmExecPty(['uninstall', '--app', app], {
    ...box, steps: [{ waitFor: '选择操作（recheck, cancel）', send: 'cancel\n' }],
  });
  assert.equal(refused.status, 4, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /TARGET_CONFLICT/);
  assert.deepEqual(await readFile(target), patched);
});

test('npx install and uninstall keep independent private recovery and coordination namespaces', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target, source } = await syntheticInstallation(box, 'Namespaces');
  const oldRecovery = join(box.directory, 'home/Library/Application Support/codex-browser-liberation-patch');
  const oldCoordination = join(box.directory, 'home/.codex-browser-patch');
  for (const directory of [oldRecovery, oldCoordination]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'key'), 'unreadable old recovery data');
    await chmod(directory, 0);
  }
  try {
    const change = (command: string) => npmPackage.runNpmExecPty([command, '--app', app], {
      ...box, steps: [{ waitFor: `输入 yes 确认 ${command}，`, send: 'yes\n' }],
    });
    const installed = await change('install');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal((await stat(target)).mode & 0o7777, 0o640);
    const state = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
    assert.equal(state.status, 0, state.stdout + state.stderr);
    const recovery = required(required(checkOutput(state.stdout).data).inspection).recovery;
    assert.deepEqual(required(recovery).tool, { packageName: 'codex-unfence', version: '0.0.2', executable: 'codex-unfence' });
    assert.equal(required(recovery).command, 'npx --package codex-unfence@0.0.2 codex-unfence');
    const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
    inside(root, required(recovery).preparation);
    inside(root, required(recovery).store);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'key'))).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(join(required(recovery).preparation, 'source.original.mjs')), source);
    assert.deepEqual(await readdir(join(target, '..')), ['browser-service.mjs']);
    const leases = join(box.directory, 'home/.codex-unfence/target-leases');
    assert.equal((await stat(leases)).mode & 0o777, 0o700);
    assert.equal((await readdir(leases)).length, 1);
    const removed = await change('uninstall');
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.deepEqual(await readFile(target), source);
    assert.equal((await stat(target)).mode & 0o7777, 0o640);
  } finally {
    for (const directory of [oldRecovery, oldCoordination]) await chmod(directory, 0o700);
  }
  for (const directory of [oldRecovery, oldCoordination]) {
    assert.deepEqual(await readdir(directory), ['key']);
    assert.equal(await readFile(join(directory, 'key'), 'utf8'), 'unreadable old recovery data');
  }
});

test('npx uninstall cancellation preserves patched bytes and every recovery artifact', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target } = await syntheticInstallation(box, 'CancelUninstall');
  const installed = await npmPackage.runNpmExecPty(['install', '--app', app], {
    ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n' }],
  });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const patched = await readFile(target);
  const identity = await stat(target);
  const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
  const before = await snapshotFiles(root);
  for (const send of [' yes \n', 'YES\n', 'no\n', '\u0004']) {
    const child = await npmPackage.runNpmExecPty(['uninstall', '--app', app], {
      ...box, steps: [{ waitFor: '输入 yes 确认 uninstall，', send }],
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /已取消，应用文件未修改/);
    assert.match(child.stdout, /恢复工具：codex-unfence@0.0.2[\r\n]+命令：codex-unfence/);
    for (const notice of ['依据：', '前提：', '作用范围：', '签名校验失败']) {
      assert.ok(child.stdout.indexOf(notice) >= 0 && child.stdout.indexOf(notice) < child.stdout.indexOf('输入 yes 确认 uninstall，'), notice);
    }
    assert.deepEqual(await readFile(target), patched);
    assert.equal((await stat(target)).ino, identity.ino);
    assert.deepEqual(await snapshotFiles(root), before);
  }
});

test('npx interrupted install and uninstall require exact recovery confirmation and preserve transactions on refusal or EOF', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target } = await syntheticInstallation(box, 'ExactRecovery');
  const scenario = join(box.directory, 'boundary.json');
  const change = (command: string, steps = [{ waitFor: `输入 yes 确认 ${command}，`, send: 'yes\n' }]) =>
    npmPackage.runNpmExecPty([command, '--app', app], { ...box, steps });
  for (const command of ['install', 'uninstall']) {
    if (command === 'uninstall') assert.equal((await change('install')).status, 0);
    await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
    const interrupted = await change(command);
    assert.notEqual(interrupted.status, 0, interrupted.stdout + interrupted.stderr);
    await rm(scenario);
    const bytes = await readFile(target);
    const identity = await stat(target);
    const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
    const before = await snapshotFiles(root);
    for (const send of [' yes \n', 'YES\n', 'yes please\n', '\n', 'no\n', '\u0004']) {
      const refused = await change(command, [{ waitFor: '输入 yes 确认恢复', send }]);
      assert.equal(refused.status, 0, refused.stdout + refused.stderr);
      assert.match(refused.stdout, /已取消，应用文件未修改/);
      assert.doesNotMatch(refused.stdout, /已回滚|恢复已完成|输入 yes 确认 (?:install|uninstall)，/);
      assert.deepEqual(await readFile(target), bytes);
      assert.equal((await stat(target)).ino, identity.ino);
      assert.deepEqual(await snapshotFiles(root), before);
    }
    const recovered = await change(command, [
      { waitFor: '输入 yes 确认恢复', send: 'yes\n' },
      { waitFor: `输入 yes 确认 ${command}，`, send: 'no\n' },
    ]);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  }
});

test('npx install and uninstall guide rollback then continue after interruptions', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Resume.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const scenario = join(box.directory, 'boundary.json');
  const change = (command: string, steps = [{ waitFor: '输入 yes 确认', send: 'yes\n' }]) =>
    npmPackage.runNpmExecPty([command, '--app', app], { ...box, steps });
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  assert.notEqual((await change('install')).status, 0);
  await rm(scenario);
  const patched = await readFile(target);
  const cancelled = await change('install', [{ waitFor: '输入 yes 确认恢复', send: 'no\n' }]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.deepEqual(await readFile(target), patched);
  const steps = (command: string) => [
    { waitFor: '输入 yes 确认恢复', send: 'yes\n' },
    { waitFor: `输入 yes 确认 ${command}，`, send: 'yes\n', beforeSend: async () => {
      assert.deepEqual(await readFile(target), command === 'install' ? source : patched);
      const checked = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      const inspection = required(checkOutput(checked.stdout).data).inspection;
      assert.equal(required(inspection).state, command === 'install' ? 'original' : 'tool-applied');
      assert.equal(required(required(required(inspection).operation).data).groupState, 'complete');
      assert.deepEqual(required(required(required(inspection).operation).data).pendingTransactions, []);
    } },
  ];
  const installed = await change('install', steps('install'));
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.match(installed.stdout, /已回滚/);
  assert.match(installed.stdout, /install：成功/);
  assert.deepEqual(await readFile(target), patched);
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  assert.notEqual((await change('uninstall')).status, 0);
  await rm(scenario);
  const removed = await change('uninstall', steps('uninstall'));
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.match(removed.stdout, /已回滚/);
  assert.match(removed.stdout, /uninstall：成功/);
  assert.deepEqual(await readFile(target), source);
});


test('npx recovery restores each transaction before state and cancellation or EOF never authorizes continuation', async (t: TestContext) => {
  const box = await packageBox(t);
  for (const command of ['install', 'uninstall']) {
    for (const [confirmation, send] of [['cancel', 'no\n'], ['inexact', ' yes \n'], ['eof', '\u0004']] as const) {
      const { app, target, source } = await syntheticInstallation(box, `${command}-${confirmation}`);
      const change = (steps: PtyStep[]) => npmPackage.runNpmExecPty([command, '--app', app], { ...box, steps });
      if (command === 'uninstall') {
        const installed = await npmPackage.runNpmExecPty(['install', '--app', app], {
          ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n' }],
        });
        assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      }
      const before = await readFile(target);
      const scenario = join(box.directory, 'boundary.json');
      await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
      assert.notEqual((await change([{ waitFor: `输入 yes 确认 ${command}，`, send: 'yes\n' }])).status, 0);
      await rm(scenario);
      assert.notDeepEqual(await readFile(target), before);
      let recoveredFiles: FileSnapshot | undefined;
      const observed: {identity?: Awaited<ReturnType<typeof stat>>} = {};
      const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
      const cancelled = await change([
        { waitFor: '输入 yes 确认恢复', send: 'yes\n' },
        { waitFor: `输入 yes 确认 ${command}，`, send, beforeSend: async () => {
          assert.deepEqual(await readFile(target), before);
          recoveredFiles = await snapshotFiles(root);
          observed.identity = await stat(target);
        } },
      ]);
      assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
      assert.match(cancelled.stdout, /恢复已完成，后续操作已取消/);
      const sourceStatus = command === 'install' ? '' : '\\r?\\n  源码补丁：已安装\\r?\\n  自动卸载：可用';
      assert.match(cancelled.stdout, new RegExp(`文件状态：${command === 'install' ? '原始文件' : '已安装补丁'}${sourceStatus}\\r?\\n  写入条件：满足`));
      assert.doesNotMatch(cancelled.stdout, /应用文件未修改/);
      assert.deepEqual(await readFile(target), before);
      assert.ok(observed.identity);
      assert.equal((await stat(target)).ino, observed.identity.ino);
      assert.equal((await stat(target)).mode & 0o7777, 0o640);
      assert.deepEqual(await snapshotFiles(root), recoveredFiles);
      const checked = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      const inspection = required(checkOutput(checked.stdout).data).inspection;
      assert.equal(required(inspection).state, command === 'install' ? 'original' : 'tool-applied');
      assert.deepEqual(required(required(required(inspection).operation).data).pendingTransactions, []);
      assert.equal(required(required(required(inspection).operation).data).groupState, 'complete');
      if (command === 'uninstall') assert.notDeepEqual(before, source);
    }
  }
});

test('npx install and uninstall recover again after an interrupted rollback and npm cache removal', async (t: TestContext) => {
  const box = await packageBox(t);
  for (const command of ['install', 'uninstall']) {
    const { app, target, source } = await syntheticInstallation(box, `${command}-retry`);
    const change = (action: string, steps: PtyStep[]) => npmPackage.runNpmExecPty([action, '--app', app], { ...box, steps });
    const confirm = (action: string) => [{ waitFor: `输入 yes 确认 ${action}，`, send: 'yes\n' }];
    if (command === 'uninstall') assert.equal((await change('install', confirm('install'))).status, 0);
    const before = await readFile(target);
    const scenario = join(box.directory, 'boundary.json');
    await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
    assert.notEqual((await change(command, confirm(command))).status, 0);
    const interrupted = await readFile(target);
    assert.notDeepEqual(interrupted, before);
    await rm(scenario);
    const checked = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const inspection = required(checkOutput(checked.stdout).data).inspection;
    assert.equal(required(inspection).state, 'incomplete');
    const pending = required(required(required(required(inspection).operation).data).pendingTransactions)[0];
    assert.equal(required(pending).operation, command === 'install' ? 'apply' : 'restore');
    assert.equal(required(required(required(pending).targets[0]).pending).before, command === 'install' ? 'original' : 'tool-applied');
    const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
    const recoveryFiles = await snapshotFiles(root);
    const previous = finalBin(await readFile(join(box.directory, 'final-bin.json'), 'utf8')).entry;
    await rm(join(box.directory, 'npm-cache'), { recursive: true });
    await assert.rejects(readFile(previous), { code: 'ENOENT' });
    assert.deepEqual(await snapshotFiles(root), recoveryFiles);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'key'))).mode & 0o777, 0o600);
    inside(root, required(required(inspection).recovery).store);
    inside(root, required(required(inspection).recovery).preparation);
    await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
    const killedRecovery = await change(command, [{ waitFor: '输入 yes 确认恢复', send: 'yes\n' }]);
    assert.notEqual(killedRecovery.status, 0, killedRecovery.stdout + killedRecovery.stderr);
    assert.doesNotMatch(killedRecovery.stdout, /输入 yes 确认 (?:install|uninstall)，/);
    await rm(scenario);
    assert.deepEqual(await readFile(target), before);
    const stillPending = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
    assert.equal(stillPending.status, 0, stillPending.stdout + stillPending.stderr);
    const retry = required(checkOutput(stillPending.stdout).data).inspection;
    assert.equal(required(retry).state, 'incomplete');
    assert.equal(required(required(required(required(required(retry).operation).data).pendingTransactions)[0]).transaction, required(pending).transaction);
    const recovered = await change(command, [
      { waitFor: '输入 yes 确认恢复', send: 'yes\n' },
      { waitFor: `输入 yes 确认 ${command}，`, send: 'yes\n', beforeSend: async () => {
        assert.deepEqual(await readFile(target), before);
      } },
    ]);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.match(recovered.stdout, /已回滚/);
    assert.deepEqual(await readFile(target), interrupted);
    const final = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
    assert.equal(final.status, 0, final.stdout + final.stderr);
    const complete = required(checkOutput(final.stdout).data).inspection;
    assert.equal(required(complete).state, command === 'install' ? 'tool-applied' : 'original');
    assert.deepEqual(required(required(required(complete).operation).data).pendingTransactions, []);
    assert.equal((await stat(target)).mode & 0o7777, 0o640);
    assert.deepEqual(await readdir(join(target, '..')), ['browser-service.mjs']);
    if (command === 'uninstall') assert.deepEqual(await readFile(target), source);
  }
});

test('npx recovery permits a running host while process enumeration failure blocks the separately confirmed continuation', async (t: TestContext) => {
  const box = await packageBox(t);
  const { app, target, source } = await syntheticInstallation(box, 'RecoveryRecheck');
  const scenario = join(box.directory, 'boundary.json');
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  assert.notEqual((await npmPackage.runNpmExecPty(['install', '--app', app], {
    ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n' }],
  })).status, 0);
  await writeFile(scenario, JSON.stringify({ processRows: [{ pid: 998877, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }] }));
  const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
  let recoveredFiles: FileSnapshot | undefined;
  const recovered = await npmPackage.runNpmExecPty(['install', '--app', app], { ...box, steps: [
    { waitFor: '输入 yes 确认恢复', send: 'yes\n' },
    { waitFor: '输入 yes 确认 install，', send: 'yes\n', beforeSend: async () => {
      assert.deepEqual(await readFile(target), source);
      recoveredFiles = await snapshotFiles(root);
      await writeFile(scenario, JSON.stringify({ processFailure: true }));
    } },
  ] });
  assert.equal(recovered.status, 1, recovered.stdout + recovered.stderr);
  assert.match(recovered.stdout, /警告.*PROCESSES_RUNNING.*仍可写入/);
  assert.match(recovered.stdout, /RESTART_REQUIRED.*完整退出.*browser-service.*node_repl.*重新启动/);
  assert.match(recovered.stdout, /已回滚/);
  assert.match(recovered.stdout, /PROCESS_ENUMERATION_FAILED.*并发锁.*进程身份/);
  assert.deepEqual(await readFile(target), source);
  assert.deepEqual(await snapshotFiles(root), recoveredFiles);
});

test('npx recovery preserves a same-byte replacement made before restart after install or uninstall interruption', async (t: TestContext) => {
  const box = await packageBox(t);
  for (const [command, interruptedPhase] of [['install', 'operation'], ['uninstall', 'operation'], ['install', 'rollback'], ['uninstall', 'rollback']] as const) {
    const { app, target } = await syntheticInstallation(box, `${command}-${interruptedPhase}-replaced-before-restart`);
    const confirm = (action: string) => npmPackage.runNpmExecPty([action, '--app', app], {
      ...box, steps: [{ waitFor: `输入 yes 确认 ${action}，`, send: 'yes\n' }],
    });
    if (command === 'uninstall') assert.equal((await confirm('install')).status, 0);
    const scenario = join(box.directory, 'boundary.json');
    await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
    const interrupted = await confirm(command);
    assert.notEqual(interrupted.status, 0, interrupted.stdout + interrupted.stderr);
    if (interruptedPhase === 'rollback') {
      const killedRecovery = await npmPackage.runNpmExecPty([command, '--app', app], { ...box, steps: [
        { waitFor: '输入 yes 确认恢复', send: 'yes\n' },
      ] });
      assert.notEqual(killedRecovery.status, 0, killedRecovery.stdout + killedRecovery.stderr);
    }
    await rm(scenario);
    const bytes = await readFile(target);
    const originalIdentity = await stat(target);
    // Retain the interrupted target so the replacement cannot reuse its inode.
    await rename(target, join(box.directory, `${command}-${interruptedPhase}-external-retained.mjs`));
    await writeFile(target, bytes, { mode: originalIdentity.mode & 0o7777 });
    const replacement = await stat(target);
    assert.notEqual(replacement.ino, originalIdentity.ino);
    const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
    const recoveryFiles = await snapshotFiles(root);
    const checked = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
    const conflicted = required(required(checkOutput(checked.stdout).data).inspection).state === 'conflict';
    const refused = await npmPackage.runNpmExecPty([command, '--app', app], { ...box, steps: conflicted
      ? [{ waitFor: '选择操作（recheck, cancel）', send: 'cancel\n' }]
      : [{ waitFor: '输入 yes 确认恢复', send: 'yes\n' }, { waitFor: `输入 yes 确认 ${command}，`, send: 'no\n' }],
    });
    assert.equal(refused.status, 4, refused.stdout + refused.stderr);
    assert.doesNotMatch(refused.stdout, /输入 yes 确认恢复|已回滚|输入 yes 确认 (?:install|uninstall)，/);
    assert.deepEqual(await readFile(target), bytes);
    assert.equal((await stat(target)).ino, replacement.ino);
    assert.equal((await stat(target)).mode & 0o7777, originalIdentity.mode & 0o7777);
    assert.deepEqual(await snapshotFiles(root), recoveryFiles);
    assert.equal(checked.status, 4, checked.stdout + checked.stderr);
    assert.equal(required(required(checkOutput(checked.stdout).data).inspection).state, 'conflict');
  }
});

test('npx recovery refuses unknown contents and changed identities without continuing or changing recovery data', async (t: TestContext) => {
  const box = await packageBox(t);
  for (const command of ['install', 'uninstall']) {
    for (const conflict of ['unknown-before', 'unknown-at-confirmation', 'identity-at-confirmation', 'parent-before']) {
      const { app, target, source } = await syntheticInstallation(box, `${command}-${conflict}`);
      const change = (steps: PtyStep[]) => npmPackage.runNpmExecPty([command, '--app', app], { ...box, steps });
      if (command === 'uninstall') assert.equal((await npmPackage.runNpmExecPty(['install', '--app', app], {
        ...box, steps: [{ waitFor: '输入 yes 确认 install，', send: 'yes\n' }],
      })).status, 0);
      const scenario = join(box.directory, 'boundary.json');
      await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
      assert.notEqual((await change([{ waitFor: `输入 yes 确认 ${command}，`, send: 'yes\n' }])).status, 0);
      await rm(scenario);
      const interrupted = await readFile(target);
      const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
      const recoveryFiles = await snapshotFiles(root);
      let preserved = interrupted;
      const mutate = async () => {
        if (conflict.startsWith('unknown')) {
          preserved = Buffer.concat([Buffer.from(source), Buffer.from('\n// unknown external content\n')]);
          await writeFile(target, preserved);
        } else if (conflict === 'identity-at-confirmation') {
          const originalIdentity = await stat(target);
          await rename(target, join(box.directory, `${command}-retained-target.mjs`));
          await writeFile(target, interrupted, { mode: 0o640 });
          assert.notEqual((await stat(target)).ino, originalIdentity.ino);
        } else {
          const parent = join(target, '..');
          await rename(parent, join(box.directory, `${command}-retained-scripts`));
          await mkdir(parent);
          await writeFile(target, interrupted, { mode: 0o640 });
        }
      };
      const atConfirmation = conflict.endsWith('at-confirmation');
      if (!atConfirmation) await mutate();
      const refused = await change(atConfirmation
        ? [{ waitFor: '输入 yes 确认恢复', send: 'yes\n', beforeSend: mutate }]
        : [{ waitFor: '选择操作（recheck, cancel）', send: 'cancel\n' }]);
      assert.equal(refused.status, 4, refused.stdout + refused.stderr);
      assert.match(refused.stdout, atConfirmation ? /INSPECTION_CHANGED/ : /TARGET_CONFLICT|IDENTITY_CHANGED|RECOVERY_CONFLICT/);
      assert.doesNotMatch(refused.stdout, /已回滚|输入 yes 确认 (?:install|uninstall)，/);
      if (atConfirmation) assert.match(refused.stdout, /恢复未完成/);
      assert.deepEqual(await readFile(target), preserved);
      assert.deepEqual(await snapshotFiles(root), recoveryFiles);
    }
  }
});

test('blocked install exits unsuccessfully and cancelled continuation reports completed recovery', async (t: TestContext) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Cancelled.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, 'const unsupported = true;');
  const rejected = await npmPackage.runNpmExecPty(['install', '--app', app], {
    ...box, steps: [{ waitFor: '选择操作（recheck, cancel）', send: 'cancel\n' }],
  });
  assert.equal(rejected.status, 3, rejected.stdout + rejected.stderr);
  const source = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(target, source);
  const change = (command: string, steps = [{ waitFor: '输入 yes 确认', send: 'yes\n' }]) =>
    npmPackage.runNpmExecPty([command, '--app', app], { ...box, steps });
  assert.equal((await change('install')).status, 0);
  const patched = await readFile(target);
  const scenario = join(box.directory, 'boundary.json');
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  assert.notEqual((await change('uninstall')).status, 0);
  await rm(scenario);
  assert.deepEqual(await readFile(target), source);
  const cancelled = await change('uninstall', [
    { waitFor: '输入 yes 确认恢复', send: 'yes\n' },
    { waitFor: '输入 yes 确认 uninstall，', send: 'no\n' },
  ]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.match(cancelled.stdout, /恢复已完成，后续操作已取消/);
  assert.doesNotMatch(cancelled.stdout, /应用文件未修改/);
  assert.deepEqual(await readFile(target), patched);
});
