/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require boundary fixture is deliberately CommonJS. */
// Explicit filesystem boundary fixture, loaded only by synthetic child CLI tests.
// Not distributed. Production CLI has no fault injection or safety bypass flag.
const fs = require('node:fs');
const promises = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');
Object.defineProperty(process, 'platform', { value: 'darwin' });

const mode = process.env.CODEX_TEST_PREPARE_FAULT;
const output = process.env.CODEX_TEST_PREPARE_OUTPUT;
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
    fs.appendFileSync(target, '\n// changed during preparation\n');
  }
  return open(path, ...options);
};
promises.mkdir = async function (path, ...options) {
  if (mode === 'race-output' && path === output) {
    fs.mkdirSync(output);
    fs.writeFileSync(join(output, 'other-owner'), 'preserve competing output');
  }
  return mkdir(path, ...options);
};
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
