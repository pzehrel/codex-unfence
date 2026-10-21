export {};
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require boundary fixture is deliberately CommonJS. */
// Explicit filesystem boundary fixture, loaded only by synthetic child CLI tests.
// Not distributed. Production CLI has no fault injection or safety bypass flag.
const fs: typeof import('node:fs') = require('node:fs');
const promises: typeof import('node:fs/promises') = require('node:fs/promises');
const { syncBuiltinESMExports }: typeof import('node:module') = require('node:module');
const { join }: typeof import('node:path') = require('node:path');
Object.defineProperty(process, 'platform', { value: 'darwin' });

const mode = process.env.CODEX_TEST_PREPARE_FAULT;
const output = process.env.CODEX_TEST_PREPARE_OUTPUT ?? '';
const target = process.env.CODEX_TEST_PREPARE_TARGET;
const open = promises.open;
const mkdir = promises.mkdir;
const rename = promises.rename;
const link = promises.link;

promises.open = async function (path, ...options) {
  if (mode === 'second-artifact' && String(path).endsWith('0001.patched.mjs') && options[0] === 'wx') {
    throw Object.assign(new Error('synthetic second artifact failure'), { code: 'EIO' });
  }
  if (mode === 'source-changed' && String(path).endsWith('manifest.json') && options[0] === 'wx') {
    fs.appendFileSync(target ?? '', '\n// changed during preparation\n');
  }
  return open(path, ...options);
};
promises.mkdir = async function (this: unknown, path: Parameters<typeof mkdir>[0], ...options: unknown[]) {
  if (mode === 'race-output' && path === output) {
    fs.mkdirSync(output);
    fs.writeFileSync(join(output, 'other-owner'), 'preserve competing output');
  }
  return Reflect.apply(mkdir, this, [path, ...options]);
} as typeof promises.mkdir;
promises.rename = async function (from, to) {
  if (mode === 'replaced-reservation' && to === join(output, 'contents')) {
    fs.renameSync(output, `${output}-reserved`);
    fs.mkdirSync(output);
    fs.writeFileSync(join(output, 'other-owner'), 'preserve replacement');
    throw Object.assign(new Error('synthetic replaced reservation'), { code: 'EIO' });
  }
  return rename(from, to);
};
promises.link = async function (from, to) {
  if (mode === 'publish-marker' && to === join(output, 'complete.json')) {
    throw Object.assign(new Error('synthetic marker publication failure'), { code: 'EIO' });
  }
  return link(from, to);
};
syncBuiltinESMExports();
