import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runCli, startCli } from './helpers/cli.mjs';
import { once } from 'node:events';
import { setTimeout } from 'node:timers';
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/transaction-boundaries.cjs', import.meta.url));
const source = await readFile(new URL('./fixtures/site-status.js.txt', import.meta.url), 'utf8');

async function sandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-transaction-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'plugins/browser/synthetic/scripts/browser-service.mjs');
  await mkdir(join(directory, 'home'));
  await mkdir(join(directory, 'plugins/browser/synthetic/scripts'), { recursive: true });
  await writeFile(target, source, { mode: 0o640 });
  const box = { directory, target, plan: join(directory, 'plan'), store: join(directory, 'store') };
  const prepared = run(box, ['prepare', '--plugin-root', join(directory, 'plugins'), '--target', target, '--output', box.plan]);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  return box;
}

async function replaceIdentity(box) {
  const bytes = await readFile(box.target);
  const before = await stat(box.target, { bigint: true });
  // Keep the old inode allocated so filesystems cannot reuse it for the replacement.
  await rename(box.target, join(box.directory, 'previous-target.mjs'));
  await writeFile(box.target, bytes, { mode: 0o640 });
  const after = await stat(box.target, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.notEqual(after.ino, before.ino, 'identity mutation must create a different inode');
}

async function groupSandbox(t) {
  const box = await sandbox(t);
  const targets = [box.target,
    join(box.directory, 'plugins/browser/version-two/scripts/browser-service.mjs'),
    join(box.directory, 'plugins/chrome/other/scripts/browser-service.mjs')];
  for (const path of targets.slice(1)) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, source, { mode: 0o640 });
  }
  const plan = join(box.directory, 'group-plan');
  response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), '--all-compatible', '--output', plan]));
  return { ...box, targets, singlePlan: box.plan, plan };
}

function run(box, args, extraEnv = {}) {
  return runCli([...args, '--json'], { directory: box.directory, fixture, env: extraEnv });
}

function response(result, expected = 0) {
  assert.equal(result.status, expected, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.exitCode, expected);
  assert.equal(output.schemaVersion, 1);
  return output;
}

const apply = (box, extra = {}) => run(box, ['apply', '--plan', box.plan, '--store', box.store], extra);
const restore = (box, extra = {}) => run(box, ['restore', '--plan', box.plan, '--store', box.store], extra);
const status = (box) => run(box, ['status', '--plan', box.plan, '--store', box.store]);
const recover = (box, extra = {}) => run(box, ['recover', '--store', box.store], extra);

async function paused(t, box, command, boundary, extraEnv = {}) {
  const args = command === 'recover' ? ['recover', '--store', box.store] : [command, '--plan', box.plan, '--store', box.store];
  const child = startCli([...args, '--json'], {
    directory: box.directory, fixture, env: { CODEX_TEST_PAUSE: boundary, CODEX_TEST_TARGET: box.target, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message.boundary, boundary)),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`CLI exited before ${boundary}: ${code}/${signal}: ${stdout} ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`No boundary ${boundary}: ${stdout} ${stderr}`)), 10_000); timer.unref(); }),
  ]);
  return {
    child,
    async kill() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; },
    async finish() { const exited = once(child, 'exit'); child.send('continue'); const [code] = await exited; return { status: code, stdout, stderr }; },
  };
}

test('single-target apply records tool provenance, preserves mode and supports explicit known-state idempotence', async (t) => {
  const box = await sandbox(t);
  const before = response(status(box));
  assert.equal(before.data.targets[0].state, 'original');
  assert.equal(before.data.runtime, 'not-verified');
  const applied = response(apply(box));
  assert.equal(applied.command, 'apply');
  assert.equal(applied.data.targets[0].state, 'tool-applied');
  assert.equal(applied.data.targets[0].action, 'applied');
  assert.equal(applied.data.runtime, 'not-verified');
  const patched = await readFile(box.target, 'utf8');
  assert.match(patched, /agent:false/);
  assert.equal((await stat(box.target)).mode & 0o7777, 0o640);
  const inode = (await stat(box.target)).ino;
  const repeated = response(apply(box));
  assert.equal(repeated.data.targets[0].action, 'already-applied');
  assert.equal((await stat(box.target)).ino, inode);
  assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
  const elsewhere = { ...box, store: join(box.directory, 'other-store') };
  const untrusted = response(apply(elsewhere), 4);
  assert.equal(untrusted.outcome, 'conflict');
  assert.equal(await readFile(box.target, 'utf8'), patched);
});

test('restore returns verified original bytes, preserves mode and supports round trips and original-state idempotence', async (t) => {
  const box = await sandbox(t);
  const initialInode = (await stat(box.target)).ino;
  const original = response(restore(box));
  assert.equal(original.command, 'restore');
  assert.equal(original.data.targets[0].action, 'already-original');
  assert.equal(original.data.targets[0].state, 'original');
  assert.equal((await stat(box.target)).ino, initialInode);
  const applied = response(apply(box));
  const patched = await readFile(box.target);
  const restored = response(restore(box));
  assert.notEqual(restored.data.transaction, applied.data.transaction);
  assert.equal(restored.data.targets[0].action, 'restored');
  assert.equal(restored.data.targets[0].state, 'original');
  assert.equal(restored.data.runtime, 'not-verified');
  assert.equal(await readFile(box.target, 'utf8'), source);
  assert.equal((await stat(box.target)).mode & 0o7777, 0o640);
  assert.equal(response(status(box)).data.targets[0].state, 'original');
  const restoredInode = (await stat(box.target)).ino;
  assert.equal(response(restore(box)).data.targets[0].action, 'already-original');
  assert.equal((await stat(box.target)).ino, restoredInode);
  response(apply(box));
  assert.deepEqual(await readFile(box.target), patched);
  assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
  assert.equal(response(apply(box)).data.targets[0].action, 'already-applied');
});

test('idempotent restore rechecks current original identity after durable intent publication', async (t) => {
  const box = await sandbox(t);
  const restoring = await paused(t, box, 'restore', 'after-intent-publication');
  await writeFile(box.target, 'external edit after original preflight');
  const failed = response(await restoring.finish(), 4);
  assert.equal(failed.diagnostics[0].code, 'TARGET_CHANGED');
  assert.equal(await readFile(box.target, 'utf8'), 'external edit after original preflight');
  assert.equal(response(status(box), 4).data.targets[0].state, 'conflict');
});

test('interrupted original-state restore recovers original and protects changes during no-replacement recovery', async (t) => {
  const box = await sandbox(t);
  const interrupted = await paused(t, box, 'restore', 'after-intent-publication');
  await interrupted.kill();
  assert.equal(response(status(box)).data.operation, 'restore');
  const recovered = response(recover(box));
  assert.equal(recovered.data.targets[0].state, 'original');
  assert.equal(await readFile(box.target, 'utf8'), source);
  const again = await paused(t, box, 'restore', 'after-intent-publication');
  await again.kill();
  const recovering = await paused(t, box, 'recover', 'after-rollback-intent');
  await writeFile(box.target, 'external change during no-replacement recovery');
  const rejected = response(await recovering.finish(), 4);
  assert.equal(rejected.diagnostics[0].code, 'TARGET_CHANGED');
  assert.equal(await readFile(box.target, 'utf8'), 'external change during no-replacement recovery');
  const state = response(status(box), 4);
  assert.equal(state.data.targets[0].state, 'conflict');
  assert.equal(state.data.operation, 'restore');
  response(recover(box), 4);
});

test('restore refuses untrusted patched contents without creating store or changing target', async (t) => {
  const box = await sandbox(t);
  const patched = await readFile(join(box.plan, 'contents/0000.patched.mjs'));
  await writeFile(box.target, patched);
  const unknown = response(restore(box), 4);
  assert.equal(unknown.diagnostics[0].code, 'TARGET_CONFLICT');
  assert.deepEqual(await readFile(box.target), patched);
  await assert.rejects(access(box.store));
  assert.equal(response(run(box, ['status', '--target', box.target, '--store', box.store]), 4).diagnostics[0].code, 'UNTRUSTED_PATCHED_SHAPE');
});

test('restore validates review and stored plans, backups and provenance before any target replacement', async (t) => {
  for (const mutation of ['original', 'patched', 'manifest', 'complete', 'backup', 'stored-plan', 'journal', 'key', 'missing-record', 'other-store']) {
    const box = await sandbox(t);
    const id = response(apply(box)).data.transaction;
    const directory = join(box.store, 'transactions', id);
    if (mutation === 'original' || mutation === 'patched') await writeFile(join(box.plan, 'contents', `0000.${mutation}.mjs`), 'tampered review artifact');
    if (mutation === 'manifest') {
      const path = join(box.plan, 'contents/manifest.json');
      const value = JSON.parse(await readFile(path, 'utf8'));
      value.targets[0].identity.version = 'elsewhere';
      await writeFile(path, JSON.stringify(value));
    }
    if (mutation === 'complete') await writeFile(join(box.plan, 'complete.json'), '{}');
    if (mutation === 'backup') await writeFile(join(directory, 'before.mjs'), 'damaged verified original');
    if (mutation === 'stored-plan') await writeFile(join(directory, 'plan/contents/0000.original.mjs'), 'damaged stored original');
    if (mutation === 'journal') {
      const path = join(directory, 'journal.json');
      const value = JSON.parse(await readFile(path, 'utf8'));
      value.record.operation = 'restore';
      await writeFile(path, JSON.stringify(value));
    }
    if (mutation === 'key') await writeFile(join(box.store, 'key'), Buffer.alloc(32));
    if (mutation === 'missing-record') await rm(directory, { recursive: true });
    const selected = mutation === 'other-store' ? { ...box, store: join(box.directory, 'other-store') } : box;
    const before = await readFile(box.target);
    const inode = (await stat(box.target)).ino;
    const rejected = response(restore(selected), 4);
    assert.equal(rejected.outcome, 'conflict', mutation);
    assert.deepEqual(await readFile(box.target), before, mutation);
    assert.equal((await stat(box.target)).ino, inode, mutation);
    if (mutation === 'other-store') await assert.rejects(access(selected.store));
  }
});

test('restore CLI requires explicit single-plan selection and explains restoration versus interrupted rollback', async (t) => {
  const box = await sandbox(t);
  for (const args of [
    ['restore'], ['restore', '--plan', box.plan], ['restore', '--store', box.store],
    ['restore', '--target', box.target, '--store', box.store],
    ['restore', '--plan', box.plan, '--store', box.store, '--all-compatible'],
    ['restore', '--plan', box.plan, '--store', box.store, '--plugin-root', join(box.directory, 'plugins')],
  ]) {
    const invalid = response(run(box, args), 2);
    assert.equal(invalid.command, 'restore');
    assert.equal(invalid.diagnostics[0].code, 'INVALID_ARGUMENTS');
  }
  const help = runCli(['restore', '--help'], { directory: box.directory, fixture });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /restore --plan <directory> --store <private-directory>/);
  assert.match(help.stdout, /restore returns a trusted target to verified original content/);
  assert.match(help.stdout, /never continues apply or restore/);
  const human = runCli(['restore', '--plan', box.plan, '--store', box.store], { directory: box.directory, fixture });
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /restore: success/);
  assert.match(human.stdout, /original \(already-original\)/);
  assert.match(human.stdout, /Runtime: not-verified/);
});

test('restore preserves external content, filesystem identity changes and aliases detected during preflight', async (t) => {
  for (const mutation of ['external', 'upgrade', 'identity', 'mode', 'symlink', 'hardlink']) {
    const box = await sandbox(t);
    response(apply(box));
    if (mutation === 'external') await writeFile(box.target, 'user edited after apply');
    if (mutation === 'upgrade') await writeFile(box.target, source + '// new plugin build');
    if (mutation === 'identity') await replaceIdentity(box);
    if (mutation === 'mode') await chmod(box.target, 0o600);
    if (mutation === 'symlink') {
      const bytes = await readFile(box.target);
      const outside = join(box.directory, 'outside.mjs');
      await writeFile(outside, bytes); await rm(box.target); await symlink(outside, box.target);
    }
    if (mutation === 'hardlink') await link(box.target, join(box.directory, 'alias.mjs'));
    const before = await readFile(box.target);
    const identity = await stat(box.target);
    response(restore(box), 4);
    assert.deepEqual(await readFile(box.target), before, mutation);
    assert.equal((await stat(box.target)).ino, identity.ino, mutation);
    assert.equal((await stat(box.target)).mode, identity.mode, mutation);
  }
});

test('process enumeration fails closed; actual ChatGPT/Codex and standalone browser-service block writes', async (t) => {
  const box = await sandbox(t);
  const blockers = [
    { pid: 4001, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 4002, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: '/Applications/Codex.app/Contents/MacOS/Codex' },
    { pid: 4003, executable: '/usr/local/bin/node', command: '/usr/local/bin/node /tmp/plugin/scripts/browser-service.mjs --stdio' },
    { pid: 4004, executable: '/tmp/browser-service', command: '/tmp/browser-service' },
  ];
  for (const row of blockers) {
    const output = response(apply(box, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([row]) }), 4);
    assert.equal(output.diagnostics[0].code, 'PROCESSES_RUNNING');
    assert.match(output.diagnostics[0].message, new RegExp(String(row.pid)));
    assert.equal(await readFile(box.target, 'utf8'), source);
    await assert.rejects(access(box.store));
  }
  const unavailable = response(apply(box, { CODEX_TEST_PROCESS_FAILURE: '1' }), 1);
  assert.equal(unavailable.diagnostics[0].code, 'PROCESS_ENUMERATION_FAILED');
  const harmless = [
    { pid: 4010, executable: '/bin/zsh', command: 'zsh -c echo /Applications/Codex.app/Contents/MacOS/Codex browser-service.mjs' },
    { pid: 4011, executable: '/usr/local/bin/node', command: 'node --test /tmp/tests/Codex-process.test.mjs' },
  ];
  response(apply(box, { CODEX_TEST_PROCESS_ROWS: JSON.stringify(harmless) }));
});

test('restore refuses running processes and failed enumeration before locks or target writes', async (t) => {
  const box = await sandbox(t);
  response(apply(box));
  const patched = await readFile(box.target);
  const inode = (await stat(box.target)).ino;
  const blockers = [
    { pid: 4201, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: 'ChatGPT' },
    { pid: 4202, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' },
    { pid: 4203, executable: '/usr/local/bin/node', command: 'node /tmp/synthetic/browser-service.mjs --stdio' },
  ];
  for (const row of blockers) {
    const blocked = response(restore(box, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([row]) }), 4);
    assert.equal(blocked.diagnostics[0].code, 'PROCESSES_RUNNING');
    assert.match(blocked.diagnostics[0].message, new RegExp(String(row.pid)));
  }
  assert.equal(response(restore(box, { CODEX_TEST_PROCESS_FAILURE: '1' }), 1).diagnostics[0].code, 'PROCESS_ENUMERATION_FAILED');
  assert.deepEqual(await readFile(box.target), patched);
  assert.equal((await stat(box.target)).ino, inode);
  assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
  response(restore(box));
});

test('apply preflights current identity and every plan artifact before target or store writes', async (t) => {
  for (const mutation of ['source', 'inode', 'original', 'patched', 'manifest', 'symlink', 'hardlink']) {
    const box = await sandbox(t);
    if (mutation === 'source') await writeFile(box.target, source + '// external change');
    if (mutation === 'inode') await replaceIdentity(box);
    if (mutation === 'original' || mutation === 'patched') await writeFile(join(box.plan, 'contents', `0000.${mutation}.mjs`), 'tampered');
    if (mutation === 'manifest') {
      const path = join(box.plan, 'contents/manifest.json');
      const value = JSON.parse(await readFile(path, 'utf8'));
      value.targets[0].identity.version = 'elsewhere';
      await writeFile(path, JSON.stringify(value));
    }
    if (mutation === 'symlink') {
      const bytes = await readFile(box.target);
      const outside = join(box.directory, 'outside.mjs');
      await writeFile(outside, bytes); await rm(box.target); await symlink(outside, box.target);
    }
    if (mutation === 'hardlink') await link(box.target, join(box.directory, 'alias.mjs'));
    const before = await readFile(box.target);
    const result = apply(box);
    assert.ok(result.status === 4 || result.status === 1, `${mutation}: ${result.stdout}`);
    assert.deepEqual(await readFile(box.target), before);
    await assert.rejects(access(box.store));
  }
});

test('selected browser/chrome versions apply and restore together while leaving unselected versions unchanged', async (t) => {
  const box = await sandbox(t);
  const second = join(box.directory, 'plugins/chrome/other/scripts/browser-service.mjs');
  const unselected = join(box.directory, 'plugins/browser/unselected/scripts/browser-service.mjs');
  for (const path of [second, unselected]) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, source, { mode: 0o640 });
  }
  const plan = join(box.directory, 'selected');
  response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), '--target', second, '--target', box.target, '--output', plan]));
  const selected = { ...box, plan };
  const applied = response(apply(selected));
  assert.deepEqual(applied.data.targets.map(({ path, action }) => ({ path, action })), [
    { path: second, action: 'applied' }, { path: box.target, action: 'applied' },
  ]);
  for (const path of [box.target, second]) {
    assert.match(await readFile(path, 'utf8'), /agent:false/);
    assert.equal((await stat(path)).mode & 0o7777, 0o640);
  }
  assert.equal(await readFile(unselected, 'utf8'), source);
  assert.deepEqual(response(status(selected)).data.targets.map((target) => target.state), ['tool-applied', 'tool-applied']);
  assert.deepEqual(response(apply(selected)).data.targets.map((target) => target.action), ['already-applied', 'already-applied']);
  assert.deepEqual(response(restore(selected)).data.targets.map((target) => target.action), ['restored', 'restored']);
  assert.deepEqual(response(restore(selected)).data.targets.map((target) => target.action), ['already-original', 'already-original']);
  for (const path of [box.target, second, unselected]) assert.equal(await readFile(path, 'utf8'), source);
});

test('mixed states retain each target provenance across single and group plans without replacing no-op entries', async (t) => {
  const box = await sandbox(t);
  const second = join(box.directory, 'plugins/chrome/other/scripts/browser-service.mjs');
  await mkdir(join(second, '..'), { recursive: true });
  await writeFile(second, source, { mode: 0o600 });
  const plan = join(box.directory, 'multi');
  response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), '--all-compatible', '--output', plan]));
  response(apply(box));
  const inode = (await stat(box.target)).ino;
  const group = { ...box, plan };
  assert.deepEqual(response(status(group)).data.targets.map((target) => target.state), ['tool-applied', 'original']);
  const applied = response(apply(group));
  assert.deepEqual(applied.data.targets.map((target) => target.action), ['already-applied', 'applied']);
  assert.equal((await stat(box.target)).ino, inode);
  response(restore(box));
  const originalInode = (await stat(box.target)).ino;
  const restored = response(restore(group));
  assert.deepEqual(restored.data.targets.map((target) => target.action), ['already-original', 'restored']);
  assert.equal((await stat(box.target)).ino, originalInode);
  assert.equal((await stat(second)).mode & 0o7777, 0o600);
  assert.equal(await readFile(second, 'utf8'), source);
  assert.equal(response(status(box)).data.targets[0].state, 'original');
});

test('every selected target, artifact and backup is preflighted before the group writes any target', async (t) => {
  for (const mutation of ['external', 'artifact', 'backup', 'untrusted-patch', 'process']) {
    const box = await groupSandbox(t);
    if (mutation === 'external') await writeFile(box.targets[1], 'external second target');
    if (mutation === 'artifact') await writeFile(join(box.plan, 'contents/0001.patched.mjs'), 'changed second artifact');
    if (mutation === 'untrusted-patch') await writeFile(box.targets[1], await readFile(join(box.plan, 'contents/0001.patched.mjs')));
    let operation = apply;
    if (mutation === 'backup') {
      const applied = response(apply(box));
      await writeFile(join(box.store, 'transactions', applied.data.transaction, 'before.0001.mjs'), 'changed second backup');
      operation = restore;
    }
    const bytes = await Promise.all(box.targets.map((path) => readFile(path)));
    const inodes = await Promise.all(box.targets.map(async (path) => (await stat(path)).ino));
    const row = { pid: 4301, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' };
    const output = response(operation(box, mutation === 'process' ? { CODEX_TEST_PROCESS_ROWS: JSON.stringify([row]) } : {}), 4);
    assert.equal(output.outcome, 'conflict');
    for (const [index, path] of box.targets.entries()) {
      assert.deepEqual(await readFile(path), bytes[index], mutation);
      assert.equal((await stat(path)).ino, inodes[index], mutation);
    }
    if (mutation !== 'backup') await assert.rejects(access(box.store));
  }
});

test('second-target failures roll back actual changed targets including rename-then-error and keep failed rollbacks recoverable', async (t) => {
  for (const operation of [apply, restore]) {
    for (const fault of ['write-failure', 'rename-then-error', 'rollback-failure']) {
      const box = await groupSandbox(t);
      if (operation === restore) response(apply(box));
      const bytes = await Promise.all(box.targets.map((path) => readFile(path)));
      const output = response(operation(box, { CODEX_TEST_TARGET: box.targets[1], CODEX_TEST_FAULT: fault }), 1);
      if (fault === 'rollback-failure') {
        assert.equal(output.diagnostics[0].code, 'ROLLBACK_FAILED');
        assert.deepEqual(response(status(box)).data.targets.map((target) => target.state), ['incomplete', 'incomplete', 'incomplete']);
        response(recover(box));
      }
      for (const [index, path] of box.targets.entries()) assert.deepEqual(await readFile(path), bytes[index]);
      assert.deepEqual(response(status(box)).data.targets.map((target) => target.state), Array(3).fill(operation === apply ? 'original' : 'tool-applied'));
    }
  }
});

test('status reports whole pending groups across stores while preserving explicit per-target selection', async (t) => {
  const box = await groupSandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename', { CODEX_TEST_TARGET: box.targets[1] });
  await interrupted.kill();
  const other = { ...box, store: join(box.directory, 'other-store') };
  const output = response(status(other));
  assert.equal(output.data.groupState, 'incomplete');
  assert.equal(output.data.pendingTransactions.length, 1);
  const pending = output.data.pendingTransactions[0];
  assert.equal(pending.store, box.store);
  assert.equal(pending.transaction, output.data.transaction);
  assert.deepEqual(pending.targets.map((target) => target.pending.current), ['after', 'after', 'before']);
  assert.deepEqual(output.data.targets.map((target) => target.state), ['incomplete', 'incomplete', 'incomplete']);
  const selected = response(run(other, ['status', '--target', box.targets[1], '--target', box.target, '--store', other.store]));
  assert.deepEqual(selected.data.targets.map((target) => target.path), [box.targets[1], box.target]);
  assert.equal(selected.data.pendingTransactions[0].targets.length, 3);
  const one = response(run(box, ['status', '--target', box.target, '--store', box.store]));
  assert.equal(one.data.targets.length, 1);
  assert.equal(one.data.pendingTransactions[0].targets.length, 3);
  assert.equal(response(apply(other), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
  assert.equal(response(restore(other), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
  await assert.rejects(access(other.store));
  response(recover(box));
});

test('mixed group interruptions and two killed recovery windows always converge to each actual before state', async (t) => {
  for (const operation of ['apply', 'restore']) {
    const box = await groupSandbox(t);
    response(apply({ ...box, plan: box.singlePlan }));
    const before = await Promise.all(box.targets.map((path) => readFile(path)));
    const beforeInode = (await stat(operation === 'apply' ? box.target : box.targets[1])).ino;
    const interrupted = await paused(t, box, operation, 'after-target-rename', { CODEX_TEST_TARGET: operation === 'apply' ? box.targets[2] : box.target });
    await interrupted.kill();
    const pending = response(status(box));
    assert.equal(pending.data.groupState, 'incomplete');
    assert.deepEqual(pending.data.targets.map((target) => target.pending.before), ['tool-applied', 'original', 'original']);
    assert.equal((await stat(operation === 'apply' ? box.target : box.targets[1])).ino, beforeInode);
    const recovering = await paused(t, box, 'recover', 'after-target-rename', { CODEX_TEST_TARGET: operation === 'apply' ? box.targets[1] : box.target });
    await recovering.kill();
    assert.equal(response(status(box)).data.groupState, 'incomplete');
    const finalizing = await paused(t, box, 'recover', 'before-rollback-commit');
    await finalizing.kill();
    for (const [index, path] of box.targets.entries()) assert.deepEqual(await readFile(path), before[index]);
    const recovered = response(recover(box));
    assert.deepEqual(recovered.data.targets.map((target) => target.state), ['tool-applied', 'original', 'original']);
    assert.deepEqual(response(status(box)).data.targets.map((target) => target.state), ['tool-applied', 'original', 'original']);
    assert.equal(response(recover(box)).diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
  }
});

test('unknown contents anywhere in a pending group cause zero recovery target writes and preserve the full journal', async (t) => {
  const box = await groupSandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename', { CODEX_TEST_TARGET: box.targets[1] });
  await interrupted.kill();
  const id = response(status(box)).data.transaction;
  const journal = join(box.store, 'transactions', id, 'journal.json');
  const beforeJournal = await readFile(journal);
  await writeFile(box.targets[2], 'external third target');
  const before = await Promise.all(box.targets.map((path) => readFile(path)));
  const inodes = await Promise.all(box.targets.map(async (path) => (await stat(path)).ino));
  const rejected = response(recover(box), 4);
  assert.equal(rejected.diagnostics[0].code, 'RECOVERY_CONFLICT');
  for (const [index, path] of box.targets.entries()) {
    assert.deepEqual(await readFile(path), before[index]);
    assert.equal((await stat(path)).ino, inodes[index]);
  }
  assert.deepEqual(await readFile(journal), beforeJournal);
  const statusOutput = response(status(box), 4);
  assert.equal(statusOutput.data.groupState, 'conflict');
  assert.deepEqual(statusOutput.data.targets.map((target) => target.state), ['incomplete', 'incomplete', 'conflict']);
  const selected = response(run(box, ['status', '--target', box.target, '--store', box.store]), 4);
  assert.equal(selected.data.targets[0].state, 'incomplete');
  assert.equal(selected.data.pendingTransactions[0].state, 'conflict');
});

test('group target locks use canonical order independent of plan order, exclude other stores, and survive dead pre-intent owners', async (t) => {
  const box = await groupSandbox(t);
  const reversePlan = join(box.directory, 'reverse-plan');
  response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), ...[...box.targets].reverse().flatMap((path) => ['--target', path]), '--output', reversePlan]));
  const holder = await paused(t, { ...box, plan: reversePlan }, 'apply', 'target-lock-acquired');
  const firstLock = join(box.target, '../.codex-browser-patch.lock');
  const lock = JSON.parse(await readFile(firstLock, 'utf8'));
  const live = { pid: holder.child.pid, start: lock.owner.start, executable: process.execPath, command: `${process.execPath} synthetic-cli` };
  const other = { ...box, store: join(box.directory, 'other-store') };
  assert.equal(response(apply(other, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([live]) }), 4).diagnostics[0].code, 'LOCK_HELD');
  for (const path of box.targets) assert.equal(await readFile(path, 'utf8'), source);
  await holder.kill();
  response(apply(other));
  assert.deepEqual(response(status(other)).data.targets.map((target) => target.state), ['tool-applied', 'tool-applied', 'tool-applied']);
});

test('verified v1 records remain readable with original authentication and pending v1 recovery keeps its wire format', async (t) => {
  for (const pending of [false, true]) {
    const box = await sandbox(t);
    let id;
    if (pending) {
      const interrupted = await paused(t, box, 'apply', 'after-target-rename');
      await interrupted.kill();
      id = response(status(box)).data.transaction;
    } else id = response(apply(box)).data.transaction;
    const journal = join(box.store, 'transactions', id, 'journal.json');
    const envelope = JSON.parse(await readFile(journal, 'utf8'));
    const { targets, ...base } = envelope.record;
    const legacy = { ...base, formatVersion: 1, target: targets[0] };
    // A wire-format fixture signed independently, before any production normalization.
    function canonical(value) {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
      return JSON.stringify(value);
    }
    const mac = createHmac('sha256', await readFile(join(box.store, 'key'))).update(canonical(legacy)).digest('hex');
    await writeFile(journal, JSON.stringify({ record: legacy, mac }));
    const originalEnvelope = await readFile(journal);
    assert.equal(response(status(box)).data.targets[0].state, pending ? 'incomplete' : 'tool-applied');
    assert.deepEqual(await readFile(journal), originalEnvelope);
    if (pending) {
      response(recover(box));
      const recovered = JSON.parse(await readFile(journal, 'utf8')).record;
      assert.equal(recovered.formatVersion, 1);
      assert.equal(recovered.target.path, box.target);
      assert.equal(recovered.targets, undefined);
      assert.equal(await readFile(box.target, 'utf8'), source);
    } else {
      response(restore(box));
      assert.deepEqual(await readFile(journal), originalEnvelope);
    }
    const changed = JSON.parse(await readFile(journal, 'utf8'));
    changed.record.target.before.sha256 = '0'.repeat(64);
    await writeFile(journal, JSON.stringify(changed));
    assert.equal(response(status(box), 4).diagnostics[0].code, 'UNTRUSTED_RECORD');
  }
});

test('multi-target apply/restore SIGKILL windows before writes, after renames and before commit recover the full group', async (t) => {
  for (const operation of ['apply', 'restore']) {
    for (const boundary of ['after-intent-publication', 'before-target-rename', 'after-target-rename', 'after-postverification', 'before-commit']) {
      const box = await groupSandbox(t);
      if (operation === 'restore') response(apply(box));
      const before = await Promise.all(box.targets.map((path) => readFile(path)));
      const interrupted = await paused(t, box, operation, boundary, { CODEX_TEST_TARGET: box.targets[1] });
      await interrupted.kill();
      const output = response(status(box));
      assert.equal(output.data.operation, operation);
      assert.equal(output.data.groupState, 'incomplete');
      assert.equal(output.data.pendingTransactions[0].targets.length, 3);
      response(recover(box));
      for (const [index, path] of box.targets.entries()) assert.deepEqual(await readFile(path), before[index]);
      assert.equal(response(status(box)).data.groupState, 'complete');
    }
  }
});

test('status can report distinct pending groups from multiple stores without choosing one legacy transaction', async (t) => {
  const box = await groupSandbox(t);
  const secondPlan = join(box.directory, 'second-plan');
  response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), '--target', box.targets[1], '--output', secondPlan]));
  const first = await paused(t, { ...box, plan: box.singlePlan }, 'apply', 'after-target-rename');
  await first.kill();
  const other = { ...box, plan: secondPlan, store: join(box.directory, 'second-store'), target: box.targets[1] };
  const second = await paused(t, other, 'apply', 'after-target-rename');
  await second.kill();
  const output = response(status({ ...box, store: join(box.directory, 'read-only-store') }));
  assert.equal(output.data.transaction, null);
  assert.equal(output.data.operation, null);
  assert.equal(output.data.groupState, 'incomplete');
  assert.equal(output.data.pendingTransactions.length, 2);
  assert.deepEqual(output.data.targets.map((target) => target.state), ['incomplete', 'incomplete', 'original']);
  assert.deepEqual(new Set(output.data.pendingTransactions.map((pending) => pending.store)), new Set([box.store, other.store]));
  response(recover(box));
  response(recover(other));
});

test('group rechecks all targets after writing-intent journal I/O before replacing the first target', async (t) => {
  const box = await groupSandbox(t);
  const changing = await paused(t, box, 'apply', 'before-writing-journal');
  await writeFile(box.targets[2], 'external edit while writing intent');
  const inodes = await Promise.all(box.targets.map(async (path) => (await stat(path)).ino));
  response(await changing.finish(), 1);
  assert.equal(await readFile(box.targets[2], 'utf8'), 'external edit while writing intent');
  for (const [index, path] of box.targets.entries()) assert.equal((await stat(path)).ino, inodes[index]);
});

test('recovery rechecks every backup after journal I/O before restoring the first changed target', async (t) => {
  const box = await groupSandbox(t);
  const interrupted = await paused(t, box, 'apply', 'before-commit');
  await interrupted.kill();
  const id = response(status(box)).data.transaction;
  const backup = join(box.store, 'transactions', id, 'before.0002.mjs');
  const before = await Promise.all(box.targets.map((path) => readFile(path)));
  const inodes = await Promise.all(box.targets.map(async (path) => (await stat(path)).ino));
  const output = response(recover(box, { CODEX_TEST_BACKUP: backup, CODEX_TEST_FAULT: 'recovery-later-backup-change' }), 4);
  assert.equal(output.diagnostics[0].code, 'BACKUP_CHANGED');
  for (const [index, path] of box.targets.entries()) {
    assert.deepEqual(await readFile(path), before[index]);
    assert.equal((await stat(path)).ino, inodes[index]);
  }
});

test('failure recovery refuses an unknown later target even when earlier target progress is already journaled', async (t) => {
  const box = await groupSandbox(t);
  const changing = await paused(t, box, 'apply', 'after-progress-journal');
  await writeFile(box.targets[2], 'external later target after first write');
  const output = response(await changing.finish(), 1);
  assert.equal(output.diagnostics[0].code, 'ROLLBACK_FAILED');
  assert.match(await readFile(box.target, 'utf8'), /agent:false/);
  assert.equal(await readFile(box.targets[2], 'utf8'), 'external later target after first write');
  const before = await Promise.all(box.targets.map((path) => readFile(path)));
  response(recover(box), 4);
  for (const [index, path] of box.targets.entries()) assert.deepEqual(await readFile(path), before[index]);
});

test('a group blocked by a later target held in another store writes nothing and keeps that owners incomplete transaction visible', async (t) => {
  const box = await groupSandbox(t);
  const single = join(box.directory, 'later-only');
  response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), '--target', box.targets[2], '--output', single]));
  const owner = { ...box, plan: single, target: box.targets[2], store: join(box.directory, 'owner-store') };
  const holder = await paused(t, owner, 'restore', 'after-intent-publication');
  const rejected = response(apply(box), 4);
  assert.equal(rejected.diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
  await assert.rejects(access(box.store));
  for (const path of box.targets) assert.equal(await readFile(path, 'utf8'), source);
  await holder.kill();
  const state = response(status(box));
  assert.equal(state.data.pendingTransactions[0].store, owner.store);
  assert.deepEqual(state.data.targets.map((target) => target.state), ['original', 'original', 'incomplete']);
  response(recover(owner));
  response(apply(box));
});

test('a delayed recover rechecks history under locks and cannot undo a later committed group operation', async (t) => {
  const box = await groupSandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename');
  await interrupted.kill();
  const delayed = await paused(t, box, 'recover', 'before-operation-lock');
  response(recover(box));
  response(apply(box));
  const before = await Promise.all(box.targets.map((path) => readFile(path)));
  const output = response(await delayed.finish());
  assert.equal(output.diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
  for (const [index, path] of box.targets.entries()) assert.deepEqual(await readFile(path), before[index]);
  assert.deepEqual(response(status(box)).data.targets.map((target) => target.state), ['tool-applied', 'tool-applied', 'tool-applied']);
});

test('operation commands require explicit plan/store selection', async (t) => {
  const box = await sandbox(t);
  for (const args of [['apply'], ['apply', '--plan', box.plan], ['apply', '--store', box.store], ['recover'], ['recover', '--store', box.store, '--plan', box.plan], ['status', '--store', box.store]]) {
    response(run(box, args), 2);
  }
});

test('SIGKILL after target rename and again during recovery rolls back from durable intent, never continues apply', async (t) => {
  const box = await sandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename');
  assert.match(await readFile(box.target, 'utf8'), /agent:false/);
  await interrupted.kill();
  assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
  assert.equal(response(apply(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
  const other = { ...box, store: join(box.directory, 'other-store') };
  assert.equal(response(apply(other), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
  const recovering = await paused(t, box, 'recover', 'after-target-rename');
  assert.equal(await readFile(box.target, 'utf8'), source);
  await recovering.kill();
  assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
  const recovered = response(recover(box));
  assert.equal(recovered.data.targets[0].state, 'original');
  assert.equal(recovered.data.targets[0].action, 'rolled-back');
  assert.equal(response(status(box)).data.targets[0].state, 'original');
  response(recover(box));
  response(apply(box));
});

test('interrupted restore and repeatedly interrupted recover return the actual patched pre-restore state', async (t) => {
  for (const boundary of ['before-target-rename', 'after-target-rename', 'after-postverification', 'before-commit']) {
    const box = await sandbox(t);
    response(apply(box));
    const patched = await readFile(box.target);
    const interrupted = await paused(t, box, 'restore', boundary);
    if (boundary !== 'before-target-rename') assert.equal(await readFile(box.target, 'utf8'), source);
    await interrupted.kill();
    const incomplete = response(status(box));
    assert.equal(incomplete.data.targets[0].state, 'incomplete');
    assert.equal(incomplete.data.operation, 'restore');
    assert.equal(response(restore(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
    assert.equal(response(apply(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
    const other = { ...box, store: join(box.directory, 'other-store') };
    assert.equal(response(restore(other), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
    if (boundary !== 'before-target-rename') {
      const recovering = await paused(t, box, 'recover', 'after-target-rename');
      assert.deepEqual(await readFile(box.target), patched);
      await recovering.kill();
      assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
    }
    const finalizing = await paused(t, box, 'recover', 'before-rollback-commit');
    assert.deepEqual(await readFile(box.target), patched);
    await finalizing.kill();
    assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
    const recovered = response(recover(box));
    assert.equal(recovered.data.targets[0].state, 'tool-applied');
    assert.equal(recovered.data.targets[0].action, 'rolled-back');
    assert.deepEqual(await readFile(box.target), patched);
    assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
    assert.equal(response(recover(box)).diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
    response(restore(box));
    assert.equal(await readFile(box.target, 'utf8'), source);
  }
});

test('status accepts explicit targets, distinguishes incompatibility and untrusted patches, and never creates state', async (t) => {
  const box = await sandbox(t);
  const original = response(run(box, ['status', '--target', box.target, '--store', box.store]));
  assert.equal(original.data.targets[0].state, 'original');
  await assert.rejects(access(box.store));
  await writeFile(box.target, 'const unrelated = true;');
  const unsupported = response(run(box, ['status', '--target', box.target, '--store', box.store]), 3);
  assert.equal(unsupported.data.targets[0].state, 'incompatible');
  await writeFile(box.target, source.replace('agentBlocked(body);', 'agentBlocked({...body,feature_status:{...body?.feature_status,agent:false}});'));
  const untrusted = response(run(box, ['status', '--target', box.target, '--store', box.store]), 4);
  assert.equal(untrusted.data.targets[0].state, 'conflict');
  await assert.rejects(access(box.store));
});

test('SIGKILL between lease link and staging unlink permits safe dead-owner retry without an intent', async (t) => {
  for (const scope of ['operation', 'target']) {
    const box = await sandbox(t);
    const root = scope === 'operation' ? join(box.store, 'operation.lock') : join(box.target, '../.codex-browser-patch.lock');
    const holder = await paused(t, box, 'apply', `after-${scope}-lock-link`);
    assert.equal((await stat(root)).nlink, 2);
    const record = JSON.parse(await readFile(root, 'utf8'));
    const live = { pid: holder.child.pid, start: record.owner.start, executable: process.execPath, command: `${process.execPath} synthetic-cli` };
    assert.equal(response(apply(box, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([live]) }), 4).diagnostics[0].code, 'LOCK_HELD');
    await holder.kill();
    assert.equal(response(recover(box)).diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
    assert.equal(response(status(box)).data.targets[0].state, 'original');
    assert.equal(await readFile(box.target, 'utf8'), source);
    response(apply(box));
    assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
    response(restore(box));
  }
});

test('lease successor and release link interruptions preserve terminal provenance and retry', async (t) => {
  for (const scope of ['operation', 'target']) {
    for (const phase of ['successor', 'release']) {
      const box = await sandbox(t);
      if (phase === 'successor') response(apply(box));
      const holder = await paused(t, box, phase === 'successor' ? 'restore' : 'apply', `after-${scope}-${phase}-link`);
      await holder.kill();
      assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
      assert.equal(response(recover(box)).diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
      response(restore(box));
      assert.equal(await readFile(box.target, 'utf8'), source);
    }
  }
});

test('unexplained hardlinked lease files remain conflicts', async (t) => {
  const box = await sandbox(t);
  response(apply(box));
  const root = join(box.target, '../.codex-browser-patch.lock');
  await link(root, join(box.directory, 'external-lease-alias'));
  assert.equal(response(status(box), 4).diagnostics[0].code, 'PATH_ALIAS');
  assert.equal(response(restore(box), 4).diagnostics[0].code, 'PATH_ALIAS');
  assert.match(await readFile(box.target, 'utf8'), /agent:false/);
});

test('deleted completed versions do not block selected live versions or their pending recovery', async (t) => {
  for (const pending of [false, true]) {
    const old = await sandbox(t);
    response(apply(old));
    response(restore(old));
    const target = join(old.directory, 'plugins/browser/new-version/scripts/browser-service.mjs');
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, source, { mode: 0o640 });
    const box = { ...old, target, plan: join(old.directory, 'new-plan') };
    response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), '--target', target, '--output', box.plan]));
    if (pending) {
      const interrupted = await paused(t, box, 'apply', 'after-target-rename');
      await interrupted.kill();
    }
    await rm(join(old.directory, 'plugins/browser/synthetic'), { recursive: true });
    const state = response(status(box));
    assert.equal(state.data.targets[0].state, pending ? 'incomplete' : 'original');
    if (pending) {
      assert.match(await readFile(target, 'utf8'), /agent:false/);
      assert.equal(response(apply(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
      response(recover(box));
      assert.equal(await readFile(target, 'utf8'), source);
    }
    response(apply(box));
    response(restore(box));
    assert.equal(response(status(box)).data.targets[0].state, 'original');
    assert.equal(response(recover(box)).diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
  }
});

test('held locks exclude concurrent stores; dead owners without an intent can be safely superseded', async (t) => {
  const box = await sandbox(t);
  const holder = await paused(t, box, 'apply', 'target-lock-acquired');
  const other = { ...box, store: join(box.directory, 'other-store') };
  const lock = JSON.parse(await readFile(join(box.directory, 'plugins/browser/synthetic/scripts/.codex-browser-patch.lock'), 'utf8'));
  const live = { pid: holder.child.pid, start: lock.owner.start, executable: process.execPath, command: `${process.execPath} synthetic-cli` };
  const rejected = response(apply(other, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([live]) }), 4);
  assert.equal(rejected.diagnostics[0].code, 'LOCK_HELD');
  assert.equal(await readFile(box.target, 'utf8'), source);
  await holder.kill();
  response(apply(other));
  assert.match(await readFile(box.target, 'utf8'), /agent:false/);
});

test('restore holds the same operation and target locks; a dead pre-intent owner can be superseded', async (t) => {
  const box = await sandbox(t);
  response(apply(box));
  const patched = await readFile(box.target);
  const holder = await paused(t, box, 'restore', 'target-lock-acquired');
  assert.equal(response(restore(box), 4).diagnostics[0].code, 'OWNER_UNVERIFIED');
  const other = { ...box, store: join(box.directory, 'other-store') };
  assert.equal(response(apply(other), 4).outcome, 'conflict');
  assert.deepEqual(await readFile(box.target), patched);
  await holder.kill();
  response(restore(box));
  assert.equal(await readFile(box.target, 'utf8'), source);
  assert.equal(response(status(box)).data.targets[0].state, 'original');
});

test('unprovable owner and aliased operation stores fail closed without touching targets', async (t) => {
  const box = await sandbox(t);
  const root = join(box.directory, 'plugins/browser/synthetic/scripts');
  await writeFile(join(root, '.codex-browser-patch.lock'), '{}', { mode: 0o600 });
  assert.equal(response(apply(box), 4).diagnostics[0].code, 'INVALID_LOCK');
  assert.equal(await readFile(box.target, 'utf8'), source);
  await rm(join(root, '.codex-browser-patch.lock'));
  const actual = join(box.directory, 'actual-store');
  await mkdir(actual, { mode: 0o700 }); await symlink(actual, box.store);
  assert.equal(response(apply(box), 4).diagnostics[0].code, 'PATH_ALIAS');
  assert.equal(await readFile(box.target, 'utf8'), source);
});

test('unknown external contents prevent recovery and ordinary writes while preserving journal and backup', async (t) => {
  const box = await sandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename');
  await interrupted.kill();
  const state = response(status(box));
  const journal = join(box.store, 'transactions', state.data.transaction, 'journal.json');
  const beforeJournal = await readFile(journal);
  await writeFile(box.target, 'user changed this after interruption');
  const rejected = response(recover(box), 4);
  assert.equal(rejected.diagnostics[0].code, 'RECOVERY_CONFLICT');
  assert.equal(await readFile(box.target, 'utf8'), 'user changed this after interruption');
  assert.deepEqual(await readFile(journal), beforeJournal);
  assert.equal(response(apply(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
});

test('recover revalidates private plan/backup/authenticated provenance and uses its stored plan after review deletion', async (t) => {
  for (const mutation of ['review-deleted', 'backup', 'journal', 'stored-plan']) {
    const box = await sandbox(t);
    const interrupted = await paused(t, box, 'apply', 'after-target-rename');
    await interrupted.kill();
    const id = response(status(box)).data.transaction;
    const directory = join(box.store, 'transactions', id);
    if (mutation === 'review-deleted') await rm(box.plan, { recursive: true });
    if (mutation === 'backup') await writeFile(join(directory, 'before.mjs'), 'damaged backup');
    if (mutation === 'stored-plan') await writeFile(join(directory, 'plan/contents/0000.original.mjs'), 'damaged source artifact');
    if (mutation === 'journal') {
      const path = join(directory, 'journal.json');
      const value = JSON.parse(await readFile(path, 'utf8'));
      value.record.phase = 'committed';
      await writeFile(path, JSON.stringify(value));
    }
    const before = await readFile(box.target);
    const output = recover(box);
    if (mutation === 'review-deleted') {
      response(output);
      assert.equal(await readFile(box.target, 'utf8'), source);
    } else {
      assert.ok(output.status === 4 || output.status === 1, output.stdout);
      assert.deepEqual(await readFile(box.target), before);
    }
  }
});

test('write failures including rename-then-error roll back; failed rollback stays recoverable', async (t) => {
  for (const fault of ['write-failure', 'rename-then-error', 'rollback-failure']) {
    const box = await sandbox(t);
    const output = response(apply(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: fault }), 1);
    if (fault === 'rollback-failure') {
      assert.equal(output.diagnostics[0].code, 'ROLLBACK_FAILED');
      assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
      assert.match(await readFile(box.target, 'utf8'), /agent:false/);
      response(recover(box));
    }
    assert.equal(await readFile(box.target, 'utf8'), source);
    assert.equal(response(status(box)).data.targets[0].state, 'original');
    response(apply(box));
  }
});

test('restore write and rollback failures preserve patched before-state and remain explicitly recoverable', async (t) => {
  for (const fault of ['write-failure', 'rename-then-error', 'rollback-failure', 'commit-journal-failure']) {
    const box = await sandbox(t);
    response(apply(box));
    const patched = await readFile(box.target);
    const output = response(restore(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: fault }), 1);
    assert.equal(output.command, 'restore');
    if (fault === 'rollback-failure' || fault === 'commit-journal-failure') {
      assert.equal(output.diagnostics[0].code, fault === 'rollback-failure' ? 'ROLLBACK_FAILED' : 'JOURNAL_WRITE_FAILED');
      assert.equal(await readFile(box.target, 'utf8'), source);
      assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
      assert.equal(response(restore(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
      response(recover(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: 'rollback-journal-failure' }), 1);
      assert.deepEqual(await readFile(box.target), patched);
      assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
      response(recover(box));
    }
    assert.deepEqual(await readFile(box.target), patched);
    assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
    response(recover(box));
    response(restore(box));
    assert.equal(await readFile(box.target, 'utf8'), source);
  }
});

test('recover rejects a restore backup changed after preflight without replacing current original bytes', async (t) => {
  const box = await sandbox(t);
  response(apply(box));
  const interrupted = await paused(t, box, 'restore', 'after-target-rename');
  await interrupted.kill();
  const id = response(status(box)).data.transaction;
  const directory = join(box.store, 'transactions', id);
  const backup = join(directory, 'before.mjs');
  const rejected = response(recover(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_BACKUP: backup, CODEX_TEST_FAULT: 'recovery-backup-change' }), 4);
  assert.equal(rejected.diagnostics[0].code, 'BACKUP_CHANGED');
  assert.equal(await readFile(box.target, 'utf8'), source);
  assert.equal(await readFile(backup, 'utf8'), 'external backup change');
  await access(join(directory, 'journal.json'));
  assert.equal(response(restore(box), 4).diagnostics[0].code, 'BACKUP_CHANGED');
});

test('restore and recover preserve external modifications at replacement and interrupted recovery boundaries', async (t) => {
  for (const fault of ['prewrite-change', 'postwrite-change', 'parent-replaced']) {
    const box = await sandbox(t);
    response(apply(box));
    const patched = await readFile(box.target, 'utf8');
    const failed = restore(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: fault });
    assert.ok(failed.status === 4 || failed.status === 1, failed.stdout + failed.stderr);
    const changed = await readFile(box.target, 'utf8');
    assert.equal(changed, fault === 'parent-replaced' ? patched : 'external boundary change');
    assert.equal(response(status(box), 4).data.targets[0].state, 'conflict');
    response(recover(box), 4);
    assert.equal(await readFile(box.target, 'utf8'), changed);
  }
  const box = await sandbox(t);
  response(apply(box));
  const interrupted = await paused(t, box, 'restore', 'after-target-rename');
  await interrupted.kill();
  const id = response(status(box)).data.transaction;
  const journal = join(box.store, 'transactions', id, 'journal.json');
  const beforeJournal = await readFile(journal);
  await writeFile(box.target, 'external edit during interrupted restore');
  const rejected = response(recover(box), 4);
  assert.equal(rejected.diagnostics[0].code, 'RECOVERY_CONFLICT');
  assert.equal(await readFile(box.target, 'utf8'), 'external edit during interrupted restore');
  assert.deepEqual(await readFile(journal), beforeJournal);
  assert.equal(response(status(box), 4).data.transaction, id);
  assert.equal(response(restore(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
});

test('prewrite and postverification interruptions stay incomplete; explicit recover always restores before state', async (t) => {
  for (const boundary of ['before-target-rename', 'after-postverification', 'before-commit']) {
    const box = await sandbox(t);
    const interrupted = await paused(t, box, 'apply', boundary);
    await interrupted.kill();
    assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
    response(recover(box));
    assert.equal(await readFile(box.target, 'utf8'), source);
    assert.equal(response(status(box)).data.targets[0].state, 'original');
  }
});

test('recovery refuses running processes and unavailable enumeration without altering pending journal', async (t) => {
  const box = await sandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename');
  await interrupted.kill();
  const before = await readFile(box.target);
  assert.equal(response(recover(box, { CODEX_TEST_PROCESS_FAILURE: '1' }), 1).diagnostics[0].code, 'PROCESS_ENUMERATION_FAILED');
  const row = { pid: 4101, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: 'ChatGPT' };
  assert.equal(response(recover(box, { CODEX_TEST_PROCESS_ROWS: JSON.stringify([row]) }), 4).diagnostics[0].code, 'PROCESSES_RUNNING');
  assert.deepEqual(await readFile(box.target), before);
  assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
  response(recover(box));
});

test('a process missing from a ps snapshot is not proof that a held owner is dead', async (t) => {
  const box = await sandbox(t);
  const holder = await paused(t, box, 'apply', 'target-lock-acquired');
  const other = { ...box, store: join(box.directory, 'other-store') };
  const rejected = response(apply(other), 4);
  assert.equal(rejected.diagnostics[0].code, 'OWNER_UNVERIFIED');
  assert.equal(await readFile(box.target, 'utf8'), source);
  await holder.kill();
  response(apply(other));
});

test('terminal journal failure retains recoverable before state and never publishes false success', async (t) => {
  const box = await sandbox(t);
  const failed = response(apply(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: 'commit-journal-failure' }), 1);
  assert.equal(failed.outcome, 'runtime-error');
  assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
  assert.equal(response(apply(box), 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
  response(recover(box));
  assert.equal(await readFile(box.target, 'utf8'), source);
  response(recover(box));
});

test('status reports a changed pending target as conflict while retaining the incomplete transaction identity', async (t) => {
  const box = await sandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename');
  await interrupted.kill();
  const id = response(status(box)).data.transaction;
  await writeFile(box.target, 'unknown external content');
  const output = response(status(box), 4);
  assert.equal(output.data.targets[0].state, 'conflict');
  assert.equal(output.data.transaction, id);
  assert.equal(await readFile(box.target, 'utf8'), 'unknown external content');
});

test('target changes at the filesystem replacement boundary fail closed and preserve external data', async (t) => {
  for (const fault of ['prewrite-change', 'postwrite-change', 'parent-replaced']) {
    const box = await sandbox(t);
    const failed = apply(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: fault });
    assert.ok(failed.status === 4 || failed.status === 1, failed.stdout + failed.stderr);
    const changed = await readFile(box.target, 'utf8');
    assert.equal(changed, fault === 'parent-replaced' ? source : 'external boundary change');
    assert.equal(response(status(box), 4).data.targets[0].state, 'conflict');
    const recovery = recover(box);
    assert.ok(recovery.status === 4 || recovery.status === 1, recovery.stdout);
    assert.equal(await readFile(box.target, 'utf8'), changed);
  }
});

test('retry interrupted before a no-op apply commits recovers the patched preoperation state', async (t) => {
  const box = await sandbox(t);
  response(apply(box));
  const patched = await readFile(box.target);
  const interrupted = await paused(t, box, 'apply', 'before-commit');
  await interrupted.kill();
  assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
  const recovered = response(recover(box));
  assert.equal(recovered.data.targets[0].state, 'tool-applied');
  assert.deepEqual(await readFile(box.target), patched);
  assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
});

test('journal writes that rename then fail retain persisted state, and failed recovery finalization is repeatable', async (t) => {
  const committed = await sandbox(t);
  response(apply(committed, { CODEX_TEST_TARGET: committed.target, CODEX_TEST_FAULT: 'commit-journal-renamed-error' }), 1);
  assert.equal(response(status(committed)).data.targets[0].state, 'tool-applied');
  response(recover(committed));
  assert.match(await readFile(committed.target, 'utf8'), /agent:false/);

  const box = await sandbox(t);
  const interrupted = await paused(t, box, 'apply', 'after-target-rename');
  await interrupted.kill();
  response(recover(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: 'rollback-journal-failure' }), 1);
  assert.equal(await readFile(box.target, 'utf8'), source);
  assert.equal(response(status(box)).data.targets[0].state, 'incomplete');
  response(recover(box));
  assert.equal(response(status(box)).data.targets[0].state, 'original');
});

test('status and ordinary writes reject changed committed provenance rather than trusting patch shape', async (t) => {
  for (const mutation of ['backup', 'journal', 'key', 'identity']) {
    const box = await sandbox(t);
    const id = response(apply(box)).data.transaction;
    const directory = join(box.store, 'transactions', id);
    if (mutation === 'backup') await writeFile(join(directory, 'before.mjs'), 'forged original');
    if (mutation === 'journal') {
      const path = join(directory, 'journal.json');
      const value = JSON.parse(await readFile(path, 'utf8'));
      value.record.targets[0].final.sha256 = '0'.repeat(64);
      await writeFile(path, JSON.stringify(value));
    }
    if (mutation === 'key') await writeFile(join(box.store, 'key'), Buffer.alloc(32));
    if (mutation === 'identity') await replaceIdentity(box);
    const bytes = await readFile(box.target);
    assert.equal(response(status(box), 4).outcome, 'conflict');
    assert.equal(response(apply(box), 4).outcome, 'conflict');
    assert.deepEqual(await readFile(box.target), bytes);
  }
});

test('lock release failure is a runtime failure with terminal provenance still usable', async (t) => {
  const box = await sandbox(t);
  const output = response(apply(box, { CODEX_TEST_TARGET: box.target, CODEX_TEST_FAULT: 'release-failure' }), 1);
  assert.equal(output.outcome, 'runtime-error');
  assert.equal(response(status(box)).data.targets[0].state, 'tool-applied');
  response(apply(box));
});
