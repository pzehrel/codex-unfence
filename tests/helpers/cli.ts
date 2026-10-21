import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessByStdio, SpawnOptions, SpawnSyncReturns } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { publishedCli } from './paths.js';

const darwin = fileURLToPath(new URL('../fixtures/darwin.cjs', import.meta.url));
const temporaryRoot = realpathSync(tmpdir());

export interface CliOptions extends Omit<SpawnOptions, 'env'> {
  directory: string;
  binary?: string;
  fixture?: string | null;
  direct?: boolean;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}
export type CliResult = SpawnSyncReturns<string>;
export type CliChild = ChildProcessByStdio<Writable, Readable, Readable>;

function invocation(args: readonly string[], { directory, binary = publishedCli, fixture = darwin, direct = false, env = {}, ...options }: CliOptions): [string, readonly string[], SpawnOptions & { encoding: 'utf8' }] {
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

export function runCli(args: readonly string[], options: CliOptions): CliResult {
  return spawnSync(...invocation(args, options));
}

export function startCli(args: readonly string[], options: CliOptions): CliChild {
  const [command, argv, spawnOptions] = invocation(args, options);
  // Every caller uses piped streams, optionally adding an IPC channel. Node's generic
  // overload cannot express that fourth channel without widening all three streams.
  return spawn(command, argv, spawnOptions) as CliChild;
}
