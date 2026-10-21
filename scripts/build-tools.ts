import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
rmSync(new URL('../.build/', import.meta.url), { recursive: true, force: true });
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const child = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.tools-build.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
if (child.error) process.stderr.write(`${child.error.message}\n`);
process.exitCode = child.status ?? 1;
