import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const darwin = fileURLToPath(new URL('./fixtures/darwin.cjs', import.meta.url));
const home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-test-home-')));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

function run(args, options = {}, fixture = darwin) {
  return spawnSync(process.execPath, ['--require', fixture, cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NODE_OPTIONS: '' },
    ...options,
  });
}

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

test('installed command help states macOS discovery and current limits', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /detect/);
  assert.match(result.stdout, /--plugin-root/);
  assert.match(result.stdout, /macOS/);
  assert.match(result.stdout, /not analyzed/);
  assert.equal(result.stderr, '');
});

async function artifact(root, plugin, version) {
  const path = join(root, plugin, version, 'scripts/browser-service.mjs');
  await mkdir(join(root, plugin, version, 'scripts'), { recursive: true });
  // This is synthetic data, never imported or executed by discovery.
  await writeFile(path, 'throw new Error("Discovery must never execute this bundle");\n');
  return path;
}

test('enumerates every browser/chrome version and actual symlink paths without executing or changing sources', async (t) => {
  const directory = await sandbox(t);
  const root = join(directory, 'plugins');
  const first = await artifact(root, 'browser', '9.0');
  const second = await artifact(root, 'browser', '10.0');
  const third = await artifact(root, 'chrome', 'unlisted-version');
  await artifact(root, 'unrelated', '99');
  await symlink(join(root, 'browser', '9.0'), join(root, 'browser', 'linked'));
  const result = run(['detect', '--plugin-root', root, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.data.artifacts, [
    { plugin: 'browser', version: '10.0', path: second, realPath: second, availability: 'readable', compatibility: 'not-analyzed' },
    { plugin: 'browser', version: '9.0', path: first, realPath: first, availability: 'readable', compatibility: 'not-analyzed' },
    { plugin: 'browser', version: 'linked', path: join(root, 'browser/linked/scripts/browser-service.mjs'), realPath: first, availability: 'readable', compatibility: 'not-analyzed' },
    { plugin: 'chrome', version: 'unlisted-version', path: third, realPath: third, availability: 'readable', compatibility: 'not-analyzed' },
  ]);
  assert.deepEqual(output.diagnostics, []);
  assert.equal(output.data.runtime, 'not-verified');
  assert.equal(await readFile(first, 'utf8'), 'throw new Error("Discovery must never execute this bundle");\n');
  assert.deepEqual(await readdir(directory), ['plugins']);
  const human = run(['detect', '--plugin-root', root]);
  assert.equal(human.status, output.exitCode);
  for (const entry of output.data.artifacts) {
    assert.ok(human.stdout.includes(`${entry.plugin} ${entry.version}: ${entry.realPath}`));
  }
  assert.match(human.stdout, /not-analyzed/);
  assert.match(human.stdout, /Versions do not identify the running installation/);
});

test('invalid CLI input uses usage-error 2 and a single JSON diagnostic', () => {
  for (const args of [[], ['prepare'], ['detect', '--wat'], ['detect', '--plugin-root'], ['detect', '--plugin-root', '--json'], ['detect', 'extra'], ['detect', '--json', '--json'], ['detect', '--plugin-root', 'a', '--plugin-root', 'b'], ['detect', '--plugin-root=']]) {
    const result = run([...args, ...(args.includes('--json') ? [] : ['--json'])]);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout} ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.schemaVersion, 1);
    assert.equal(output.outcome, 'usage-error');
    assert.equal(output.exitCode, 2);
    assert.equal(output.data, null);
    assert.equal(output.diagnostics[0].code, 'INVALID_ARGUMENTS');
    assert.equal(result.stderr, '');
  }
});

test('unsupported platform returns runtime-error before inspecting targets', () => {
  const fixture = fileURLToPath(new URL('./fixtures/unsupported.cjs', import.meta.url));
  const result = run(['detect', '--plugin-root', '/must-not-be-inspected', '--json'], {}, fixture);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1, command: 'detect', outcome: 'runtime-error', exitCode: 1, data: null,
    diagnostics: [{ code: 'UNSUPPORTED_PLATFORM', severity: 'error', message: 'Only macOS is supported; received linux.' }],
  });
});

test('missing roots are empty while files and unavailable artifacts report runtime failure', async (t) => {
  const root = await sandbox(t);
  const missing = run(['detect', '--plugin-root', join(root, 'missing'), '--json']);
  assert.equal(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).diagnostics[0].code, 'NO_ARTIFACTS');
  const file = join(root, 'not-a-root');
  await writeFile(file, 'ordinary file');
  const badRoot = run(['detect', '--plugin-root', file, '--json']);
  assert.equal(badRoot.status, 1);
  assert.equal(JSON.parse(badRoot.stdout).diagnostics[0].code, 'ROOT_UNAVAILABLE');
  await mkdir(join(root, 'browser/unfinished/scripts'), { recursive: true });
  const failed = run(['detect', '--plugin-root', root, '--json']);
  assert.equal(failed.status, 1);
  const output = JSON.parse(failed.stdout);
  assert.equal(output.data.artifacts[0].availability, 'unavailable');
  assert.equal(output.data.artifacts[0].compatibility, 'not-analyzed');
  assert.equal(output.diagnostics[0].code, 'ARTIFACT_UNAVAILABLE');
  assert.equal(output.diagnostics[0].systemCode, 'ENOENT');
});

test('default root uses the isolated home and never selects a running version', async () => {
  const root = join(home, '.codex/plugins/cache/openai-bundled');
  const path = await artifact(root, 'browser', 'synthetic-default');
  const result = run(['detect', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.pluginRoot, root);
  assert.equal(output.data.artifacts[0].path, path);
  assert.equal(output.data.runtime, 'not-verified');
});

test('unreadable targets retain partial discovery and a stable permission diagnostic', async (t) => {
  const root = await sandbox(t);
  const unreadable = await artifact(root, 'browser', 'unreadable');
  await artifact(root, 'chrome', 'readable');
  await chmod(unreadable, 0);
  const result = run(['detect', '--plugin-root', root, '--json']);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.artifacts[0].availability, 'unavailable');
  assert.equal(output.data.artifacts[1].availability, 'readable');
  assert.equal(output.diagnostics[0].code, 'ARTIFACT_UNAVAILABLE');
  assert.equal(output.diagnostics[0].systemCode, 'EACCES');
  const human = run(['detect', '--plugin-root', root]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /ARTIFACT_UNAVAILABLE/);
  assert.match(human.stdout, /EACCES/);
});

test('empty explicit plugin root returns a versioned read-only JSON result', async (t) => {
  const root = await sandbox(t);
  const result = run(['detect', '--plugin-root', root, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: 'detect',
    outcome: 'success',
    exitCode: 0,
    data: { pluginRoot: root, artifacts: [], runtime: 'not-verified' },
    diagnostics: [{ code: 'NO_ARTIFACTS', severity: 'info', message: 'No browser/chrome artifacts found.', path: root }],
  });
  assert.equal(result.stderr, '');
});
