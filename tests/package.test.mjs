import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));

test('packed npm CLI installs offline into a temporary prefix and executes through its public bin', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'codex-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = await realpath(temporary);
  const env = { ...process.env, HOME: directory, NODE_OPTIONS: '', npm_config_cache: join(directory, 'npm-cache') };
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
    cwd: repository, env, encoding: 'utf8',
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [output] = JSON.parse(pack.stdout);
  assert.deepEqual(output.files.map((file) => file.path).sort(), [
    'README.md', 'dist/cli.js', 'dist/discovery.js', 'dist/result.js', 'package.json',
  ]);
  const prefix = join(directory, 'installation');
  const install = spawnSync('npm', [
    'install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(directory, output.filename),
  ], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const binary = join(prefix, 'bin/codex-browser-patch');
  const help = spawnSync(binary, ['--help'], { cwd: directory, env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /macOS/);
  const root = join(directory, 'plugins');
  await mkdir(root);
  // The explicit process fixture is test-only and absent from the package.
  // It allows the discovery contract to run on Linux CI without production bypass flags.
  const fixture = fileURLToPath(new URL('./fixtures/darwin.cjs', import.meta.url));
  const detection = spawnSync(process.execPath, ['--require', fixture, binary, 'detect', '--plugin-root', root, '--json'], {
    cwd: directory, env, encoding: 'utf8',
  });
  assert.equal(detection.status, 0, detection.stderr);
  assert.deepEqual(JSON.parse(detection.stdout).data.artifacts, []);
});
