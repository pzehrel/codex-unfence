import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

const repository = fileURLToPath(new URL('../..', import.meta.url));

function npm(args, directory, cwd) {
  return spawnSync('npm', args, {
    cwd, encoding: 'utf8', shell: false,
    env: {
      PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'store'),
      NODE_OPTIONS: '', NODE_PATH: '', npm_config_cache: join(directory, 'npm-cache'),
    },
  });
}

function contained(root, path) {
  const suffix = relative(root, path);
  return suffix && !suffix.startsWith('..') && !isAbsolute(suffix);
}

function execInvocation(args, { directory, cwd, tarball }) {
  const root = realpathSync(directory);
  const working = realpathSync(cwd);
  const archive = realpathSync(tarball);
  if (!contained(realpathSync(tmpdir()), root) || !contained(root, working)
    || !contained(root, archive) || !archive.endsWith('.tgz')) {
    throw new Error('npm exec requires a local tarball and cwd inside its temporary sandbox.');
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('npm exec requires CLI string arguments.');
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
  return ['npm', [
    '--userconfig', userconfig, '--globalconfig', globalconfig,
    '--cache', join(root, 'npm-cache'), '--prefix', join(root, 'npm-prefix'),
    `--node-options=--require=${JSON.stringify(fixture)}`,
    'exec', '--offline', '--yes', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package', archive, '--', 'codex-browser-patch', ...args,
  ], {
    cwd: working, encoding: 'utf8', shell: false, timeout: 30_000,
    env: {
      ...inherited, HOME: home, XDG_STATE_HOME: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
      PWD: working, OLDPWD: working, NODE_OPTIONS: '', NODE_PATH: '',
      CODEX_NPX_SANDBOX: root,
    },
  }];
}

export function runNpmExec(args, options) {
  return spawnSync(...execInvocation(args, options));
}

function shellWord(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runNpmExecPty(args, options) {
  const [command, argv, spawnOptions] = execInvocation(args, options);
  const [driver, driverArgs] = process.platform === 'darwin'
    ? ['/usr/bin/expect', [fileURLToPath(new URL('./npm-exec-pty.exp', import.meta.url)), command, ...argv]]
    : ['/usr/bin/script', ['-q', '-e', '-f', '-c', [command, ...argv].map(shellWord).join(' '), '/dev/null']];
  return new Promise((resolve, reject) => {
    const child = spawn(driver, driverArgs, {
      ...spawnOptions, timeout: undefined, detached: true,
      env: { ...spawnOptions.env, TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    let step = 0;
    const steps = options.steps ?? [];
    const timer = setTimeout(() => {
      process.kill(-child.pid, 'SIGKILL');
      reject(new Error(`npm exec PTY timed out: ${stdout}${stderr}`));
    }, 30_000);
    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text;
      while (steps[step] && stdout.includes(steps[step].waitFor)) child.stdin.write(steps[step++].send);
    });
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

// Fixed offline package operations and the public npm exec bin, never arbitrary commands.
export function packPackage(directory) {
  return npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], directory, repository);
}

export function installPackage(directory, prefix, tarball) {
  return npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball], directory, directory);
}
