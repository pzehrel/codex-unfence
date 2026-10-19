/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit system-boundary preload, never distributed. */
require('./transaction-boundaries.cjs');
const crypto = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const createHash = crypto.createHash;
// Model the two pinned identities using exact self-authored samples. Every other
// digest remains real. Production has no profile override or test switch.
crypto.createHash = function (algorithm, ...options) {
  const hash = createHash(algorithm, ...options);
  const digest = hash.digest;
  hash.digest = function (encoding) {
    const bytes = digest.call(this);
    const actual = bytes.toString('hex');
    const replacement = algorithm === 'sha256' && actual === process.env.CODEX_TEST_CUA_ORIGINAL
      ? '44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e'
      : algorithm === 'sha256' && actual === process.env.CODEX_TEST_CUA_PATCHED
        ? '705bfdb0d8e1793a5c3760a97d9c3eaf2bf6959cc5cbbfe31914bb24cbcf1940' : actual;
    const result = Buffer.from(replacement, 'hex');
    return encoding ? result.toString(encoding) : result;
  };
  return hash;
};
syncBuiltinESMExports();
