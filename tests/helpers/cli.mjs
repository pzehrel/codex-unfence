import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const darwin = fileURLToPath(new URL('../fixtures/darwin.cjs', import.meta.url));
const temporaryRoot = realpathSync(tmpdir());

function invocation(args, { directory, binary = cli, fixture = darwin, direct = false, env = {}, ...options }) {
  const cwd = realpathSync(directory);
  const path = relative(temporaryRoot, cwd);
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('CLI tests require a directory inside the system temporary directory.');
  // Inherit only host essentials. Caller overrides cannot restore home, state, cwd or Node hooks.
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const isolated = {
    ...inherited, ...env,
    HOME: join(cwd, 'home'), XDG_STATE_HOME: join(cwd, 'store'),
    XDG_CONFIG_HOME: join(cwd, 'config'), XDG_CACHE_HOME: join(cwd, 'cache'), XDG_DATA_HOME: join(cwd, 'data'),
    PWD: cwd, OLDPWD: cwd, NODE_OPTIONS: '', NODE_PATH: '',
  };
  return [direct ? binary : process.execPath,
    direct ? args : [...(fixture ? ['--require', fixture] : []), binary, ...args],
    { ...options, encoding: 'utf8', cwd, env: isolated, shell: false }];
}

export function runCli(args, options) {
  return spawnSync(...invocation(args, options));
}

export function startCli(args, options) {
  return spawn(...invocation(args, options));
}
