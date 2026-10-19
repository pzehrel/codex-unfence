import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli, startCli } from './helpers/cli.mjs';
import { once } from 'node:events';
import { setTimeout } from 'node:timers';
import { transformRequestTransport } from '../scripts/cua-request-wrapper.mjs';

const binary = fileURLToPath(new URL('../scripts/cua-wrapper-operations.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/cua-boundaries.cjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = '44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e';
const patchedHash = '705bfdb0d8e1793a5c3760a97d9c3eaf2bf6959cc5cbbfe31914bb24cbcf1940';
const prefix = 'async function transport(R,u,o) { return ';
const expression = 'await R.fetch(u,o)';
// Exact pinned byte size and UTF-16 range. Entirely self-authored, never evaluated.
const source = prefix + ' '.repeat(1084567 - prefix.length) + expression + '; }';
const original = Buffer.from(source.padEnd(1938669, ' '));
const transformed = transformRequestTransport(original.toString(), { start: 1084567, end: 1084585, expected: original.toString().slice(1084567, 1084585) });
const patched = Buffer.from(transformed.source);
const diff = `Mechanical expression replacement; UTF-16 [1084567,1084585)\n--- source.original.mjs\n+++ source.patched.mjs\n-${original.toString().slice(1084567,1084585)}\n+${transformed.replacement}\n`;

async function sandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cua-operations-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'Synthetic.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  const preparation = join(directory, 'prepared');
  await mkdir(join(target, '..'), { recursive: true });
  await mkdir(preparation, { mode: 0o700 });
  await writeFile(target, original, { mode: 0o644 });
  const manifest = {
    kind: 'cua-request-wrapper-local-preparation',
    profile: { id: 'cua-request-wrapper-26.1013.40934-build20770', appVersion: '26.1013.40934', build: '20770', pluginVersion: '0.1.1' },
    assessment: 'version-scoped-reviewed-pattern', operation: 'mechanical-edit', runtime: 'not-verified',
    origin: { requestedPath: '/untrusted/origin/never-write.mjs', realPath: '/untrusted/origin/never-write.mjs' },
    original: { file: 'source.original.mjs', size: original.length, sha256: originalHash },
    patched: { file: 'source.patched.mjs', size: patched.length, sha256: patchedHash },
    range: transformed.range,
    patchedRange: { start: 1084567, end: 1084567 + transformed.replacement.length, unit: 'utf16' },
    scope: 'reviewed dedicated site-status transport; original fetch guard, member call and consumer retained',
    jsonPolicy: 'Object.prototype/null records with own enumerable string data properties; own feature_status.agent strictly true only',
    outsideRange: 'byte-identical', syntax: 'parsed-before-and-after',
  };
  for (const [name, bytes] of [['source.original.mjs', original], ['source.patched.mjs', patched], ['local-diff.txt', diff], ['manifest.json', JSON.stringify(manifest)]]) {
    await writeFile(join(preparation, name), bytes, { mode: 0o600 });
  }
  return { directory, target, preparation, store: join(directory, 'operations'), env: { CODEX_TEST_CUA_ORIGINAL: hash(original), CODEX_TEST_CUA_PATCHED: hash(patched) } };
}
function run(box, command, env = {}, extra = []) {
  return runCli([command, ...(command === 'recover' ? [] : ['--preparation', box.preparation, '--target', box.target]), '--store', box.store, '--json', ...extra], { binary, fixture, directory: box.directory, env: { ...box.env, ...env } });
}
function response(result, expected = 0) {
  assert.equal(result.status, expected, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exitCode, expected);
  return parsed;
}

test('public CUA CLI applies a pinned preparation and restores exact original bytes with trusted status', async t => {
  const box = await sandbox(t);
  assert.equal(response(run(box, 'status')).data.targets[0].state, 'original');
  const applied = response(run(box, 'apply'));
  assert.equal(applied.data.targets[0].action, 'applied');
  assert.equal(applied.data.runtime, 'not-verified');
  assert.deepEqual(await readFile(box.target), patched);
  assert.equal((await stat(box.target)).mode & 0o7777, 0o644);
  assert.equal(response(run(box, 'status')).data.targets[0].state, 'tool-applied');
  assert.equal(response(run(box, 'restore')).data.targets[0].action, 'restored');
  assert.deepEqual(await readFile(box.target), original);
  assert.equal(response(run(box, 'status')).data.targets[0].state, 'original');
});

test('CUA history refuses an externally replaced original inode even with exact pinned bytes', async t => {
  const box = await sandbox(t);
  response(run(box, 'apply'));
  response(run(box, 'restore'));
  const replacement = box.target + '.external';
  await writeFile(replacement, original, { mode: 0o644 });
  await rename(replacement, box.target);
  const rejected = response(run(box, 'apply'), 4);
  assert.equal(rejected.diagnostics[0].code, 'TARGET_CONFLICT');
  assert.deepEqual(await readFile(box.target), original);
});

async function paused(t, box, command, boundary) {
  const args = [command, ...(command === 'recover' ? [] : ['--preparation', box.preparation, '--target', box.target]), '--store', box.store, '--json'];
  const child = startCli(args, { directory: box.directory, binary, fixture, env: { ...box.env, CODEX_TEST_PAUSE: boundary, CODEX_TEST_TARGET: box.target }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message.boundary, boundary)),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`CLI exited before ${boundary}: ${code}/${signal} ${stdout} ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`No boundary ${boundary}: ${stdout} ${stderr}`)), 10000); timer.unref(); }),
  ]);
  return {
    async kill() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; },
    async finish() { const exited = once(child, 'exit'); child.send('continue'); const [code] = await exited; return { status: code, stdout, stderr }; },
  };
}

test('CUA operations reject artifact/identity tampering and do not relax pins for synthetic files', async t => {
  for (const mutation of ['original', 'patched', 'diff', 'profile', 'origin-selection', 'duplicate', 'unpinned']) {
    const box = await sandbox(t);
    if (mutation === 'original') await writeFile(join(box.preparation, 'source.original.mjs'), Buffer.alloc(1938669, 32));
    if (mutation === 'patched') await writeFile(join(box.preparation, 'source.patched.mjs'), Buffer.from(patched).fill(32, 1084567, 1084585));
    if (mutation === 'diff') await writeFile(join(box.preparation, 'local-diff.txt'), 'edited local diff');
    if (mutation === 'profile' || mutation === 'origin-selection') {
      const path = join(box.preparation, 'manifest.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (mutation === 'profile') manifest.profile.build = 'other';
      else manifest.target = { path: box.target };
      await writeFile(path, JSON.stringify(manifest));
    }
    if (mutation === 'duplicate') {
      const path = join(box.preparation, 'manifest.json');
      await writeFile(path, (await readFile(path, 'utf8')).replace('{', '{"kind":"duplicate",'));
    }
    const rejected = run(box, 'apply', mutation === 'unpinned' ? { CODEX_TEST_CUA_ORIGINAL: '', CODEX_TEST_CUA_PATCHED: '' } : {});
    assert.notEqual(rejected.status, 0, mutation);
    assert.deepEqual(await readFile(box.target), original, mutation);
    await assert.rejects(access(box.store), { code: 'ENOENT' });
  }
});

test('CUA writes reject process failure, actual standalone node_repl and host blockers without terminating them', async t => {
  const box = await sandbox(t);
  const failure = response(run(box, 'apply', { CODEX_TEST_PROCESS_FAILURE: '1' }), 1);
  assert.equal(failure.diagnostics[0].code, 'PROCESS_ENUMERATION_FAILED');
  for (const executable of ['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl', '/tmp/helpers/node_repl', '/usr/local/bin/browser-service']) {
    const rejected = response(run(box, 'apply', { CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 12345, executable, command: executable }]) }), 4);
    assert.equal(rejected.diagnostics[0].code, 'PROCESSES_RUNNING');
  }
  // Merely mentioning helper names in unrelated shell text does not identify a helper.
  response(run(box, 'apply', { CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 12345, executable: '/bin/zsh', command: 'zsh -c echo node_repl browser-service.mjs' }]) }));
  assert.deepEqual(await readFile(box.target), patched);
});

test('CUA CLI refuses aliases, external contents, permissive artifacts and implicit/override selection', async t => {
  for (const kind of ['symlink', 'hardlink', 'preparation-alias', 'mode', 'external', 'untrusted-patched']) {
    const box = await sandbox(t);
    if (kind === 'symlink' || kind === 'hardlink') {
      const alias = box.target + '.alias';
      if (kind === 'symlink') await symlink(box.target, alias); else await link(box.target, alias);
      box.target = alias;
    }
    if (kind === 'preparation-alias') { const alias = box.preparation + '.alias'; await symlink(box.preparation, alias); box.preparation = alias; }
    if (kind === 'mode') await chmod(join(box.preparation, 'source.original.mjs'), 0o644);
    if (kind === 'external') await writeFile(box.target, 'external upgrade');
    if (kind === 'untrusted-patched') await writeFile(box.target, patched);
    const before = await readFile(box.target);
    response(run(box, 'apply'), 4);
    assert.deepEqual(await readFile(box.target), before);
    await assert.rejects(access(box.store), { code: 'ENOENT' });
  }
  const box = await sandbox(t);
  for (const extra of [['--force'], ['--profile', 'unknown'], ['--skip-process-check'], ['--target', box.target]]) response(run(box, 'apply', {}, extra), 2);
  for (const args of [['apply', '--store', box.store], ['restore'], ['recover', '--store', box.store, '--target', box.target]]) {
    response(runCli([...args, '--json'], { binary, fixture, directory: box.directory, env: box.env }), 2);
  }
});

test('CUA idempotence requires trusted history and restore verifies private backups', async t => {
  const box = await sandbox(t);
  assert.equal(response(run(box, 'restore')).data.targets[0].action, 'already-original');
  const applied = response(run(box, 'apply'));
  const inode = (await stat(box.target)).ino;
  assert.equal(response(run(box, 'apply')).data.targets[0].action, 'already-applied');
  assert.equal((await stat(box.target)).ino, inode);
  response(run({ ...box, store: join(box.directory, 'other-store') }, 'restore'), 4);
  const backup = join(box.store, 'transactions', applied.data.transaction, 'before.mjs');
  await writeFile(backup, 'changed private backup');
  assert.equal(response(run(box, 'restore'), 4).diagnostics[0].code, 'BACKUP_CHANGED');
  assert.deepEqual(await readFile(box.target), patched);
});

test('CUA durable backup precedes target rename, cross-store concurrency blocks, and interrupted apply/restore recover before state', async t => {
  for (const command of ['apply', 'restore']) {
    const box = await sandbox(t);
    if (command === 'restore') response(run(box, 'apply'));
    const before = await readFile(box.target);
    const operation = await paused(t, box, command, 'before-target-rename');
    const pending = response(run(box, 'status'));
    assert.equal(pending.data.groupState, 'incomplete');
    assert.equal(pending.data.operation, command);
    const transaction = pending.data.transaction;
    const directory = join(box.store, 'transactions', transaction);
    assert.deepEqual(await readFile(join(directory, 'before.mjs')), before);
    assert.deepEqual(await readFile(box.target), before);
    const journal = JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8'));
    assert.equal(journal.record.scheme, 'cua-request-wrapper-26.1013.40934-build20770');
    assert.equal(journal.record.phase, 'writing');
    response(run({ ...box, store: join(box.directory, 'other-store') }, 'apply'), 4);
    response(await operation.finish());
    const interrupted = await paused(t, box, command === 'apply' ? 'restore' : 'apply', 'after-target-rename');
    await interrupted.kill();
    assert.equal(response(run(box, 'status')).data.groupState, 'incomplete');
    // Ordinary legacy recovery cannot reinterpret CUA journals or load its adapter.
    const legacy = runCli(['recover', '--store', box.store, '--json'], { directory: box.directory, fixture, env: box.env });
    assert.equal(response(legacy, 4).diagnostics[0].code, 'SCHEME_MISMATCH');
    await rename(box.preparation, box.preparation + '.removed');
    response(run(box, 'recover'));
    assert.deepEqual(await readFile(box.target), command === 'apply' ? patched : original);
    response(run(box, 'recover'));
  }
});
