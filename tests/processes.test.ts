import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Candidate } from '../src/managed-patches.js';
import type { OperationResult } from '../src/result.js';
import { runCli } from './helpers/cli.js';
import { syntheticInstallation } from './helpers/npm-package.js';

const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));
const binary = fileURLToPath(new URL('./fixtures/managed-patches-driver.js', import.meta.url));
type Box = { directory: string; target: string; source: string | Buffer; candidate: Candidate };

function run(box: Box, command: string, env: NodeJS.ProcessEnv = {}, expected = 0): OperationResult {
  const result = runCli([command, JSON.stringify(box.candidate)], { directory: box.directory, binary, fixture, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const output: OperationResult = JSON.parse(result.stdout);
  assert.equal(output.exitCode, expected, JSON.stringify(output));
  return output;
}

async function sandbox(t: TestContext): Promise<Box> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-processes-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { app, target, source } = await syntheticInstallation({ directory }, 'Processes');
  return { directory, target, source, candidate: { appPath: app, targetPath: target, version: null, build: null } };
}

const apply = (box: Box, env: NodeJS.ProcessEnv = {}, expected = 0) => run(box, 'apply', env, expected);

test('unrelated process churn permits managed apply and repeated apply preserves target identity', async (t) => {
  const box = await sandbox(t);
  const env = { CODEX_TEST_PROCESS_CHURN: '1' };
  const first = apply(box, env);
  assert.equal(first.data?.targets[0]?.action, 'applied');
  const patched = await readFile(box.target);
  const identity = await stat(box.target);
  const repeated = apply(box, env);
  assert.equal(repeated.data?.targets[0]?.action, 'already-applied');
  assert.deepEqual(await readFile(box.target), patched);
  assert.equal((await stat(box.target)).ino, identity.ino);
});

test('BSD and GNU column layouts preserve spaced executable paths and browser-service arguments', async (t) => {
  const active = [
    { pid: 4101, executable: '/Applications/Some Folder/Codex.app/Contents/MacOS/Codex', command: 'Codex' },
    { pid: 4102, executable: '/Applications/Some Folder/ChatGPT.app/Contents/MacOS/ChatGPT', command: 'ChatGPT' },
    { pid: 4103, executable: '/tmp/Some Folder/browser-service', command: 'browser-service' },
    { pid: 4104, executable: '/tmp/Some Folder/node', command: '"/tmp/Some Folder/node" "/tmp/Plugin Folder/browser-service.mjs" --stdio' },
  ];
  for (const layout of ['darwin', 'linux']) {
    const box = await sandbox(t);
    for (const row of active) {
      const output = apply(box, { CODEX_TEST_PROCESS_LAYOUT: layout, CODEX_TEST_PROCESS_CHURN: '1', CODEX_TEST_PROCESS_ROWS: JSON.stringify([row]) });
      const warning = output.diagnostics.find(entry => entry.code === 'PROCESSES_RUNNING');
      assert.equal(warning?.severity, 'warning');
      assert.match(warning?.message ?? '', new RegExp(String(row.pid)));
      assert.ok(warning?.message.includes(row.executable));
      assert.equal(output.data?.targets[0]?.action, 'applied');
      assert.notDeepEqual(await readFile(box.target), box.source);
      run(box, 'restore');
      assert.deepEqual(await readFile(box.target), box.source);
    }
    const harmless = [{ pid: 4110, executable: '/bin/zsh', command: 'zsh -c echo /Applications/Codex.app/Contents/MacOS/Codex browser-service.mjs' }];
    const output = apply(box, { CODEX_TEST_PROCESS_LAYOUT: layout, CODEX_TEST_PROCESS_CHURN: '1', CODEX_TEST_PROCESS_ROWS: JSON.stringify(harmless) });
    assert.equal(output.data?.targets[0]?.action, 'applied');
  }
});

test('malformed or incomplete identities and ps execution failure all fail closed before managed writes', async (t) => {
  const box = await sandbox(t);
  const identity = await stat(box.target);
  for (const malformed of ['header', 'row', 'duplicate-pid', 'truncated-comm', 'overwide-comm', 'empty-command', 'missing-self']) {
    const output = apply(box, { CODEX_TEST_PROCESS_MALFORMED: malformed }, 1);
    assert.equal(output.diagnostics[0]?.code, 'PROCESS_ENUMERATION_FAILED', malformed);
    assert.deepEqual(await readFile(box.target), box.source, malformed);
    assert.equal((await stat(box.target)).ino, identity.ino, malformed);
    await assert.rejects(access(join(box.directory, 'home/Library')));
  }
  const unavailable = apply(box, { CODEX_TEST_PROCESS_FAILURE: '1' }, 1);
  assert.equal(unavailable.diagnostics[0]?.code, 'PROCESS_ENUMERATION_FAILED');
  assert.match(unavailable.diagnostics[0]?.message ?? '', /synthetic ps unavailable/);
  await assert.rejects(access(join(box.directory, 'home/Library')));
});

test('managed restore and recover warn about running applications while unknown process state still blocks writes', async (t) => {
  const box = await sandbox(t);
  apply(box);
  const patched = await readFile(box.target);
  const identity = await stat(box.target);
  for (const command of ['restore', 'recover']) {
    assert.equal(run(box, command, { CODEX_TEST_PROCESS_FAILURE: '1' }, 1).diagnostics[0]?.code, 'PROCESS_ENUMERATION_FAILED');
    assert.deepEqual(await readFile(box.target), patched);
    assert.equal((await stat(box.target)).ino, identity.ino);
  }
  const env = { CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 4201, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', command: 'ChatGPT' }]) };
  const recovered = run(box, 'recover', env);
  assert.ok(recovered.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning'));
  assert.deepEqual(await readFile(box.target), patched);
  assert.equal((await stat(box.target)).ino, identity.ino);
  const restored = run(box, 'restore', env);
  assert.ok(restored.diagnostics.some(entry => entry.code === 'PROCESSES_RUNNING' && entry.severity === 'warning'));
  assert.ok(restored.diagnostics.some(entry => entry.code === 'RESTART_REQUIRED'));
  assert.deepEqual(await readFile(box.target), box.source);
});
