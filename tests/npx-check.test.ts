function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import type { CheckResult } from '../src/result.js';
interface DirectorySnapshot { [name: string]: {mode: number; inode: number; content: Buffer | DirectorySnapshot} }
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packPackage, runNpmExec, runNpmExecPty, syntheticInstallation as installation } from './helpers/npm-package.js';

async function packageBox(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-npx-check-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = packPackage(directory);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const [metadata]: [{filename: string}] = JSON.parse(packed.stdout);
  const cwd = join(directory, 'unrelated cwd');
  await mkdir(cwd);
  await mkdir(join(directory, 'home'));
  return { directory, cwd, tarball: join(directory, metadata.filename) };
}

function check(box: Awaited<ReturnType<typeof packageBox>>, args: string[] = []) {
  const child = runNpmExec(['check', ...args, '--json'], box);
  assert.equal(child.stderr, '', child.stderr);
  const result: CheckResult = JSON.parse(child.stdout);
  assert.equal(result.command, 'check');
  assert.equal(child.status, result.exitCode);
  return { code: child.status, result };
}

async function snapshot(directory: string): Promise<DirectorySnapshot> {
  const entries: DirectorySnapshot = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await stat(path);
    entries[entry.name] = {
      mode: metadata.mode & 0o7777, inode: metadata.ino,
      content: entry.isDirectory() ? await snapshot(path) : await readFile(path),
    };
  }
  return entries;
}

test('npx check keeps every installation visible and runtime read failure outranks conflict and incompatibility', async (t: TestContext) => {
  const box = await packageBox(t);
  const healthy = await installation(box, 'Healthy');
  const damaged = await installation(box, 'Damaged');
  const unsupported = await installation(box, 'Unsupported', 'const unsupported = true;');
  const alias = join(box.directory, 'home/Applications/Alias.app');
  await symlink(healthy.app, alias);
  const installed = await runNpmExecPty(['install', '--app', damaged.app], {
    ...box, steps: [{ waitFor: 'Type yes to install,', send: 'yes\n' }],
  });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const state = check(box, ['--app', damaged.app]);
  assert.equal(state.code, 0);
  assert.equal(required(required(state.result.data).inspection).state, 'tool-applied');
  const aliased = check(box);
  assert.equal(aliased.code, 4);
  assert.equal(required(aliased.result.data).inspections.length, 3);
  assert.ok(aliased.result.diagnostics.some(entry => entry.code === 'PATH_ALIAS' && entry.path === alias));
  const explicitAlias = check(box, ['--app', alias]);
  assert.equal(explicitAlias.code, 4);
  assert.deepEqual(required(explicitAlias.result.data).inspections, []);
  const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
  const [locatorName] = await readdir(join(root, 'targets'));
  const locator = join(root, 'targets', required(locatorName));
  await chmod(locator, 0);
  let failed: ReturnType<typeof check>;
  try {
    failed = check(box);
    const human = runNpmExec(['check'], box);
    assert.equal(human.status, 1, human.stdout + human.stderr);
    assert.ok(human.stdout.split('\n').some(line => line.includes('INSPECTION_FAILED') && line.includes(`(installation: ${damaged.app})`) && line.includes(locator)), human.stdout);
  } finally { await chmod(locator, 0o600); }
  assert.equal(failed.code, 1, JSON.stringify({ outcome: failed.result.outcome, diagnostics: failed.result.diagnostics }));
  assert.equal(failed.result.outcome, 'runtime-error');
  assert.deepEqual(required(failed.result.data).inspections.map(entry => entry.candidate.appPath), [damaged.app, healthy.app, unsupported.app]);
  assert.equal(required(required(failed.result.data).inspections[1]).state, 'original');
  assert.equal(required(required(failed.result.data).inspections[2]).support, 'unsupported');
  assert.ok(failed.result.diagnostics.some(entry => entry.systemCode === 'EACCES' && entry.path === locator && entry.installation === damaged.app));
  assert.ok(failed.result.diagnostics.some(entry => entry.code === 'PATH_ALIAS' && entry.path === alias));
  await rm(alias);
  const recoveryBefore = await snapshot(root);
  const modified = Buffer.from('externally modified after installation');
  await writeFile(damaged.target, modified);
  const conflictBefore = await snapshot(join(box.directory, 'home'));
  const conflicted = check(box);
  assert.equal(conflicted.code, 4);
  assert.equal(conflicted.result.outcome, 'conflict');
  const inspections = required(conflicted.result.data).inspections;
  assert.deepEqual(inspections.map(entry => [entry.support, entry.state]), [
    ['supported', 'conflict'], ['supported', 'original'], ['unsupported', 'incompatible'],
  ]);
  for (const diagnostic of conflicted.result.diagnostics) {
    assert.ok([damaged.app, unsupported.app].includes(required(diagnostic.installation)), JSON.stringify(diagnostic));
    assert.ok(diagnostic.path, JSON.stringify(diagnostic));
  }
  assert.deepEqual(await snapshot(join(box.directory, 'home')), conflictBefore);
  const human = runNpmExec(['check'], box);
  assert.equal(human.status, 4, human.stdout + human.stderr);
  for (const app of [damaged.app, healthy.app, unsupported.app]) assert.ok(human.stdout.includes(`Installation: ${app}`));
  assert.match(human.stdout, /file state: conflict/);
  assert.match(human.stdout, /Structural support: unsupported/);
  assert.match(human.stdout, /Runtime: not-verified/);
  assert.deepEqual(await snapshot(join(box.directory, 'home')), conflictBefore);
  const selected = check(box, ['--app', healthy.app]);
  assert.equal(selected.code, 0);
  assert.deepEqual(required(selected.result.data).inspections.map(entry => entry.candidate.appPath), [healthy.app]);
  assert.equal(required(required(selected.result.data).inspection).state, 'original');
  assert.deepEqual(await readFile(damaged.target), modified);
  assert.deepEqual(await snapshot(root), recoveryBefore);
});

test('npx check aggregates incompatibility and reports write blockers separately without creating any managed state', async (t: TestContext) => {
  const box = await packageBox(t);
  const supported = await installation(box, 'Supported');
  const unsupported = await installation(box, 'Unsupported', 'const unsupported = true;');
  const before = await snapshot(join(box.directory, 'home'));
  const mixed = check(box);
  assert.equal(mixed.code, 3);
  assert.equal(mixed.result.outcome, 'incompatible');
  assert.equal(required(mixed.result.data).inspection, null);
  assert.deepEqual(required(mixed.result.data).inspections.map(entry => entry.support), ['supported', 'unsupported']);
  assert.ok(mixed.result.diagnostics.every(entry => entry.installation === unsupported.app && entry.path === unsupported.target));
  const scenario = join(box.directory, 'boundary.json');
  await writeFile(scenario, JSON.stringify({ processRows: [{ pid: 998877, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }] }));
  const blocked = check(box, ['--app', supported.app]);
  assert.equal(blocked.code, 0);
  assert.equal(required(required(blocked.result.data).inspection).support, 'supported');
  assert.equal(required(required(blocked.result.data).inspection).state, 'original');
  assert.equal(required(required(blocked.result.data).inspection).writeReadiness, 'blocked');
  assert.deepEqual(required(required(blocked.result.data).inspection).allowedActions, []);
  assert.equal(required(required(required(blocked.result.data).inspection).blockers[0]).code, 'PROCESSES_RUNNING');
  assert.equal(required(blocked.result.data).runtime, 'not-verified');
  const human = runNpmExec(['check', '--app', supported.app], box);
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /write readiness: blocked/);
  assert.match(human.stdout, /Can install: no/);
  assert.match(human.stdout, /PROCESSES_RUNNING/);
  assert.match(human.stdout, /Runtime: not-verified/);
  await writeFile(scenario, JSON.stringify({ processFailure: true }));
  const failed = check(box);
  assert.equal(failed.code, 1);
  assert.equal(required(failed.result.data).inspections.length, 2);
  for (const inspection of required(failed.result.data).inspections) {
    assert.equal(inspection.writeReadiness, 'unknown');
    assert.equal(inspection.runtime, 'not-verified');
    assert.deepEqual(inspection.allowedActions, []);
    assert.ok(failed.result.diagnostics.some(entry => entry.code === 'PROCESS_ENUMERATION_FAILED' && entry.installation === inspection.candidate.appPath));
  }
  await rm(scenario);
  const parent = join(supported.target, '..');
  const parentMode = (await stat(parent)).mode & 0o7777;
  await chmod(parent, 0o500);
  try {
    const denied = check(box, ['--app', supported.app]);
    assert.equal(denied.code, 0);
    assert.equal(required(required(denied.result.data).inspection).writeReadiness, 'blocked');
    assert.ok(required(required(denied.result.data).inspection).blockers.some(entry => entry.code === 'TARGET_NOT_WRITABLE' && entry.path === parent));
  } finally { await chmod(parent, parentMode); }
  assert.deepEqual(await snapshot(join(box.directory, 'home')), before);
});

test('npx check reports an unwritable coordination root per installation without probing storage', async (t: TestContext) => {
  const box = await packageBox(t);
  const first = await installation(box, 'CoordinationFirst');
  const second = await installation(box, 'CoordinationSecond');
  const coordination = join(box.directory, 'home/.codex-unfence');
  await mkdir(coordination, { mode: 0o500 });
  try {
    const before = await snapshot(join(box.directory, 'home'));
    const blocked = check(box);
    assert.equal(blocked.code, 0);
    for (const inspection of required(blocked.result.data).inspections) {
      assert.equal(inspection.support, 'supported');
      assert.equal(inspection.state, 'original');
      assert.equal(inspection.writeReadiness, 'blocked');
      assert.deepEqual(inspection.allowedActions, []);
      assert.ok(inspection.blockers.some(entry => entry.code === 'COORDINATION_NOT_WRITABLE' && entry.path === coordination));
    }
    const human = runNpmExec(['check'], box);
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /Can install: no/);
    for (const { app } of [first, second]) {
      assert.ok(human.stdout.includes(`Installation: ${app}`));
      assert.ok(human.stdout.includes(`(installation: ${app})`));
      assert.ok(blocked.result.diagnostics.some(entry => entry.code === 'COORDINATION_NOT_WRITABLE' && entry.path === coordination && entry.installation === app));
    }
    assert.deepEqual(await snapshot(join(box.directory, 'home')), before);
    const refused = await runNpmExecPty(['install', '--app', first.app], { ...box, steps: [
      { waitFor: 'Action (recheck, cancel)', send: 'cancel\n' },
    ] });
    assert.equal(refused.status, 4, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /COORDINATION_NOT_WRITABLE/);
    assert.deepEqual(await snapshot(join(box.directory, 'home')), before);
  } finally { await chmod(coordination, 0o700); }
});

test('npx check handles empty discovery, missing explicit paths and usage errors noninteractively and read-only', async (t: TestContext) => {
  const box = await packageBox(t);
  const empty = check(box);
  assert.equal(empty.code, 1);
  assert.equal(empty.result.outcome, 'runtime-error');
  assert.deepEqual(required(empty.result.data).inspections, []);
  assert.equal(required(empty.result.data).discovery.selection, 'none');
  assert.ok(empty.result.diagnostics.some(entry => entry.code === 'NO_INSTALLATIONS'));
  const missing = join(box.directory, 'Missing.app');
  const explicit = check(box, ['--app', missing]);
  assert.equal(explicit.code, 1);
  assert.ok(explicit.result.diagnostics.some(entry => entry.code === 'ENOENT' && entry.path === missing));
  const human = runNpmExec(['check'], box);
  assert.equal(human.status, 1, human.stdout + human.stderr);
  assert.match(human.stdout, /NO_INSTALLATIONS/);
  for (const args of [['--app', 'relative.app'], ['--app', missing, '--app', missing], ['--unknown'], ['extra']]) {
    const invalid = check(box, args);
    assert.equal(invalid.code, 2, JSON.stringify(args));
    assert.equal(invalid.result.outcome, 'usage-error');
  }
  assert.deepEqual(await readdir(join(box.directory, 'home')), []);
});
