function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import type { Candidate, DiscoveryReport, Inspection } from '../src/managed-patches.js';
import type { LeaseRecord } from '../src/transaction-locks.js';
import type { OperationResult } from '../src/result.js';
type DriverResult<C extends string> = C extends 'discover' ? DiscoveryReport : C extends 'inspect' ? Inspection : OperationResult;
import type { TestContext } from 'node:test';
import { sourceFixture } from './helpers/paths.js';
import assert from 'node:assert/strict';
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli, startCli } from './helpers/cli.js';
import { once } from 'node:events';
import { setTimeout } from 'node:timers';

const binary = fileURLToPath(new URL('./fixtures/managed-patches-driver.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));
const service = 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs';
async function sandbox(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'managed-patches-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'home/Applications'), { recursive: true });
  return { directory };
}
async function installation(box: {directory: string}, name: string, version: string) {
  const appPath = join(box.directory, 'home/Applications', name + '.app');
  const targetPath = join(appPath, service);
  await mkdir(join(targetPath, '..'), { recursive: true });
  await writeFile(targetPath, '// synthetic, never evaluated\n');
  await writeFile(join(appPath, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>999</string></dict></plist>`);
  return { appPath, targetPath };
}
function run<C extends string>(box: {directory: string}, command: C, payload: object = {}, env: NodeJS.ProcessEnv = {}) {
  const result = runCli([command, JSON.stringify(payload)], { binary, fixture, directory: box.directory, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const parsed: DriverResult<C> = JSON.parse(result.stdout);
  return parsed;
}

test('discovery returns every CUA installation without selecting by version and changes no files', async (t: TestContext) => {
  const box = await sandbox(t);
  const first = await installation(box, 'Codex', '999.0');
  const second = await installation(box, 'ChatGPT', '1.0');
  const before = await readFile(first.targetPath);
  const report = run(box, 'discover');
  assert.equal(report.selection, 'required');
  assert.deepEqual(report.candidates.map(({ appPath, targetPath }) => ({ appPath, targetPath })).sort((a, b) => a.appPath.localeCompare(b.appPath)), [first, second].sort((a, b) => a.appPath.localeCompare(b.appPath)));
  assert.deepEqual(report.candidates.map(candidate => candidate.version).sort(), ['1.0', '999.0']);
  assert.deepEqual(await readFile(first.targetPath), before);
  assert.deepEqual((await readdir(join(box.directory, 'home'))).sort(), ['Applications']);
  assert.equal(report.runtime, 'not-verified');
});

test('explicit discovery reports missing installations and refuses symlink or hardlink aliases', async (t: TestContext) => {
  const box = await sandbox(t);
  assert.equal(run(box, 'discover').selection, 'none');
  assert.equal(required(run(box, 'discover', { appPath: join(box.directory, 'missing.app') }).diagnostics[0]).code, 'ENOENT');
  const selected = await installation(box, 'Selected', 'unlisted-version');
  assert.equal(required(run(box, 'discover', { appPath: selected.appPath }).candidates[0]).version, 'unlisted-version');
  const alias = join(box.directory, 'Alias.app');
  await symlink(selected.appPath, alias);
  assert.equal(required(run(box, 'discover', { appPath: alias }).diagnostics[0]).code, 'PATH_ALIAS');
  await link(selected.targetPath, selected.targetPath + '.alias');
  assert.equal(required(run(box, 'discover', { appPath: selected.appPath }).diagnostics[0]).code, 'PATH_ALIAS');
  assert.deepEqual((await readdir(join(box.directory, 'home'))).sort(), ['Applications']);
});

test('default discovery ignores ordinary app aliases that have no CUA service', async (t: TestContext) => {
  const box = await sandbox(t);
  const ordinary = join(box.directory, 'ordinary.app');
  await mkdir(ordinary);
  await symlink(ordinary, join(box.directory, 'home/Applications/Ordinary.app'));
  const report = run(box, 'discover');
  assert.equal(report.selection, 'none');
  assert.deepEqual(report.diagnostics, []);
});

test('inspection reports unsupported code separately from active-process warnings and creates no recovery state', async (t: TestContext) => {
  const box = await sandbox(t);
  const candidate = { ...await installation(box, 'Inspect', 'anything'), version: null, build: null };
  const original = await readFile(candidate.targetPath);
  const inspection = run(box, 'inspect', candidate, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 987654, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }]) });
  assert.equal(inspection.support, 'unsupported');
  assert.equal(inspection.writeReadiness, 'ready');
  assert.equal(inspection.state, 'incompatible');
  assert.deepEqual(inspection.blockers, []);
  assert.deepEqual(inspection.allowedActions, []);
  assert.ok(inspection.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning'));
  assert.ok(inspection.diagnostics.length > 0);
  assert.equal(inspection.runtime, 'not-verified');
  assert.equal(typeof inspection.inspectionToken, 'string');
  assert.deepEqual(await readFile(candidate.targetPath), original);
  assert.deepEqual((await readdir(join(box.directory, 'home'))).sort(), ['Applications']);
});

async function supportedInstallation(box: {directory: string}) {
  const candidate = { ...await installation(box, 'Supported', 'unlisted-42'), version: 'unlisted-42', build: '999' };
  const original = await readFile(sourceFixture('deferred-site-status.js.txt'));
  await writeFile(candidate.targetPath, original, { mode: 0o644 });
  return { candidate, original };
}

test('managed operations persist private recovery state and restore original bytes after repeated application', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.support, 'supported');
  assert.equal(inspection.state, 'original');
  assert.equal(inspection.writeReadiness, 'ready');
  await assert.rejects(access(join(box.directory, 'home/Library')), { code: 'ENOENT' });
  const applied = run(box, 'apply', candidate);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied));
  assert.equal(required(required(applied.data).targets[0]).action, 'applied');
  const patched = await readFile(candidate.targetPath);
  assert.notDeepEqual(patched, original);
  const after = run(box, 'inspect', candidate);
  assert.equal(after.state, 'tool-applied');
  assert.equal(after.sourcePatch?.status, 'detected');
  assert.equal(after.support, 'supported');
  assert.equal(required(after.recovery).tool.version, '9.8.7-synthetic');
  assert.equal(required(after.recovery).command, 'npx --package codex-unfence@9.8.7-synthetic codex-unfence');
  assert.equal(required(required(run(box, 'apply', candidate).data).targets[0]).action, 'already-applied');
  assert.deepEqual(await readFile(candidate.targetPath), patched);
  assert.equal(required(required(run(box, 'restore', candidate).data).targets[0]).action, 'restored');
  assert.deepEqual(await readFile(candidate.targetPath), original);
  const restored = run(box, 'status', candidate);
  assert.equal(required(required(restored.data).targets[0]).state, 'original');
  assert.equal(required(required(restored.data).targets[0]).action, 'restored');
  assert.equal(required(required(run(box, 'restore', candidate).data).targets[0]).action, 'already-original');
  assert.equal((await stat(required(after.recovery).preparation)).mode & 0o777, 0o700);
  assert.equal((await stat(join(required(after.recovery).preparation, 'source.original.mjs'))).mode & 0o777, 0o600);
  assert.equal((await stat(required(after.recovery).store)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(required(after.recovery).preparation)).sort(), ['manifest.json', 'source.original.mjs']);
  const manifest: { formatVersion: number; basis?: unknown; original: { sha256: string }; patched: { sha256: string } } = JSON.parse(await readFile(join(required(after.recovery).preparation, 'manifest.json'), 'utf8'));
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.basis, undefined);
  const transactions = join(required(after.recovery).store, 'transactions');
  assert.equal((await readdir(transactions)).length, 2, 'no-op application and restoration must not append transactions');
  for (const id of await readdir(transactions)) {
    assert.deepEqual((await readdir(join(transactions, id))).sort(), ['journal.json', 'plan']);
    assert.deepEqual(await readdir(join(transactions, id, 'plan')), ['reference.json']);
  }
  assert.deepEqual(await readdir(join(candidate.targetPath, '..')), ['browser-service.mjs']);
});

test('application updates retire the old patch without restoring old bytes over the new installation', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const previous = required(run(box, 'inspect', candidate).recovery);
  const updated = Buffer.concat([Buffer.from('// updated application\n'), original]);
  await rename(candidate.targetPath, join(box.directory, 'old-patched.mjs'));
  await writeFile(candidate.targetPath, updated, { mode: 0o644 });
  await writeFile(join(candidate.appPath, 'Contents/Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>updated-43</string><key>CFBundleVersion</key><string>1000</string></dict></plist>');
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.state, 'original');
  assert.equal(inspection.support, 'supported');
  assert.equal(inspection.writeReadiness, 'ready');
  assert.ok(inspection.allowedActions.includes('apply'));
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), updated);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const current = required(run(box, 'inspect', candidate).recovery);
  assert.notEqual(current.preparation, previous.preparation);
  assert.deepEqual(await readFile(join(previous.preparation, 'source.original.mjs')), original);
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), updated);
});

async function updateInstallation(box: { directory: string }, candidate: Candidate, bytes: Buffer | string, build = '1000') {
  await rename(candidate.targetPath, join(box.directory, `replaced-${build}.mjs`));
  await writeFile(candidate.targetPath, bytes, { mode: 0o644 });
  await writeFile(join(candidate.appPath, 'Contents/Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key><string>updated</string><key>CFBundleVersion</key><string>${build}</string></dict></plist>`);
}

test('replacement inspection is read-only and analyzes current unsupported bytes instead of historical support', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  await updateInstallation(box, candidate, '// unsupported new application\n');
  const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
  const before = await readdir(join(root, 'targets'));
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.state, 'incompatible');
  assert.equal(inspection.support, 'unsupported');
  assert.deepEqual(inspection.allowedActions, []);
  assert.equal(inspection.recovery, null);
  assert.equal(run(box, 'status', candidate).exitCode, 3);
  assert.deepEqual(await readdir(join(root, 'targets')), before);
  assert.equal(await readFile(candidate.targetPath, 'utf8'), '// unsupported new application\n');
});

test('version changes do not admit in-place edits or copied patched files', async (t: TestContext) => {
  for (const mutation of ['in-place', 'patched-copy', 'unchanged-version']) {
    const box = await sandbox(t);
    const { candidate, original } = await supportedInstallation(box);
    assert.equal(run(box, 'apply', candidate).exitCode, 0);
    const patched = await readFile(candidate.targetPath);
    if (mutation === 'in-place') {
      await writeFile(candidate.targetPath, original);
      await writeFile(join(candidate.appPath, 'Contents/Info.plist'), '<plist><dict><key>CFBundleVersion</key><string>1000</string></dict></plist>');
    } else if (mutation === 'patched-copy') await updateInstallation(box, candidate, patched);
    else {
      await rename(candidate.targetPath, join(box.directory, 'replaced.mjs'));
      await writeFile(candidate.targetPath, original);
    }
    const before = await readFile(candidate.targetPath);
    assert.equal(run(box, 'inspect', candidate).state, 'conflict', mutation);
    assert.equal(run(box, 'apply', candidate).exitCode, 4, mutation);
    assert.equal(run(box, 'restore', candidate).exitCode, 4, mutation);
    assert.deepEqual(await readFile(candidate.targetPath), before);
  }
});

test('successive application updates keep independent backups and only restore the current revision', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  for (const build of ['1000', '1001']) {
    const updated = Buffer.concat([Buffer.from(`// build ${build}\n`), original]);
    await updateInstallation(box, candidate, updated, build);
    assert.equal(run(box, 'status', candidate).exitCode, 0);
    assert.equal(run(box, 'apply', candidate).exitCode, 0);
    assert.equal(run(box, 'restore', candidate).exitCode, 0);
    assert.deepEqual(await readFile(candidate.targetPath), updated);
  }
  assert.equal((await readdir(join(box.directory, 'home/Library/Application Support/codex-unfence/preparations'))).length, 3);
});

test('local analyzer restores a preparation created with historical evidence', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const applied = run(box, 'legacy-apply', candidate);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied));
  assert.notDeepEqual(await readFile(candidate.targetPath), original);
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.state, 'tool-applied');
  assert.equal(inspection.recovery?.tool.version, '0.2.0');
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), original);
});

test('restoration uses authenticated bytes even when the current analyzer no longer supports the original', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const child = runCli(['restore-without-support', JSON.stringify(candidate)], { binary, fixture, directory: box.directory });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result: { inspection: Inspection; operation: OperationResult } = JSON.parse(child.stdout);
  assert.equal(result.inspection.support, 'unsupported');
  assert.deepEqual(result.inspection.allowedActions, ['restore']);
  assert.equal(result.operation.exitCode, 0, JSON.stringify(result.operation));
  assert.deepEqual(await readFile(candidate.targetPath), original);
});

test('missing recovery bytes preserve current structural compatibility and never authorize restoration', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  const preparation = required(run(box, 'inspect', candidate).recovery).preparation;
  await rm(join(preparation, 'source.original.mjs'));
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.support, 'supported');
  assert.equal(inspection.state, 'conflict');
  assert.deepEqual(inspection.allowedActions, []);
  assert.ok(inspection.diagnostics.some(entry => entry.code === 'RECOVERY_MATERIAL_MISSING'));
  assert.notEqual(run(box, 'restore', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), original);
});

test('new local shapes support managed application and restoration', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const changed = original.toString('utf8').replace('conversationId: metadata?.session_id', 'backendApiBaseUrl: runtime.env?.backend, conversationId: metadata?.session_id');
  assert.notEqual(changed, original.toString('utf8'));
  await writeFile(candidate.targetPath, changed);
  assert.equal(run(box, 'inspect', candidate).support, 'supported');
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  assert.equal(await readFile(candidate.targetPath, 'utf8'), changed);
});

test('repeated managed operations derive each source once per operation while preserving identity on no-ops', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  const child = runCli(['repeat-validation', JSON.stringify(candidate)], { binary, fixture, directory: box.directory });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result: { steps: { operation: OperationResult; derivations: number; identityUnchanged: boolean }[] } = JSON.parse(child.stdout);
  assert.deepEqual(result.steps.map(step => step.operation.exitCode), [0, 0, 0, 0, 0], JSON.stringify(result.steps.map(step => step.operation.diagnostics)));
  assert.deepEqual(result.steps.map(step => required(required(step.operation.data).targets[0]).action), ['applied', 'already-applied', 'restored', 'already-original', 'applied']);
  assert.deepEqual(result.steps.map(step => step.identityUnchanged), [false, true, false, true, false]);
  assert.deepEqual(result.steps.map(step => step.derivations), [1, 1, 1, 1, 1]);
});

test('a large synthetic installation supports repeated apply without long validation or target replacement', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const source = Buffer.concat([original, Buffer.from(Array.from({ length: 3000 }, (_, index) =>
    `\nasync function unrelated${index}(value) { return value + ${index}; }`).join('')), Buffer.from(`\n/*${'inert data;'.repeat(160000)}*/`)]);
  await writeFile(candidate.targetPath, source);
  const started = performance.now();
  const child = runCli(['repeat-validation', JSON.stringify(candidate)], { binary, fixture, directory: box.directory, timeout: 15000 });
  assert.equal(child.status, 0, child.stdout + child.stderr + String(child.error ?? ''));
  const result: { steps: { operation: OperationResult; identityUnchanged: boolean }[] } = JSON.parse(child.stdout);
  assert.deepEqual(result.steps.map(step => step.operation.exitCode), [0, 0, 0, 0, 0], JSON.stringify(result.steps.map(step => step.operation.diagnostics)));
  assert.deepEqual(result.steps.map(step => step.identityUnchanged), [false, true, false, true, false]);
  assert.ok(performance.now() - started < 15000);
});

test('managed analysis reuse cannot survive caller mutation or changed preparation bytes between operations', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const patched = await readFile(candidate.targetPath);
  const child = runCli(['inspect-after-mutation', JSON.stringify(candidate)], { binary, fixture, directory: box.directory });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result: { independent: Inspection; changed: Inspection; restored: Inspection } = JSON.parse(child.stdout);
  assert.equal(result.independent.support, 'supported');
  assert.equal(result.independent.state, 'tool-applied');
  assert.equal(result.changed.state, 'conflict');
  assert.deepEqual(result.changed.allowedActions, []);
  assert.equal(result.restored.state, 'tool-applied');
  assert.deepEqual(await readFile(candidate.targetPath), patched);
});

test('apply rejects a supported original changed after confirmation token validation', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const replacement = join(box.directory, 'replacement.mjs');
  const changed = Buffer.concat([Buffer.from('// later supported revision\n'), original]);
  await writeFile(replacement, changed);
  const refused = run(box, 'apply', candidate, { CODEX_TEST_FAULT: 'managed-confirmation-change', CODEX_TEST_TARGET: candidate.targetPath, CODEX_TEST_REPLACEMENT: replacement });
  assert.equal(refused.exitCode, 4);
  assert.ok(refused.diagnostics.some(entry => ['INSPECTION_CHANGED', 'TARGET_CHANGED'].includes(entry.code)));
  assert.deepEqual(await readFile(candidate.targetPath), changed);
});

async function pauseOperation(t: TestContext, box: {directory: string}, candidate: Candidate, command: string, boundary: string) {
  const child = startCli([command, JSON.stringify(candidate)], { directory: box.directory, binary, fixture, env: { CODEX_TEST_PAUSE: boundary, CODEX_TEST_TARGET: candidate.targetPath }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  await Promise.race([
    once(child, 'message').then(([message]: unknown[]) => assert.equal((message as {boundary: string}).boundary, boundary)),
    once(child, 'exit').then(([code, signal]: unknown[]) => { throw new Error(`Driver exited before ${boundary}: ${code}/${signal} ${stdout} ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`No boundary ${boundary}: ${stdout} ${stderr}`)), 15000); timer.unref(); }),
  ]);
  return {
    async kill() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; },
    async finish() {
      const exited = once(child, 'exit');
      child.send('continue');
      const [code] = await exited;
      assert.equal(code, 0, stdout + stderr);
      assert.equal(stderr, '');
      const result: OperationResult = JSON.parse(stdout);
      return result;
    },
  };
}

test('selection publication interruptions preserve the updated source and permit a fresh retry', async (t: TestContext) => {
  for (const boundary of ['before-selection-publication', 'after-selection-publication']) {
    const box = await sandbox(t);
    const { candidate, original } = await supportedInstallation(box);
    assert.equal(run(box, 'apply', candidate).exitCode, 0);
    const updated = Buffer.concat([Buffer.from('// replacement build\n'), original]);
    await updateInstallation(box, candidate, updated);
    const interrupted = await pauseOperation(t, box, candidate, 'apply', boundary);
    await interrupted.kill();
    assert.deepEqual(await readFile(candidate.targetPath), updated, boundary);
    assert.equal(run(box, 'inspect', candidate).state, 'original', boundary);
    assert.equal(run(box, 'apply', candidate).exitCode, 0, boundary);
    assert.equal(run(box, 'restore', candidate).exitCode, 0, boundary);
    assert.deepEqual(await readFile(candidate.targetPath), updated, boundary);
  }
});

test('an update after selection publication but before intent cannot reuse an outdated preparation', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  await updateInstallation(box, candidate, original);
  const interrupted = await pauseOperation(t, box, candidate, 'apply', 'after-selection-publication');
  await interrupted.kill();
  const newer = Buffer.concat([Buffer.from('// subsequent update\n'), original]);
  await updateInstallation(box, candidate, newer, '1001');
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.state, 'original');
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), newer);
});

test('a published selection remains discoverable after the publisher reports an error', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  await updateInstallation(box, candidate, original);
  assert.equal(run(box, 'apply', candidate, { CODEX_TEST_FAULT: 'selection-publication-error' }).exitCode, 1);
  assert.equal(run(box, 'inspect', candidate).state, 'original');
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), original);
});

test('competing replacement selections cannot supersede a newly confirmed installation', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  await updateInstallation(box, candidate, original);
  const first = await pauseOperation(t, box, candidate, 'apply', 'before-operation-lock');
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const second = required(run(box, 'inspect', candidate).recovery);
  const refused = await first.finish();
  assert.equal(refused.exitCode, 4);
  assert.ok(refused.diagnostics.some(entry => entry.code === 'INSPECTION_CHANGED'));
  assert.equal(required(run(box, 'inspect', candidate).recovery).preparation, second.preparation);
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), original);
});

test('recovery after applying to an updated installation rolls back to the updated bytes', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const updated = Buffer.concat([Buffer.from('// replacement before interrupted apply\n'), original]);
  await updateInstallation(box, candidate, updated);
  const interrupted = await pauseOperation(t, box, candidate, 'apply', 'after-target-rename');
  await interrupted.kill();
  assert.equal(run(box, 'inspect', candidate).state, 'incomplete');
  assert.equal(run(box, 'recover', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), updated);
  assert.equal(run(box, 'inspect', candidate).state, 'original');
});

test('an interrupted installation still requires recovery after an application update', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const interrupted = await pauseOperation(t, box, candidate, 'apply', 'after-target-rename');
  await interrupted.kill();
  // 即使文件系统复用原 inode，新内容也能明确区分这次更新。
  const updated = Buffer.concat([Buffer.from('// application updated during an incomplete transaction\n'), original]);
  await updateInstallation(box, candidate, updated);
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.state, 'conflict');
  assert.deepEqual(inspection.allowedActions, []);
  assert.equal(run(box, 'apply', candidate).exitCode, 4);
  assert.deepEqual(await readFile(candidate.targetPath), updated);
});

test('interrupted managed apply is discoverable and recover rolls back without continuing application', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const interrupted = await pauseOperation(t, box, candidate, 'apply', 'after-target-rename');
  const root = join(box.directory, 'home/Library/Application Support/codex-unfence');
  assert.equal((await readdir(join(root, 'targets'))).length, 1);
  await interrupted.kill();
  assert.notDeepEqual(await readFile(candidate.targetPath), original);
  const pending = run(box, 'inspect', candidate);
  assert.equal(pending.state, 'incomplete');
  assert.equal(pending.writeReadiness, 'blocked');
  assert.deepEqual(pending.allowedActions, ['recover']);
  const recovered = run(box, 'recover', candidate);
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.equal(required(required(recovered.data).targets[0]).action, 'rolled-back');
  assert.deepEqual(await readFile(candidate.targetPath), original);
  assert.equal(required(required(run(box, 'status', candidate).data).targets[0]).state, 'original');
  assert.deepEqual(await readdir(join(candidate.targetPath, '..')), ['browser-service.mjs']);
});

test('external coordination publication interruptions retry without leaving installation artifacts', async (t: TestContext) => {
  for (const boundary of ['after-coordination-lock-link', 'after-coordination-successor-link', 'after-coordination-release-link']) {
    const box = await sandbox(t);
    const { candidate, original } = await supportedInstallation(box);
    if (boundary === 'after-coordination-successor-link') {
      assert.equal(run(box, 'apply', candidate).exitCode, 0);
      assert.equal(run(box, 'restore', candidate).exitCode, 0);
    }
    const interrupted = await pauseOperation(t, box, candidate, 'apply', boundary);
    await interrupted.kill();
    assert.deepEqual(await readdir(join(candidate.targetPath, '..')), ['browser-service.mjs']);
    const next = boundary === 'after-coordination-release-link' ? 'restore' : 'apply';
    assert.equal(run(box, next, candidate).exitCode, 0);
    assert.equal(run(box, 'restore', candidate).exitCode, 0);
    assert.deepEqual(await readFile(candidate.targetPath), original);
    assert.deepEqual(await readdir(join(candidate.targetPath, '..')), ['browser-service.mjs']);
    assert.deepEqual(required(run(box, 'status', candidate).data).pendingTransactions, []);
  }
});

test('managed writes preserve unexplained target artifacts, including artifacts introduced while acquiring coordination', async (t: TestContext) => {
  for (const name of ['.codex-unfence.lock', '.codex-unfence.lock.orphan.next', '.codex-unfence-interrupted.tmp', '.publish-interrupted']) {
    const box = await sandbox(t);
    const { candidate, original } = await supportedInstallation(box);
    const artifact = join(candidate.targetPath, '..', name);
    await writeFile(artifact, 'unexplained artifact', { mode: 0o600 });
    for (const command of ['status', 'apply', 'restore']) {
      const rejected = run(box, command, candidate);
      assert.equal(rejected.exitCode, 4);
      assert.equal(required(rejected.diagnostics[0]).code, command === 'status' ? 'LEGACY_TARGET_ARTIFACTS' : 'TARGET_CONFLICT');
      assert.deepEqual(await readFile(candidate.targetPath), original);
      assert.equal(await readFile(artifact, 'utf8'), 'unexplained artifact');
    }
    await assert.rejects(access(join(box.directory, 'home/Library')), { code: 'ENOENT' });
  }
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const waiting = await pauseOperation(t, box, candidate, 'apply', 'before-coordination-link');
  const artifact = join(candidate.targetPath, '..', '.codex-unfence.lock.orphan.next');
  await writeFile(artifact, 'introduced during coordination', { mode: 0o600 });
  const rejected = await waiting.finish();
  assert.equal(rejected.exitCode, 4);
  assert.equal(required(rejected.diagnostics[0]).code, 'LEGACY_TARGET_ARTIFACTS');
  assert.deepEqual(await readFile(candidate.targetPath), original);
  assert.equal(await readFile(artifact, 'utf8'), 'introduced during coordination');
  assert.deepEqual(await readdir(join(required(run(box, 'inspect', candidate).recovery).store, 'transactions')), []);
});

test('managed coordination ignores HOME/XDG overrides and refuses aliases, permissive directories and changed ownership', async (t: TestContext) => {
  for (const mutation of ['symlink', 'permissions', 'ownership']) {
    const box = await sandbox(t);
    const { candidate, original } = await supportedInstallation(box);
    assert.equal(run(box, 'apply', candidate).exitCode, 0);
    assert.equal(run(box, 'restore', candidate).exitCode, 0);
    const root = join(box.directory, 'home/.codex-unfence/target-leases');
    const [name] = await readdir(root);
    const directory = join(root, required(name));
    if (mutation === 'symlink') {
      await rename(directory, directory + '.moved');
      await symlink(directory + '.moved', directory);
    } else if (mutation === 'permissions') await chmod(directory, 0o755);
    else {
      for (const name of (await readdir(directory)).filter(name => name.startsWith('target.lock'))) {
        const path = join(directory, name);
        const lease: LeaseRecord = JSON.parse(await readFile(path, 'utf8'));
        lease.store = join(box.directory, 'missing-history');
        await writeFile(path, JSON.stringify(lease));
      }
    }
    assert.equal(run(box, 'apply', candidate, { CODEX_TEST_ALTERNATE_HOME: '1' }).exitCode, 4);
    assert.deepEqual(await readFile(candidate.targetPath), original);
    assert.deepEqual(await readdir(join(candidate.targetPath, '..')), ['browser-service.mjs']);
    await assert.rejects(access(join(box.directory, 'alternate-home/.codex-unfence')), { code: 'ENOENT' });
  }
});

test('managed writes warn about active applications and services, allow apply and restore, and require restart', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const rows = [
    { executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: 'ChatGPT' },
    { executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' },
    { executable: '/tmp/helpers/browser-service', command: 'browser-service' },
    { executable: '/usr/local/bin/node', command: 'node /tmp/scripts/browser-service.mjs' },
    { executable: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl', command: 'node_repl' },
    { executable: '/tmp/helpers/node_repl', command: '/tmp/helpers/node_repl' },
  ];
  for (const row of rows) {
    const env = { CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 12345, ...row }]) };
    const applied = run(box, 'apply', candidate, env);
    assert.equal(applied.exitCode, 0, JSON.stringify(applied));
    assert.equal(required(required(applied.data).targets[0]).action, 'applied');
    assert.ok(applied.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning' && entry.message.includes(row.executable)));
    assert.ok(applied.diagnostics.some(entry => entry.code === 'RESTART_REQUIRED' && /exit.*browser-service.*node_repl.*restart/.test(entry.message)));
    assert.notDeepEqual(await readFile(candidate.targetPath), original);
    const restored = run(box, 'restore', candidate, env);
    assert.equal(restored.exitCode, 0, JSON.stringify(restored));
    assert.equal(required(required(restored.data).targets[0]).action, 'restored');
    assert.ok(restored.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning'));
    assert.ok(restored.diagnostics.some(entry => entry.code === 'RESTART_REQUIRED'));
    assert.deepEqual(await readFile(candidate.targetPath), original);
  }
  const unrelated = run(box, 'apply', candidate, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 12345, executable: '/bin/zsh', command: 'zsh -c echo node_repl browser-service.mjs' }]) });
  assert.equal(unrelated.exitCode, 0, JSON.stringify(unrelated));
  assert.ok(!unrelated.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING'));
  assert.notDeepEqual(await readFile(candidate.targetPath), original);
});

test('managed recovery warns about active services while restoring the interrupted operation', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const interrupted = await pauseOperation(t, box, candidate, 'apply', 'after-target-rename');
  await interrupted.kill();
  const recovered = run(box, 'recover', candidate, {
    CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 12345, executable: '/tmp/helpers/node_repl', command: 'node_repl' }]),
  });
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.equal(required(required(recovered.data).targets[0]).action, 'rolled-back');
  assert.ok(recovered.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning'));
  assert.ok(recovered.diagnostics.some(entry => entry.code === 'RESTART_REQUIRED'));
  assert.deepEqual(await readFile(candidate.targetPath), original);
  assert.ok(!run(box, 'status', candidate).diagnostics.some(entry => ['PROCESSES_RUNNING', 'RESTART_REQUIRED'].includes(entry.code)));
});

test('managed writes still refuse failed process enumeration because concurrency locks require identities', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  for (const command of ['apply', 'restore']) {
    const rejected = run(box, command, candidate, { CODEX_TEST_PROCESS_FAILURE: '1' });
    assert.equal(rejected.exitCode, 1, JSON.stringify(rejected));
    assert.ok(rejected.diagnostics.some(entry => entry.code === 'PROCESS_ENUMERATION_FAILED' && entry.severity === 'error'));
    assert.deepEqual(await readFile(candidate.targetPath), original);
  }
  await assert.rejects(access(join(box.directory, 'home/Library')), { code: 'ENOENT' });
  const interrupted = await pauseOperation(t, box, candidate, 'apply', 'after-target-rename');
  await interrupted.kill();
  const beforeRecovery = await readFile(candidate.targetPath);
  const rejected = run(box, 'recover', candidate, { CODEX_TEST_PROCESS_FAILURE: '1' });
  assert.equal(rejected.exitCode, 1, JSON.stringify(rejected));
  assert.ok(rejected.diagnostics.some(entry => entry.code === 'PROCESS_ENUMERATION_FAILED' && entry.severity === 'error'));
  assert.deepEqual(await readFile(candidate.targetPath), beforeRecovery);
  assert.equal(run(box, 'inspect', candidate).state, 'incomplete');
});

test('read-only inspection reports unwritable target parents without creating state', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const parent = join(candidate.targetPath, '..');
  await chmod(parent, 0o500);
  try {
    const inspection = run(box, 'inspect', candidate);
    assert.equal(inspection.support, 'supported');
    assert.equal(inspection.writeReadiness, 'blocked');
    assert.deepEqual(inspection.allowedActions, []);
    assert.ok(inspection.blockers.some(entry => entry.code === 'TARGET_NOT_WRITABLE'));
    assert.deepEqual(await readFile(candidate.targetPath), original);
    await assert.rejects(access(join(box.directory, 'home/Library')), { code: 'ENOENT' });
  } finally { await chmod(parent, 0o700); }
});

test('managed recover can itself be interrupted and restore recovery returns the pre-restore applied state', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const patched = await readFile(candidate.targetPath);
  const restore = await pauseOperation(t, box, candidate, 'restore', 'after-target-rename');
  await restore.kill();
  assert.deepEqual(await readFile(candidate.targetPath), original);
  assert.equal(run(box, 'inspect', candidate).state, 'incomplete');
  const recovery = await pauseOperation(t, box, candidate, 'recover', 'after-rollback-intent');
  await recovery.kill();
  assert.equal(run(box, 'inspect', candidate).state, 'incomplete');
  const recovered = run(box, 'recover', candidate);
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.equal(required(required(recovered.data).targets[0]).state, 'tool-applied');
  assert.deepEqual(await readFile(candidate.targetPath), patched);
  assert.equal(required(required(run(box, 'restore', candidate).data).targets[0]).action, 'restored');
  assert.deepEqual(await readFile(candidate.targetPath), original);
});

test('a patched target with its operation store missing is a conflict and cannot acquire fresh provenance', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const trusted = run(box, 'inspect', candidate);
  const patched = await readFile(candidate.targetPath);
  await rm(required(trusted.recovery).store, { recursive: true });
  const missing = run(box, 'inspect', candidate);
  assert.equal(missing.state, 'conflict');
  assert.deepEqual(missing.allowedActions, []);
  assert.notEqual(run(box, 'apply', candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), patched);
});

test('managed discovery rejects permissive state, unsigned locator changes and store migration', async (t: TestContext) => {
  for (const mutation of ['permissions', 'locator', 'store-alias', 'external-update']) {
    const box = await sandbox(t);
    const { candidate } = await supportedInstallation(box);
    assert.equal(run(box, 'apply', candidate).exitCode, 0);
    const trusted = run(box, 'inspect', candidate);
    const patched = await readFile(candidate.targetPath);
    if (mutation === 'permissions') await chmod(required(trusted.recovery).preparation, 0o755);
    else if (mutation === 'locator') {
      const root = join(required(trusted.recovery).preparation, '../..');
      const [name] = await readdir(join(root, 'targets'));
      const path = join(root, 'targets', required(name));
      const envelope: {record: {store: string}} = JSON.parse(await readFile(path, 'utf8'));
      envelope.record.store += '-moved';
      await writeFile(path, JSON.stringify(envelope));
    } else if (mutation === 'store-alias') {
      const moved = required(trusted.recovery).store + '-moved';
      const { rename } = await import('node:fs/promises');
      await rename(required(trusted.recovery).store, moved);
      await symlink(moved, required(trusted.recovery).store);
    } else await writeFile(candidate.targetPath, '// external update\n');
    const inspection = run(box, 'inspect', candidate);
    assert.equal(inspection.state, 'conflict', mutation);
    assert.deepEqual(inspection.allowedActions, [], mutation);
    assert.notEqual(run(box, 'restore', candidate).exitCode, 0, mutation);
    assert.deepEqual(await readFile(candidate.targetPath), mutation === 'external-update' ? Buffer.from('// external update\n') : patched);
  }
});

test('apply refuses a locator published after confirmation instead of adopting a new managed selection', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  assert.equal(run(box, 'restore', candidate).exitCode, 0);
  const trusted = run(box, 'inspect', candidate);
  const root = join(required(trusted.recovery).preparation, '../..');
  const [name] = await readdir(join(root, 'targets'));
  const locator = join(root, 'targets', required(name));
  const copy = join(box.directory, 'saved-locator.json');
  await writeFile(copy, await readFile(locator), { mode: 0o600 });
  await rm(locator);
  const refused = run(box, 'apply', candidate, { CODEX_TEST_FAULT: 'managed-locator-change', CODEX_TEST_TARGET: candidate.targetPath, CODEX_TEST_LOCATOR: locator, CODEX_TEST_LOCATOR_COPY: copy });
  assert.equal(refused.exitCode, 4);
  assert.ok(refused.diagnostics.some(entry => entry.code === 'INSPECTION_CHANGED'));
  assert.deepEqual(await readFile(candidate.targetPath), original);
});

test('source alone confirms the complete installed patch without authorizing restore or duplicate installation', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const untracked = { ...await installation(box, 'Untracked', 'other'), version: 'other', build: '999' };
  const patched = await readFile(candidate.targetPath);
  await writeFile(untracked.targetPath, patched);
  const inspection = run(box, 'inspect', untracked);
  assert.equal(inspection.support, 'supported');
  assert.equal(inspection.state, 'tool-applied');
  assert.equal(inspection.sourcePatch?.status, 'detected');
  assert.equal(inspection.recovery, null);
  assert.deepEqual(inspection.allowedActions, []);
  assert.ok(inspection.diagnostics.some(entry => entry.code === 'RECOVERY_UNAVAILABLE'));
  const status = run(box, 'status', untracked);
  assert.equal(status.exitCode, 0);
  assert.equal(status.data?.targets[0]?.state, 'tool-applied');
  assert.notEqual(run(box, 'apply', untracked).exitCode, 0);
  assert.notEqual(run(box, 'restore', untracked).exitCode, 0);
  assert.deepEqual(await readFile(untracked.targetPath), patched);
});

test('inspection reports read-only operation stores before restore without changing recovery artifacts', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const trusted = run(box, 'inspect', candidate);
  const root = required(trusted.recovery).store;
  const files = await readdir(root);
  const patched = await readFile(candidate.targetPath);
  await chmod(root, 0o500);
  try {
    const inspection = run(box, 'inspect', candidate);
    assert.equal(inspection.support, 'supported');
    assert.equal(inspection.writeReadiness, 'blocked');
    assert.deepEqual(inspection.allowedActions, []);
    assert.ok(inspection.blockers.some(entry => entry.code === 'STORE_NOT_WRITABLE'));
    assert.deepEqual(await readdir(root), files);
    assert.deepEqual(await readFile(candidate.targetPath), patched);
  } finally { await chmod(root, 0o700); }
});

test('a locator with a missing preparation directory is a blocked conflict rather than an undiscovered patch', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const inspection = run(box, 'inspect', candidate);
  const patched = await readFile(candidate.targetPath);
  await rm(join(required(inspection.recovery).preparation, '..'), { recursive: true });
  const missing = run(box, 'inspect', candidate);
  assert.equal(missing.state, 'conflict');
  assert.equal(missing.sourcePatch?.status, 'detected');
  assert.equal(missing.writeReadiness, 'blocked');
  assert.deepEqual(missing.allowedActions, []);
  assert.deepEqual(await readFile(candidate.targetPath), patched);
});

test('inspection surfaces damaged preparation as conflict and refuses every write without trusting its locator', async (t: TestContext) => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const trusted = run(box, 'inspect', candidate);
  const patched = await readFile(candidate.targetPath);
  await writeFile(join(required(trusted.recovery).preparation, 'source.original.mjs'), '// externally replaced original\n');
  const conflict = run(box, 'inspect', candidate);
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.writeReadiness, 'blocked');
  assert.equal(conflict.inspectionToken, null);
  assert.ok(conflict.diagnostics.length > 0);
  for (const command of ['apply', 'restore', 'recover']) assert.notEqual(run(box, command, candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), patched);
});
