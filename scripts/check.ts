import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const usage = 'Usage: pnpm run check --base <ref> [--whitespace-only]\nChecks tracked changes against the explicit base, then typecheck, lint and tests (including build).\n';
const args = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n${usage}`);
  process.exit(2);
}

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(usage);
  process.exit(0);
}
const whitespaceOnly = args.includes('--whitespace-only');
const options = args.filter((arg) => arg !== '--whitespace-only');
if (options.length !== 2 || options[0] !== '--base' || args.length !== (whitespaceOnly ? 3 : 2)) fail('An explicit --base is required.');
const base = options[1];
if (!base || !/^[a-zA-Z0-9][a-zA-Z0-9._/@~^+-]*$/.test(base)) fail('Invalid base ref.');
const resolved = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`], { encoding: 'utf8' });
if (resolved.status !== 0) fail(`Invalid base ref: ${base}`);
const tree = resolved.stdout.trim();
if (!/^[a-f0-9]{40,64}$/.test(tree)) fail(`Invalid base tree: ${base}`);

function run(command: string, commandArgs: string[]): void {
  const child = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false });
  if (child.error) process.stderr.write(`${child.error.message}\n`);
  if (child.status !== 0) process.exit(child.status ?? 1);
}

function engineeringPolicy(): void {
  function reject(message: string): never {
    process.stderr.write(`Engineering policy: ${message}\n`);
    process.exit(1);
  }
  function objectFile(path: string): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch { return reject(`pnpm/TypeScript requires a valid ${path}.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(`pnpm/TypeScript requires an object in ${path}.`);
    return value as Record<string, unknown>;
  }
  const metadata = objectFile('package.json');
  if (typeof metadata.packageManager !== 'string' || !/^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?$/.test(metadata.packageManager)) reject('pnpm must have an exact packageManager version.');
  if (!existsSync('pnpm-lock.yaml') || existsSync('package-lock.json') || existsSync('npm-shrinkwrap.json')) reject('pnpm-lock.yaml must be the only package manager lockfile.');
  const configuration = objectFile('tsconfig.json');
  const tools = objectFile('tsconfig.tools.json');
  const compiler = configuration.compilerOptions;
  const toolCompiler = tools.compilerOptions;
  if (!compiler || typeof compiler !== 'object' || Array.isArray(compiler)
    || !toolCompiler || typeof toolCompiler !== 'object' || Array.isArray(toolCompiler)
    || tools.extends !== './tsconfig.json') reject('TypeScript tools must extend the strict source configuration.');
  for (const option of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
    if ((compiler as Record<string, unknown>)[option] !== true || (toolCompiler as Record<string, unknown>)[option] === false) reject(`TypeScript ${option} must remain enabled.`);
  }
  const ignored = new Set(['.git', '.claude', 'node_modules', 'dist', '.build', 'evidence', 'patch-plans']);
  const prohibited = new Set(['.js', '.mjs', '.cjs', '.jsx', '.py', '.exp', '.sh']);
  function scan(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (prohibited.has(extname(entry.name))) reject(`TypeScript is required for maintained code: ${path}`);
    }
  }
  scan('.');
}

// Resolve the caller's ref first, then pass only a verified object ID to diff.
run('git', ['diff', '--check', tree, '--']);
if (!whitespaceOnly) {
  engineeringPolicy();
  const pnpm = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.cjs');
  for (const script of ['typecheck', 'lint', 'test']) run(process.execPath, [pnpm, 'run', script]);
}
