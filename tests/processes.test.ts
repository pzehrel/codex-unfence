import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { OperationResult } from '../src/result.js';
import { runCli } from './helpers/cli.js';
import { sourceFixture } from './helpers/paths.js';

const fixture = fileURLToPath(new URL('./fixtures/transaction-boundaries.cjs', import.meta.url));
const source = await readFile(sourceFixture('site-status.js.txt'), 'utf8');

type Box = { directory: string; target: string; plan: string; store: string };

function run(box: Box, args: string[], env: NodeJS.ProcessEnv = {}, expected = 0): OperationResult {
  const result = runCli([...args, '--json'], { directory: box.directory, fixture, env });
  assert.equal(result.status, expected, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const output: OperationResult = JSON.parse(result.stdout);
  assert.equal(output.exitCode, expected);
  return output;
}

async function sandbox(t: TestContext): Promise<Box> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-processes-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'plugins/browser/synthetic/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source, { mode: 0o640 });
  const box = { directory, target, plan: join(directory, 'plan'), store: join(directory, 'store') };
  run(box, ['prepare', '--plugin-root', join(directory, 'plugins'), '--target', target, '--output', box.plan]);
  return box;
}

const apply = (box: Box, env: NodeJS.ProcessEnv = {}, expected = 0) =>
  run(box, ['apply', '--plan', box.plan, '--store', box.store], env, expected);

test('unrelated process churn permits apply and a repeated apply preserves target identity', async (t) => {
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
  await access(box.store);
});

test('BSD and GNU column layouts preserve spaced executable paths and browser-service arguments', async (t) => {
  const blockers = [
    { pid: 4101, executable: '/Applications/Some Folder/Codex.app/Contents/MacOS/Codex', command: 'Codex' },
    { pid: 4102, executable: '/Applications/Some Folder/ChatGPT.app/Contents/MacOS/ChatGPT', command: 'ChatGPT' },
    { pid: 4103, executable: '/tmp/Some Folder/browser-service', command: 'browser-service' },
    { pid: 4104, executable: '/tmp/Some Folder/node', command: '"/tmp/Some Folder/node" "/tmp/Plugin Folder/browser-service.mjs" --stdio' },
  ];
  for (const layout of ['darwin', 'linux']) {
    const box = await sandbox(t);
    for (const row of blockers) {
      const output = apply(box, { CODEX_TEST_PROCESS_LAYOUT: layout, CODEX_TEST_PROCESS_CHURN: '1', CODEX_TEST_PROCESS_ROWS: JSON.stringify([row]) }, 4);
      assert.equal(output.diagnostics[0]?.code, 'PROCESSES_RUNNING');
      assert.match(output.diagnostics[0]?.message ?? '', new RegExp(String(row.pid)));
      assert.equal(await readFile(box.target, 'utf8'), source);
      await assert.rejects(access(box.store));
    }
    const harmless = [{ pid: 4110, executable: '/bin/zsh', command: 'zsh -c echo /Applications/Codex.app/Contents/MacOS/Codex browser-service.mjs' }];
    const output = apply(box, { CODEX_TEST_PROCESS_LAYOUT: layout, CODEX_TEST_PROCESS_CHURN: '1', CODEX_TEST_PROCESS_ROWS: JSON.stringify(harmless) });
    assert.equal(output.data?.targets[0]?.action, 'applied');
  }
});

test('malformed or incomplete identities and ps execution failure all fail closed before writes', async (t) => {
  const box = await sandbox(t);
  const identity = await stat(box.target);
  for (const malformed of ['header', 'row', 'duplicate-pid', 'truncated-comm', 'overwide-comm', 'empty-command', 'missing-self']) {
    const output = apply(box, { CODEX_TEST_PROCESS_MALFORMED: malformed }, 1);
    assert.equal(output.diagnostics[0]?.code, 'PROCESS_ENUMERATION_FAILED', malformed);
    assert.equal(await readFile(box.target, 'utf8'), source, malformed);
    assert.equal((await stat(box.target)).ino, identity.ino, malformed);
    await assert.rejects(access(box.store));
  }
  const unavailable = apply(box, { CODEX_TEST_PROCESS_FAILURE: '1' }, 1);
  assert.equal(unavailable.diagnostics[0]?.code, 'PROCESS_ENUMERATION_FAILED');
  assert.match(unavailable.diagnostics[0]?.message ?? '', /synthetic ps unavailable/);
  await assert.rejects(access(box.store));
});
