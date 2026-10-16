import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers';
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
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

function options(box, extraEnv = {}) {
  return {
    cwd: box.directory, encoding: 'utf8',
    env: { ...process.env, HOME: join(box.directory, 'home'), NODE_OPTIONS: '', ...extraEnv },
  };
}

function run(box, args, extraEnv = {}) {
  return spawnSync(process.execPath, ['--require', fixture, cli, ...args, '--json'], options(box, extraEnv));
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
const status = (box) => run(box, ['status', '--plan', box.plan, '--store', box.store]);
const recover = (box, extra = {}) => run(box, ['recover', '--store', box.store], extra);

async function paused(t, box, command, boundary, extraEnv = {}) {
  const args = command === 'apply' ? ['apply', '--plan', box.plan, '--store', box.store] : ['recover', '--store', box.store];
  const child = spawn(process.execPath, ['--require', fixture, cli, ...args, '--json'], {
    ...options(box, { CODEX_TEST_PAUSE: boundary, CODEX_TEST_TARGET: box.target, ...extraEnv }),
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

test('apply preflights current identity and every plan artifact before target or store writes', async (t) => {
  for (const mutation of ['source', 'inode', 'original', 'patched', 'manifest', 'symlink', 'hardlink']) {
    const box = await sandbox(t);
    if (mutation === 'source') await writeFile(box.target, source + '// external change');
    if (mutation === 'inode') { await rm(box.target); await writeFile(box.target, source, { mode: 0o640 }); }
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

test('multi-target plans reject entirely and operation commands require explicit plan/store selection', async (t) => {
  const box = await sandbox(t);
  const second = join(box.directory, 'plugins/chrome/other/scripts/browser-service.mjs');
  await mkdir(join(box.directory, 'plugins/chrome/other/scripts'), { recursive: true });
  await writeFile(second, source);
  const plan = join(box.directory, 'multi');
  response(run(box, ['prepare', '--plugin-root', join(box.directory, 'plugins'), '--all-compatible', '--output', plan]));
  const output = response(apply({ ...box, plan }), 2);
  assert.equal(output.diagnostics[0].code, 'MULTI_TARGET_UNSUPPORTED');
  assert.equal(await readFile(box.target, 'utf8'), source);
  assert.equal(await readFile(second, 'utf8'), source);
  await assert.rejects(access(box.store));
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
      value.record.target.final.sha256 = '0'.repeat(64);
      await writeFile(path, JSON.stringify(value));
    }
    if (mutation === 'key') await writeFile(join(box.store, 'key'), Buffer.alloc(32));
    if (mutation === 'identity') {
      const bytes = await readFile(box.target);
      await rm(box.target); await writeFile(box.target, bytes, { mode: 0o640 });
    }
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
