import { spawnSync } from 'node:child_process';

const usage = 'Usage: npm run check -- --base <ref> [--whitespace-only]\nChecks tracked changes against the explicit base, then typecheck, lint and tests (including build).\n';
const args = process.argv.slice(2);

function fail(message) {
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

function run(command, commandArgs) {
  const child = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false });
  if (child.error) process.stderr.write(`${child.error.message}\n`);
  if (child.status !== 0) process.exit(child.status ?? 1);
}

// Resolve the caller's ref first, then pass only a verified object ID to diff.
run('git', ['diff', '--check', tree, '--']);
if (!whitespaceOnly) {
  for (const script of ['typecheck', 'lint', 'test']) run('npm', ['run', script]);
}
