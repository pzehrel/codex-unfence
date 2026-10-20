import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import * as npmPackage from './helpers/npm-package.mjs';

async function packageBox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-npx-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = npmPackage.packPackage(directory);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const [metadata] = JSON.parse(packed.stdout);
  const cwd = join(directory, 'unrelated working directory');
  await mkdir(cwd);
  return { directory, cwd, tarball: join(directory, metadata.filename) };
}

function help(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /codex-browser-patch/);
  assert.match(result.stdout, /macOS/);
  assert.match(result.stdout, /--help/);
}

function inside(root, path) {
  const suffix = relative(root, path);
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), path);
}

test('offline npm exec runs the packed public bin from an unrelated cwd with isolated final-bin boundaries', async (t) => {
  const box = await packageBox(t);
  help(npmPackage.runNpmExec(['--help'], box));
  const observed = JSON.parse(await readFile(join(box.directory, 'final-bin.json'), 'utf8'));
  inside(join(box.directory, 'npm-cache'), observed.entry);
  assert.ok(observed.entry.endsWith('/node_modules/codex-browser-liberation-patch/dist/cli.js'));
  assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
  assert.equal(observed.cwd, box.cwd);
  assert.equal(observed.home, join(box.directory, 'home'));
  assert.equal(observed.stdinTTY, false);
  assert.equal(observed.stdoutTTY, false);
});

test('packed npm exec check uses genuine structural admission and remains read-only', async (t) => {
  const box = await packageBox(t);
  const app = join(box.directory, 'home/Applications/Synthetic.app');
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  await mkdir(join(target, '..'), { recursive: true });
  const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url));
  await writeFile(target, source);
  const child = npmPackage.runNpmExec(['check', '--app', app, '--json'], box);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.data.inspection.support, 'supported');
  assert.equal(result.data.inspection.state, 'original');
  assert.deepEqual(await readFile(target), source);
  await assert.rejects(readFile(join(box.directory, 'home/Library/Application Support/codex-browser-liberation-patch/key')), { code: 'ENOENT' });
});

test('offline npm exec exposes help through a real PTY and propagates the public bin exit status', async (t) => {
  const box = await packageBox(t);
  help(await npmPackage.runNpmExecPty(['--help'], box));
  const observed = JSON.parse(await readFile(join(box.directory, 'final-bin.json'), 'utf8'));
  inside(join(box.directory, 'npm-cache'), observed.entry);
  assert.equal(observed.stdinTTY, true);
  assert.equal(observed.stdoutTTY, true);
  const invalid = await npmPackage.runNpmExecPty(['--unknown'], box);
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
});
