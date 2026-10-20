import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('packing rejects missing worktree-local bundled dependencies even when ancestors provide them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-pack-dependencies-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, 'worktree');
  const helpers = join(repository, 'tests/helpers');
  const destination = join(directory, 'packages');
  await mkdir(helpers, { recursive: true });
  await mkdir(destination);
  await writeFile(join(repository, 'package.json'), JSON.stringify({
    name: 'synthetic-package', version: '1.0.0', type: 'module',
    dependencies: { 'synthetic-bundled': '1.0.0' }, bundleDependencies: ['synthetic-bundled'],
  }));
  const ancestorDependency = join(directory, 'node_modules/synthetic-bundled');
  await mkdir(ancestorDependency, { recursive: true });
  await writeFile(join(ancestorDependency, 'package.json'), JSON.stringify({ name: 'synthetic-bundled', version: '1.0.0' }));
  await copyFile(new URL('./helpers/npm-package.mjs', import.meta.url), join(helpers, 'npm-package.mjs'));
  const { packPackage } = await import(pathToFileURL(join(helpers, 'npm-package.mjs')).href);

  assert.throws(() => packPackage(destination), (error) => {
    assert.match(error.message, /Missing worktree-local bundled dependencies: synthetic-bundled/);
    assert.ok(error.message.includes(repository));
    assert.match(error.message, /npm ci --ignore-scripts/);
    return true;
  });
  assert.deepEqual(await readdir(destination), []);
});
