import { spawn, spawnSync } from 'node:child_process';
import type { SpawnOptions, SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { repositoryRoot, sourceFixture } from './paths.js';

export interface NpmExecOptions { directory: string; cwd: string; tarball: string }
export interface PtyStep { waitFor: string; send: string; beforeSend?: () => void | Promise<void> }
export interface NpmPtyOptions extends NpmExecOptions { steps?: readonly PtyStep[] }
export interface PtyResult { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function npm(args: readonly string[], directory: string, cwd: string): SpawnSyncReturns<string> {
  return spawnSync('npm', args, {
    cwd, encoding: 'utf8', shell: false,
    env: {
      PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'store'),
      NODE_OPTIONS: '', NODE_PATH: '', npm_config_cache: join(directory, 'npm-cache'), npm_config_update_notifier: 'false',
    },
  });
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return Boolean(suffix) && !suffix.startsWith('..') && !isAbsolute(suffix);
}

function execInvocation(args: readonly string[], { directory, cwd, tarball }: NpmExecOptions): [string, string[], SpawnOptions & { encoding: 'utf8' }] {
  const root = realpathSync(directory);
  const working = realpathSync(cwd);
  const archive = realpathSync(tarball);
  if (!contained(realpathSync(tmpdir()), root) || !contained(root, working)
    || !contained(root, archive) || !archive.endsWith('.tgz')) {
    throw new Error('npx requires a local tarball and cwd inside its temporary sandbox.');
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('npx requires CLI string arguments.');
  }
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'npm-prefix'), { recursive: true });
  const userconfig = join(root, 'npm-user.config');
  const globalconfig = join(root, 'npm-global.config');
  writeFileSync(userconfig, '');
  writeFileSync(globalconfig, '');
  const fixture = fileURLToPath(new URL('../fixtures/npx-final-bin.cjs', import.meta.url));
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return ['npx', [
    '--userconfig', userconfig, '--globalconfig', globalconfig,
    '--cache', join(root, 'npm-cache'), '--prefix', join(root, 'npm-prefix'),
    `--node-options=--require=${JSON.stringify(fixture)}`,
    '--offline', '--yes', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package', archive, 'codex-unfence', ...args,
  ], {
    cwd: working, encoding: 'utf8', shell: false, timeout: 30_000,
    env: {
      ...inherited, HOME: home, XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
      PWD: working, OLDPWD: working, NODE_OPTIONS: '', NODE_PATH: '',
      CODEX_NPX_SANDBOX: root, npm_config_update_notifier: 'false',
    },
  }];
}

export async function syntheticInstallation(box: { directory: string }, name: string, source?: string | Buffer) {
  const app = join(box.directory, 'home/Applications', `${name}.app`);
  const target = join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs');
  const bytes = source ?? await readFile(sourceFixture('deferred-site-status.js.txt'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, bytes, { mode: 0o640 });
  return { app, target, source: bytes };
}

export function runNpmExec(args: readonly string[], options: NpmExecOptions): SpawnSyncReturns<string> {
  return spawnSync(...execInvocation(args, options));
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runNpmExecPty(args: readonly string[], options: NpmPtyOptions): Promise<PtyResult> {
  const [command, argv, spawnOptions] = execInvocation(args, options);
  // macOS script requires an anonymous pipe as input. Node 'pipe' uses a
  // socketpair, so a fixed shell pipeline supplies the pipe; all arguments are
  // passed through "$@", never interpolated into shell source. The last command's
  // exit status is script's child status on macOS and with -e on Linux.
  const [driver, driverArgs] = process.platform === 'darwin'
    ? ['/bin/sh', ['-c', '(/bin/cat <&0 &) | /usr/bin/script -q /dev/null "$@"', 'npm-pty', command, ...argv]]
    : ['/usr/bin/script', ['-q', '-e', '-f', '-c', [command, ...argv].map(shellWord).join(' '), '/dev/null']];
  return new Promise((resolve, reject) => {
    const withoutTimeout = { ...spawnOptions };
    delete withoutTimeout.timeout;
    const child = spawn(driver, driverArgs, {
      ...withoutTimeout, detached: true,
      env: { ...spawnOptions.env, TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    let step = 0;
    const steps = options.steps ?? [];
    function kill() {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
    // The forwarding cat must not keep the session alive after script exits.
    child.on('exit', () => { child.stdin.destroy(); });
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`npx PTY timed out: ${stdout}${stderr}`));
    }, 30_000);
    let sending = false;
    async function respond() {
      if (sending) return;
      sending = true;
      try {
        for (let current = steps[step]; current && stdout.includes(current.waitFor); current = steps[step]) {
          step++;
          if (current.beforeSend) await current.beforeSend();
          child.stdin.write(current.send);
        }
      } catch (error) {
        kill();
        reject(error);
      } finally { sending = false; }
    }
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
      void respond();
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

// Fixed offline package operations and the public npx bin, never arbitrary commands.
// Callers must complete a clean product build before packing without lifecycle scripts.
export function packPackage(directory: string): SpawnSyncReturns<string> {
  const metadata: { bundleDependencies: string[] } = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  const missing = metadata.bundleDependencies.filter(name => !existsSync(join(repositoryRoot, 'node_modules', name, 'package.json')));
  if (missing.length) {
    throw new Error(`Missing worktree-local bundled dependencies: ${missing.join(', ')}. Run pnpm install --frozen-lockfile --ignore-scripts in ${repositoryRoot} before packaging.`);
  }
  const pnpm = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.cjs');
  const packed = spawnSync(process.execPath, [pnpm, '--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', directory], {
    cwd: repositoryRoot, encoding: 'utf8', shell: false,
    env: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'store'), NODE_OPTIONS: '', NODE_PATH: '' },
  });
  if (packed.status === 0) {
    const output: unknown = JSON.parse(packed.stdout);
    // pnpm emits one object; the public package tests historically consume an array.
    const records: unknown[] = Array.isArray(output) ? output : [output];
    const normalized = JSON.stringify(records.map(record => {
      if (!record || typeof record !== 'object' || !('filename' in record) || typeof record.filename !== 'string') {
        throw new Error('pnpm pack did not report its tarball filename.');
      }
      return { ...record, filename: basename(record.filename) };
    }));
    return { ...packed, stdout: normalized, output: [packed.output[0] ?? null, normalized, packed.stderr] };
  }
  return packed;
}

export function installPackage(directory: string, prefix: string, tarball: string): SpawnSyncReturns<string> {
  return npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball], directory, directory);
}
