import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import type { Candidate, Inspection } from '../src/managed-patches.js';
import type { OperationResult } from '../src/result.js';
import { runCli, startCli } from './helpers/cli.js';
import { syntheticInstallation } from './helpers/npm-package.js';

const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));
const binary = fileURLToPath(new URL('./fixtures/managed-patches-driver.js', import.meta.url));
type Box = { directory: string; target: string; source: string | Buffer; candidate: Candidate };

function required<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined, 'Expected test value to be present');
  return value;
}

async function sandbox(t: TestContext): Promise<Box> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-managed-transaction-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { app, target, source } = await syntheticInstallation({ directory }, 'Transactions');
  return { directory, target, source, candidate: { appPath: app, targetPath: target, version: null, build: null } };
}

function run<C extends string>(box: Box, command: C, env: NodeJS.ProcessEnv = {}) {
  const child = runCli([command, JSON.stringify(box.candidate)], { directory: box.directory, binary, fixture, env: { CODEX_TEST_TARGET: box.target, ...env } });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(child.stderr, '');
  const output: C extends 'inspect' ? Inspection : OperationResult = JSON.parse(child.stdout);
  return output;
}

function operation(box: Box, command: string, env: NodeJS.ProcessEnv = {}, expected = 0) {
  const output = run(box, command, env);
  assert.equal(output.exitCode, expected, JSON.stringify(output));
  return output;
}

async function pause(t: TestContext, box: Box, boundary: string) {
  const child = startCli(['apply', JSON.stringify(box.candidate)], {
    directory: box.directory, binary, fixture,
    env: { CODEX_TEST_PAUSE: boundary, CODEX_TEST_TARGET: box.target }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => { text += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { text += chunk; });
  await Promise.race([
    once(child, 'message').then(([message]: unknown[]) => {
      assert.ok(message !== null && typeof message === 'object' && 'boundary' in message);
      assert.equal(message.boundary, boundary);
    }),
    once(child, 'exit').then(([code, signal]: unknown[]) => { throw new Error(`Driver exited before ${boundary}: ${code}/${signal} ${text}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`No boundary ${boundary}: ${text}`)), 10_000); timer.unref(); }),
  ]);
  return {
    async kill() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; },
  };
}

test('managed apply and restore roll back write errors including rename-then-error, retaining failed rollback for recovery', async (t) => {
  for (const command of ['apply', 'restore']) {
    for (const fault of ['write-failure', 'rename-then-error', 'rollback-failure']) {
      const box = await sandbox(t);
      if (command === 'restore') operation(box, 'apply');
      const before = await readFile(box.target);
      const failed = operation(box, command, { CODEX_TEST_FAULT: fault }, 1);
      if (fault === 'rollback-failure') {
        assert.equal(failed.diagnostics[0]?.code, 'ROLLBACK_FAILED');
        assert.equal(run(box, 'inspect').state, 'incomplete');
        operation(box, 'recover');
      }
      assert.deepEqual(await readFile(box.target), before);
      assert.equal(run(box, 'inspect').state, command === 'apply' ? 'original' : 'tool-applied');
      assert.equal((await stat(box.target)).mode & 0o7777, 0o640);
    }
  }
});

test('managed terminal journal failures remain recoverable and failed rollback finalization is repeatable', async (t) => {
  const box = await sandbox(t);
  const failed = operation(box, 'apply', { CODEX_TEST_FAULT: 'commit-journal-failure' }, 1);
  assert.equal(failed.outcome, 'runtime-error');
  assert.equal(run(box, 'inspect').state, 'incomplete');
  assert.equal(operation(box, 'apply', {}, 4).diagnostics[0]?.code, 'INCOMPLETE_TRANSACTION');
  operation(box, 'recover', { CODEX_TEST_FAULT: 'rollback-journal-failure' }, 1);
  assert.deepEqual(await readFile(box.target), box.source);
  assert.equal(run(box, 'inspect').state, 'incomplete');
  operation(box, 'recover');
  assert.equal(run(box, 'inspect').state, 'original');
  assert.equal(operation(box, 'recover').diagnostics[0]?.code, 'NO_INCOMPLETE_TRANSACTION');
});

test('a journal rename followed by an error retains committed provenance instead of undoing committed bytes', async (t) => {
  const box = await sandbox(t);
  operation(box, 'apply', { CODEX_TEST_FAULT: 'commit-journal-renamed-error' }, 1);
  const patched = await readFile(box.target);
  assert.notDeepEqual(patched, box.source);
  assert.equal(run(box, 'inspect').state, 'tool-applied');
  assert.equal(operation(box, 'recover').diagnostics[0]?.code, 'NO_INCOMPLETE_TRANSACTION');
  assert.deepEqual(await readFile(box.target), patched);
  operation(box, 'restore');
  assert.deepEqual(await readFile(box.target), box.source);
});

test('managed transaction replacement boundaries preserve external edits and replaced parent identities', async (t) => {
  for (const command of ['apply', 'restore']) {
    for (const fault of ['prewrite-change', 'postwrite-change', 'parent-replaced']) {
      const box = await sandbox(t);
      if (command === 'restore') operation(box, 'apply');
      const before = await readFile(box.target);
      const failed = run(box, command, { CODEX_TEST_FAULT: fault });
      assert.ok(failed.exitCode === 1 || failed.exitCode === 4, JSON.stringify(failed));
      const changed = await readFile(box.target);
      assert.deepEqual(changed, fault === 'parent-replaced' ? before : Buffer.from('external boundary change'));
      assert.equal(run(box, 'inspect').state, 'conflict');
      assert.notEqual(run(box, 'recover').exitCode, 0);
      assert.deepEqual(await readFile(box.target), changed);
    }
  }
});

test('damaged managed backups, authenticated journals and store keys cannot authorize further writes', async (t) => {
  for (const mutation of ['backup', 'journal', 'key']) {
    const box = await sandbox(t);
    const applied = operation(box, 'apply');
    const inspection = run(box, 'inspect');
    const store = required(inspection.recovery).store;
    const directory = join(store, 'transactions', required(required(applied.data).transaction));
    if (mutation === 'backup') await writeFile(join(directory, 'before.mjs'), 'forged original');
    else if (mutation === 'key') await writeFile(join(store, 'key'), Buffer.alloc(32));
    else {
      const path = join(directory, 'journal.json');
      const envelope: { record: { phase: string }; mac: string } = JSON.parse(await readFile(path, 'utf8'));
      envelope.record.phase = 'rolled-back';
      await writeFile(path, JSON.stringify(envelope));
    }
    const patched = await readFile(box.target);
    const identity = await stat(box.target);
    assert.equal(run(box, 'inspect').state, 'conflict', mutation);
    for (const command of ['apply', 'restore', 'recover']) assert.notEqual(run(box, command).exitCode, 0, mutation);
    assert.deepEqual(await readFile(box.target), patched, mutation);
    assert.equal((await stat(box.target)).ino, identity.ino, mutation);
  }
});

test('managed coordination never treats a live owner missing from ps as dead and permits retry after proven death', async (t) => {
  const box = await sandbox(t);
  const holder = await pause(t, box, 'after-coordination-lock-link');
  const rejected = operation(box, 'apply', {}, 4);
  assert.equal(rejected.diagnostics[0]?.code, 'OWNER_UNVERIFIED');
  assert.deepEqual(await readFile(box.target), box.source);
  await holder.kill();
  operation(box, 'apply');
  operation(box, 'restore');
  assert.deepEqual(await readFile(box.target), box.source);
  assert.deepEqual(await readdir(join(box.target, '..')), ['browser-service.mjs']);
});
