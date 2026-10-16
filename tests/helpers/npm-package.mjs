import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// The only non-CLI subprocess boundary: fixed offline package operations, never arbitrary commands.
export function packPackage(directory) {
  return npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], directory, repository);
}

export function installPackage(directory, prefix, tarball) {
  return npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball], directory, directory);
}
