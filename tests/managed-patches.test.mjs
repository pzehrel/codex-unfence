import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

const binary = fileURLToPath(new URL('./fixtures/managed-patches-driver.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));
const service = 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs';
async function sandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'managed-patches-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'home/Applications'), { recursive: true });
  return { directory };
}
async function installation(box, name, version) {
  const appPath = join(box.directory, 'home/Applications', name + '.app');
  const targetPath = join(appPath, service);
  await mkdir(join(targetPath, '..'), { recursive: true });
  await writeFile(targetPath, '// synthetic, never evaluated\n');
  await writeFile(join(appPath, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>999</string></dict></plist>`);
  return { appPath, targetPath };
}
function run(box, command, payload = {}, env = {}) {
  const result = runCli([command, JSON.stringify(payload)], { binary, fixture, directory: box.directory, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('discovery returns every CUA installation without selecting by version and changes no files', async t => {
  const box = await sandbox(t);
  const first = await installation(box, 'Codex', '999.0');
  const second = await installation(box, 'ChatGPT', '1.0');
  const before = await readFile(first.targetPath);
  const report = run(box, 'discover');
  assert.equal(report.selection, 'required');
  assert.deepEqual(report.candidates.map(({ appPath, targetPath }) => ({ appPath, targetPath })).sort((a, b) => a.appPath.localeCompare(b.appPath)), [first, second].sort((a, b) => a.appPath.localeCompare(b.appPath)));
  assert.deepEqual(report.candidates.map(candidate => candidate.version).sort(), ['1.0', '999.0']);
  assert.deepEqual(await readFile(first.targetPath), before);
  assert.deepEqual((await readdir(join(box.directory, 'home'))).sort(), ['Applications']);
  assert.equal(report.runtime, 'not-verified');
});

test('explicit discovery reports missing installations and refuses symlink or hardlink aliases', async t => {
  const box = await sandbox(t);
  assert.equal(run(box, 'discover').selection, 'none');
  assert.equal(run(box, 'discover', { appPath: join(box.directory, 'missing.app') }).diagnostics[0].code, 'ENOENT');
  const selected = await installation(box, 'Selected', 'unlisted-version');
  assert.equal(run(box, 'discover', { appPath: selected.appPath }).candidates[0].version, 'unlisted-version');
  const alias = join(box.directory, 'Alias.app');
  await symlink(selected.appPath, alias);
  assert.equal(run(box, 'discover', { appPath: alias }).diagnostics[0].code, 'PATH_ALIAS');
  await link(selected.targetPath, selected.targetPath + '.alias');
  assert.equal(run(box, 'discover', { appPath: selected.appPath }).diagnostics[0].code, 'PATH_ALIAS');
  assert.deepEqual((await readdir(join(box.directory, 'home'))).sort(), ['Applications']);
});
