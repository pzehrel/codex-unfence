import assert from 'node:assert/strict';
import { access, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli, startCli } from './helpers/cli.mjs';
import { once } from 'node:events';
import { setTimeout } from 'node:timers';

const binary = fileURLToPath(new URL('./fixtures/managed-patches-driver.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));
const service = 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs';
async function sandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'managed-patches-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'home/Applications'), { recursive: true });
  return { directory };
}
async function installation(box, name, version) {
  const appPath = join(box.directory, 'home/Applications', name + '.app');
  const targetPath = join(appPath, service);
  await mkdir(join(targetPath, '..'), { recursive: true });
  await writeFile(targetPath, '// synthetic, never evaluated\n');
  await writeFile(join(appPath, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>999</string></dict></plist>`);
  return { appPath, targetPath };
}
function run(box, command, payload = {}, env = {}) {
  const result = runCli([command, JSON.stringify(payload)], { binary, fixture, directory: box.directory, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('discovery returns every CUA installation without selecting by version and changes no files', async t => {
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

test('explicit discovery reports missing installations and refuses symlink or hardlink aliases', async t => {
  const box = await sandbox(t);
  assert.equal(run(box, 'discover').selection, 'none');
  assert.equal(run(box, 'discover', { appPath: join(box.directory, 'missing.app') }).diagnostics[0].code, 'ENOENT');
  const selected = await installation(box, 'Selected', 'unlisted-version');
  assert.equal(run(box, 'discover', { appPath: selected.appPath }).candidates[0].version, 'unlisted-version');
  const alias = join(box.directory, 'Alias.app');
  await symlink(selected.appPath, alias);
  assert.equal(run(box, 'discover', { appPath: alias }).diagnostics[0].code, 'PATH_ALIAS');
  await link(selected.targetPath, selected.targetPath + '.alias');
  assert.equal(run(box, 'discover', { appPath: selected.appPath }).diagnostics[0].code, 'PATH_ALIAS');
  assert.deepEqual((await readdir(join(box.directory, 'home'))).sort(), ['Applications']);
});

test('default discovery ignores ordinary app aliases that have no CUA service', async t => {
  const box = await sandbox(t);
  const ordinary = join(box.directory, 'ordinary.app');
  await mkdir(ordinary);
  await symlink(ordinary, join(box.directory, 'home/Applications/Ordinary.app'));
  const report = run(box, 'discover');
  assert.equal(report.selection, 'none');
  assert.deepEqual(report.diagnostics, []);
});

test('inspection reports unsupported code separately from process blockers and creates no recovery state', async t => {
  const box = await sandbox(t);
  const candidate = { ...await installation(box, 'Inspect', 'anything'), version: null, build: null };
  const original = await readFile(candidate.targetPath);
  const inspection = run(box, 'inspect', candidate, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 987654, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }]) });
  assert.equal(inspection.support, 'unsupported');
  assert.equal(inspection.writeReadiness, 'blocked');
  assert.equal(inspection.state, 'incompatible');
  assert.equal(inspection.blockers[0].code, 'PROCESSES_RUNNING');
  assert.ok(inspection.diagnostics.length > 0);
  assert.equal(inspection.runtime, 'not-verified');
  assert.equal(typeof inspection.inspectionToken, 'string');
  assert.deepEqual(await readFile(candidate.targetPath), original);
  assert.deepEqual((await readdir(join(box.directory, 'home'))).sort(), ['Applications']);
});

async function supportedInstallation(box) {
  const candidate = { ...await installation(box, 'Supported', 'unlisted-42'), version: 'unlisted-42', build: '999' };
  const original = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(candidate.targetPath, original, { mode: 0o644 });
  return { candidate, original };
}

test('managed operations persist private recovery state and restore original bytes after repeated application', async t => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const inspection = run(box, 'inspect', candidate);
  assert.equal(inspection.support, 'supported');
  assert.equal(inspection.state, 'original');
  assert.equal(inspection.writeReadiness, 'ready');
  await assert.rejects(access(join(box.directory, 'home/Library')), { code: 'ENOENT' });
  const applied = run(box, 'apply', candidate);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied));
  assert.equal(applied.data.targets[0].action, 'applied');
  const patched = await readFile(candidate.targetPath);
  assert.notDeepEqual(patched, original);
  const after = run(box, 'inspect', candidate);
  assert.equal(after.state, 'tool-applied');
  assert.equal(after.support, 'supported');
  assert.equal(after.recovery.tool.version, '9.8.7-synthetic');
  assert.equal(after.recovery.command, 'npx --package codex-browser-liberation-patch@9.8.7-synthetic codex-browser-patch');
  assert.equal(run(box, 'apply', candidate).data.targets[0].action, 'already-applied');
  assert.deepEqual(await readFile(candidate.targetPath), patched);
  assert.equal(run(box, 'restore', candidate).data.targets[0].action, 'restored');
  assert.deepEqual(await readFile(candidate.targetPath), original);
  const restored = run(box, 'status', candidate);
  assert.equal(restored.data.targets[0].state, 'original');
  assert.equal(restored.data.targets[0].action, 'restored');
  assert.equal(run(box, 'restore', candidate).data.targets[0].action, 'already-original');
  assert.equal((await stat(after.recovery.preparation)).mode & 0o777, 0o700);
  assert.equal((await stat(join(after.recovery.preparation, 'source.original.mjs'))).mode & 0o777, 0o600);
  assert.equal((await stat(after.recovery.store)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(candidate.targetPath, '..')), ['browser-service.mjs']);
});

test('apply rejects a supported original changed after confirmation token validation', async t => {
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

async function pauseOperation(t, box, candidate, command, boundary) {
  const child = startCli([command, JSON.stringify(candidate)], { directory: box.directory, binary, fixture, env: { CODEX_TEST_PAUSE: boundary, CODEX_TEST_TARGET: candidate.targetPath }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message.boundary, boundary)),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`Driver exited before ${boundary}: ${code}/${signal} ${stdout} ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`No boundary ${boundary}: ${stdout} ${stderr}`)), 15000); timer.unref(); }),
  ]);
  return { async kill() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } };
}

test('interrupted managed apply is discoverable and recover rolls back without continuing application', async t => {
  const box = await sandbox(t);
  const { candidate, original } = await supportedInstallation(box);
  const interrupted = await pauseOperation(t, box, candidate, 'apply', 'after-target-rename');
  const root = join(box.directory, 'home/Library/Application Support/codex-browser-liberation-patch');
  assert.equal((await readdir(join(root, 'targets'))).length, 1);
  await interrupted.kill();
  assert.notDeepEqual(await readFile(candidate.targetPath), original);
  const pending = run(box, 'inspect', candidate);
  assert.equal(pending.state, 'incomplete');
  assert.equal(pending.writeReadiness, 'blocked');
  assert.deepEqual(pending.allowedActions, ['recover']);
  const recovered = run(box, 'recover', candidate);
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered));
  assert.equal(recovered.data.targets[0].action, 'rolled-back');
  assert.deepEqual(await readFile(candidate.targetPath), original);
  assert.equal(run(box, 'status', candidate).data.targets[0].state, 'original');
  assert.deepEqual(await readdir(join(candidate.targetPath, '..')), ['browser-service.mjs']);
});

test('a locator with a missing preparation directory is a blocked conflict rather than an undiscovered patch', async t => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const inspection = run(box, 'inspect', candidate);
  const patched = await readFile(candidate.targetPath);
  await rm(join(inspection.recovery.preparation, '..'), { recursive: true });
  const missing = run(box, 'inspect', candidate);
  assert.equal(missing.state, 'conflict');
  assert.equal(missing.writeReadiness, 'blocked');
  assert.deepEqual(missing.allowedActions, []);
  assert.deepEqual(await readFile(candidate.targetPath), patched);
});

test('inspection surfaces damaged preparation as conflict and refuses every write without trusting its locator', async t => {
  const box = await sandbox(t);
  const { candidate } = await supportedInstallation(box);
  assert.equal(run(box, 'apply', candidate).exitCode, 0);
  const trusted = run(box, 'inspect', candidate);
  const patched = await readFile(candidate.targetPath);
  await writeFile(join(trusted.recovery.preparation, 'source.original.mjs'), '// externally replaced original\n');
  const conflict = run(box, 'inspect', candidate);
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.writeReadiness, 'blocked');
  assert.equal(conflict.inspectionToken, null);
  assert.ok(conflict.diagnostics.length > 0);
  for (const command of ['apply', 'restore', 'recover']) assert.notEqual(run(box, command, candidate).exitCode, 0);
  assert.deepEqual(await readFile(candidate.targetPath), patched);
});
