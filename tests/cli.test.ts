import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from '../src/result.js';
import { runCli, startCli } from './helpers/cli.js';
import { syntheticInstallation } from './helpers/npm-package.js';

const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));

async function sandbox(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-launcher-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory };
}

function checked(stdout: string, target: string) {
  const output: CheckResult = JSON.parse(stdout);
  assert.equal(output.command, 'check');
  assert.equal(output.exitCode, 0);
  assert.ok(output.data);
  assert.deepEqual(output.data.inspections.map(({ candidate }) => candidate.targetPath), [target]);
  assert.equal(output.data.inspections[0]?.support, 'supported');
}

test('CLI launcher keeps default discovery inside its sandbox after caller environment and cwd overrides', async (t: TestContext) => {
  const box = await sandbox(t);
  const foreign = await sandbox(t);
  const selected = await syntheticInstallation(box, 'Isolated');
  await syntheticInstallation(foreign, 'Foreign');
  const result = runCli(['check', '--json'], {
    directory: box.directory, cwd: foreign.directory, fixture,
    env: { ...process.env, HOME: foreign.directory, XDG_STATE_HOME: foreign.directory, NODE_PATH: foreign.directory },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  checked(result.stdout, selected.target);
  assert.deepEqual(await readFile(selected.target), selected.source);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
});

test('sync and async CLI launches clear host and caller Node hooks while preserving explicit fixtures', async (t: TestContext) => {
  const box = await sandbox(t);
  const selected = await syntheticInstallation(box, 'Isolated');
  const previous = process.env.CODEX_TEST_HOST_SECRET;
  process.env.CODEX_TEST_HOST_SECRET = 'must-not-reach-child';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_TEST_HOST_SECRET;
    else process.env.CODEX_TEST_HOST_SECRET = previous;
  });
  const options = {
    directory: box.directory, cwd: '/', fixture: fileURLToPath(new URL('./fixtures/launcher-state.cjs', import.meta.url)),
    env: { CODEX_TEST_SANDBOX: box.directory, NODE_OPTIONS: '--require=/must-not-load.cjs', NODE_PATH: '/must-not-load', HOME: '/', XDG_STATE_HOME: '/', PWD: '/', OLDPWD: '/' },
  };
  const sync = runCli(['check', '--json'], options);
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  checked(sync.stdout, selected.target);
  const child = startCli(['check', '--json'], options);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stdout + stderr);
  assert.equal(stderr, '');
  checked(stdout, selected.target);
  assert.deepEqual(await readFile(selected.target), selected.source);
  assert.deepEqual(await readdir(join(box.directory, 'home')), ['Applications']);
});

test('check never evaluates a discovered synthetic service', async (t: TestContext) => {
  const box = await sandbox(t);
  const marker = join(box.directory, 'must-not-exist');
  const selected = await syntheticInstallation(box, 'Inert');
  await writeFile(selected.target, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n` + selected.source.toString());
  const result = runCli(['check', '--json'], { directory: box.directory, fixture });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  checked(result.stdout, selected.target);
  assert.deepEqual(await readdir(box.directory), ['home']);
});
