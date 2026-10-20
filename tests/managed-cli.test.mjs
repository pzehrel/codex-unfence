import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));
const service = 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs';
async function sandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'managed-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = join(directory, 'home/Applications/Synthetic.app');
  const target = join(app, service);
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
  return { directory, app, target, source };
}
function run(box, args, env = {}) {
  const child = runCli([...args, '--json'], { directory: box.directory, fixture, env });
  assert.equal(child.stderr, '', child.stderr);
  return { code: child.status, result: JSON.parse(child.stdout) };
}

test('public check reports structural support independently of write blockers and creates no recovery state', async t => {
  const box = await sandbox(t);
  const { code, result } = run(box, ['check', '--app', box.app], {
    CODEX_TEST_PROCESS_ROWS: JSON.stringify([{ pid: 987654, executable: '/Applications/Codex.app/Contents/MacOS/Codex', command: 'Codex' }]),
  });
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.command, 'check');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.data.inspection.support, 'supported');
  assert.equal(result.data.inspection.writeReadiness, 'blocked');
  assert.equal(result.data.runtime, 'not-verified');
  assert.equal(result.data.inspection.blockers[0].code, 'PROCESSES_RUNNING');
  assert.deepEqual(await readFile(box.target), box.source);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
});

test('managed status is read-only while explicit legacy selectors retain strict old parsing including equals forms', async t => {
  const box = await sandbox(t);
  const status = run(box, ['status', '--app', box.app]);
  assert.equal(status.code, 0, JSON.stringify(status));
  assert.equal(status.result.data.targets[0].state, 'original');
  for (const args of [
    ['apply', '--plan='], ['apply', '--store='], ['apply', '--plan', box.directory],
    ['apply', '--store', box.directory], ['restore', `--plan=${box.directory}`],
    ['recover', `--plan=${box.directory}`, `--store=${box.directory}`],
    ['status', `--store=${box.directory}`, '--app', box.app],
    ['apply', '--store'], ['status', '--store=', '--store', box.directory],
    ['check', '--app', box.app, '--app=' + box.app],
    ['status', '--app', box.app, '--wat'], ['check', '--app', box.app, 'extra'],
    ['check', '--', '--store=' + box.directory],
  ]) {
    const rejected = run(box, args);
    assert.equal(rejected.code, 2, JSON.stringify({ args, rejected }));
    assert.equal(rejected.result.outcome, 'usage-error');
  }
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
  assert.deepEqual(await readFile(box.target), box.source);
});

test('managed writes require real confirmation and missing status preserves its command', async t => {
  const box = await sandbox(t);
  for (const command of ['apply', 'restore', 'recover']) {
    const child = run(box, [command, '--app', box.app]);
    assert.equal(child.code, 2, JSON.stringify(child));
    assert.equal(child.result.command, command);
  }
  const missing = run(box, ['status', '--app', join(box.directory, 'missing.app')]);
  assert.equal(missing.code, 1);
  assert.equal(missing.result.command, 'status');
  assert.equal(missing.result.data, null);
  assert.deepEqual(await readFile(box.target), box.source);
});
