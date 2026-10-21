function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import type { CheckResult, OperationResult } from '../src/result.js';
type ManagedResult<C extends string> = C extends 'check' ? CheckResult : OperationResult;
import type { TestContext } from 'node:test';
import { sourceFixture } from './helpers/paths.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from './helpers/cli.js';

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

test('public check reports structural support independently of write blockers and creates no recovery state', async (t: TestContext) => {
  const box = await sandbox(t);
  const { code, result } = run(box, ['check', '--app', box.app], {
    CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 987654, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }]),
  });
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.command, 'check');
  assert.equal(result.schemaVersion, 1);
  assert.equal(required(required(result.data).inspection).support, 'supported');
  assert.equal(required(required(result.data).inspection).writeReadiness, 'blocked');
  assert.equal(required(result.data).runtime, 'not-verified');
  assert.equal(required(required(required(result.data).inspection).blockers[0]).code, 'PROCESSES_RUNNING');
  assert.deepEqual(await readFile(box.target), box.source);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
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
  assert.match(child.stdout, /Support:.*member fetch/);
  assert.match(child.stdout, /Assumption:.*host contracts/);
  assert.match(child.stdout, /Runtime: not-verified/);
});

test('help documents managed commands and accepts command-specific help', async (t: TestContext) => {
  const box = await sandbox(t);
  for (const command of ['install', 'uninstall', 'check', 'apply', 'status', 'restore', 'recover']) {
    const child = runCli([command, '--help'], { directory: box.directory, fixture });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /check \[--app/);
    assert.match(child.stdout, /interactive/);
    assert.doesNotMatch(child.stdout, /--plan|--store|codex-unfence (?:detect|prepare)/);
  }
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
  assert.match(human.stdout, /Can install: yes/);
  assert.match(human.stdout, /Can install: no/);
});
