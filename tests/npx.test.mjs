import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import * as npmPackage from './helpers/npm-package.mjs';

async function packageBox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-npx-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = npmPackage.packPackage(directory);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const [metadata] = JSON.parse(packed.stdout);
  const cwd = join(directory, 'unrelated working directory');
  await mkdir(cwd);
  return { directory, cwd, tarball: join(directory, metadata.filename) };
}

function help(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /codex-browser-patch/);
  assert.match(result.stdout, /macOS/);
  assert.match(result.stdout, /--help/);
}

function inside(root, path) {
  const suffix = relative(root, path);
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), path);
}

test('offline npm exec runs the packed public bin from an unrelated cwd with isolated final-bin boundaries', async (t) => {
  const box = await packageBox(t);
  help(npmPackage.runNpmExec(['--help'], box));
  const observed = JSON.parse(await readFile(join(box.directory, 'final-bin.json'), 'utf8'));
  inside(join(box.directory, 'npm-cache'), observed.entry);
  assert.ok(observed.entry.endsWith('/node_modules/codex-browser-liberation-patch/dist/cli.js'));
  assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
  assert.equal(observed.cwd, box.cwd);
  assert.equal(observed.home, join(box.directory, 'home'));
  assert.equal(observed.stdinTTY, false);
  assert.equal(observed.stdoutTTY, false);
});

test('packed npm exec check uses genuine structural admission and remains read-only', async (t) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Synthetic.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(target, source);
  const child = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.data.inspection.support, 'supported');
  assert.equal(result.data.inspection.state, 'original');
  assert.deepEqual(await readFile(target), source);
  await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-browser-liberation-patch/key')), { code: 'ENOENT' });
});

test('offline npm exec exposes help through a real PTY and propagates the public bin exit status', async (t) => {
  const box = await packageBox(t);
  help(await npmPackage.runNpmExecPty(['--help'], box));
  const observed = JSON.parse(await readFile(join(box.directory, 'final-bin.json'), 'utf8'));
  inside(join(box.directory, 'npm-cache'), observed.entry);
  assert.equal(observed.stdinTTY, true);
  assert.equal(observed.stdoutTTY, true);
  const invalid = await npmPackage.runNpmExecPty(['--unknown'], box);
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
});

test('confirmed npm exec changes survive code-cache removal and repeated apply/restore', async t => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Lifecycle.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(target, source);
  const change = command => npmPackage.runNpmExecPty([command, '--app', app], {
    ...box, steps: [{ waitFor: 'Type yes', send: 'yes\n' }],
  });
  const applied = await change('apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /tool-applied \(applied\)/);
  const patched = await readFile(target);
  assert.notDeepEqual(patched, source);
  assert.match((await change('apply')).stdout, /already-applied/);
  const previous = JSON.parse(await readFile(join(box.directory, 'final-bin.json'), 'utf8')).entry;
  await rm(join(box.directory, 'npm-cache'), { recursive: true });
  await assert.rejects(readFile(previous), { code: 'ENOENT' });
  const status = npmPackage.runNpmExec(['status', '--app', app, '--json'], box);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).data.targets[0].state, 'tool-applied');
  assert.match((await change('restore')).stdout, /original \(restored\)/);
  assert.deepEqual(await readFile(target), source);
  assert.match((await change('restore')).stdout, /already-original/);
});

test('npm exec discovers interrupted apply after reacquisition and can recover after recovery is interrupted again', async t => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Interrupted.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(target, source);
  const change = command => npmPackage.runNpmExecPty([command, '--app', app], {
    ...box, steps: [{ waitFor: 'Type yes', send: 'yes\n' }],
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
  assert.equal(JSON.parse(state.stdout).data.inspection.state, 'incomplete');
  assert.deepEqual(JSON.parse(state.stdout).data.inspection.allowedActions, ['recover']);
  await writeFile(scenario, JSON.stringify({ killAfterRename: target }));
  assert.notEqual((await change('recover')).status, 0);
  await rm(scenario);
  const recovered = await change('recover');
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.match(recovered.stdout, /rolled-back/);
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

test('npm exec refuses a target changed after inspection instead of applying to new bytes', async t => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Changed.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(target, source);
  const changed = Buffer.concat([source, Buffer.from('\n// external change\n')]);
  const child = await npmPackage.runNpmExecPty(['apply', '--app', app], { ...box, steps: [
    { waitFor: 'Type yes', beforeSend: () => writeFile(target, changed), send: 'yes\n' },
  ] });
  assert.equal(child.status, 4, child.stdout + child.stderr);
  assert.match(child.stdout, /INSPECTION_CHANGED/);
  assert.deepEqual(await readFile(target), changed);
});

test('npm exec check reports process failures and a blocked guide can recheck after the host exits', async t => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Blocked.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(target, source);
  const scenario = join(box.directory, 'boundary.json');
  await writeFile(scenario, JSON.stringify({ processFailure: true }));
  const failed = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  assert.equal(JSON.parse(failed.stdout).data.inspection.writeReadiness, 'unknown');
  await writeFile(scenario, JSON.stringify({ processRows: [{ pid: 998877, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }] }));
  const blocked = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  const inspected = JSON.parse(blocked.stdout).data.inspection;
  assert.equal(inspected.support, 'supported');
  assert.equal(inspected.writeReadiness, 'blocked');
  assert.deepEqual(inspected.allowedActions, []);
  const guided = await npmPackage.runNpmExecPty([], { ...box, steps: [
    { waitFor: 'Action (recheck', beforeSend: () => writeFile(scenario, '{}'), send: 'recheck\n' },
    { waitFor: 'Action (apply', send: 'apply\n' },
    { waitFor: 'Type yes', send: 'yes\n' },
  ] });
  assert.equal(guided.status, 0, guided.stdout + guided.stderr);
  assert.match(guided.stdout, /PROCESSES_RUNNING/);
  assert.match(guided.stdout, /tool-applied \(applied\)/);
});

test('multiple installations require selection and confirmation EOF leaves the selected bytes unchanged', async t => {
  const box = await packageBox(t);
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  const targets = [];
  for (const name of ['First', 'Second']) {
    const target = join(box.directory, `home/Applications/${name}.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, source);
    targets.push(target);
  }
  const ambiguous = npmPackage.runNpmExec(['check', '--json'], box);
  assert.equal(ambiguous.status, 2, ambiguous.stdout + ambiguous.stderr);
  assert.equal(JSON.parse(ambiguous.stdout).diagnostics.at(-1).code, 'SELECTION_REQUIRED');
  const guided = await npmPackage.runNpmExecPty([], { ...box, steps: [
    { waitFor: 'Select installation', send: '2\n' },
    { waitFor: 'Action', send: 'apply\n' },
    { waitFor: 'Type yes', send: '\u0004' },
  ] });
  assert.equal(guided.status, 0, guided.stdout + guided.stderr);
  assert.ok(guided.stdout.includes(`Target: ${targets[1]}`));
  assert.match(guided.stdout, /Cancelled/);
  for (const target of targets) assert.deepEqual(await readFile(target), source);
});

test('guide offers only admitted actions and EOF never confirms a write', async t => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Unsupported.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, 'const unknown = true;');
  const guided = await npmPackage.runNpmExecPty([], { ...box, steps: [{ waitFor: 'Action', send: '\u0004' }] });
  assert.equal(guided.status, 0, guided.stdout + guided.stderr);
  assert.match(guided.stdout, /Action \(recheck, cancel\)/);
  assert.equal(await readFile(target, 'utf8'), 'const unknown = true;');
});

test('default npm exec guide displays the selected target and cancels without changing installation', async t => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Guide.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(target, source);
  const child = await npmPackage.runNpmExecPty([], { ...box, steps: [
    { waitFor: 'Action', send: 'apply\n' }, { waitFor: 'Type yes', send: 'no\n' },
  ] });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.ok(child.stdout.includes(target));
  assert.doesNotMatch(child.stdout, /Select installation number/);
  assert.match(child.stdout, /signature/);
  assert.match(child.stdout, /Cancelled/);
  assert.deepEqual(await readFile(target), source);
});
