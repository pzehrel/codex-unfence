#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { transactionExecutor } from '../dist/transaction-engine.js';
import { blockingProcesses } from '../dist/processes.js';
import { canonical, digest } from '../dist/integrity.js';
import { canonicalDirectory, check, regularBytes, syncDirectory, writeExclusive } from '../dist/transaction-storage.js';
import { renderHuman } from '../dist/result.js';
import { derivePinned, preparationManifest, preparationDiff, profile } from './cua-wrapper-recipe.mjs';

const scheme = profile.id;
const files = ['local-diff.txt', 'manifest.json', 'source.original.mjs', 'source.patched.mjs'];
const usage = `Repository-local pinned CUA wrapper operations (run npm run build first).
Usage: node scripts/cua-wrapper-operations.mjs apply|status|restore --preparation ABS --target ABS --store ABS [--json]
       node scripts/cua-wrapper-operations.mjs recover --store ABS [--json]
CUA 26.1013.40934 / build 20770 only. Explicit target; preparation origin is informational.
Private preparation and store required. No process termination, host restart or source execution.
recover rolls back the interrupted operation's before state; it does not continue it.
Runtime loading and website operation remain not-verified.
`;

function absolute(path) {
  check(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'INVALID_PREPARATION', 'Require a normalized absolute path.');
}
function object(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort()), 'INVALID_PREPARATION', 'Unknown or missing preparation fields.');
  return value;
}
function parseJSON(bytes) {
  const text = bytes.toString('utf8');
  check(Buffer.from(text).equals(bytes), 'INVALID_PREPARATION', 'Preparation JSON must be lossless UTF-8.');
  const result = JSON.parse(text);
  const tree = parse(`(${text})`, { ecmaVersion: 'latest' });
  function inspect(node) {
    if (node.type === 'ObjectExpression') {
      const keys = new Set();
      for (const property of node.properties) {
        const key = String(property.key.value);
        check(!keys.has(key), 'INVALID_PREPARATION', 'Duplicate JSON key.');
        keys.add(key);
        inspect(property.value);
      }
    } else if (node.type === 'ArrayExpression') for (const item of node.elements) inspect(item);
  }
  inspect(tree.body[0].expression);
  return result;
}
async function preparationAt(directory, stored = false) {
  await canonicalDirectory(directory, true);
  check(canonical((await readdir(directory)).sort()) === canonical([...files, ...(stored ? ['transaction-plan.json'] : [])].sort()), 'INVALID_PREPARATION', 'Unexpected or missing preparation artifacts.');
  const original = await regularBytes(join(directory, 'source.original.mjs'), true);
  const patched = await regularBytes(join(directory, 'source.patched.mjs'), true);
  const diff = await regularBytes(join(directory, 'local-diff.txt'), true);
  const manifest = parseJSON(await regularBytes(join(directory, 'manifest.json'), true));
  const origin = object(manifest.origin, ['requestedPath', 'realPath']);
  absolute(origin.requestedPath);
  absolute(origin.realPath);
  // Origin paths are never resolved or selected as write targets.
  const derived = derivePinned(original);
  check(patched.equals(derived.patched) && diff.equals(Buffer.from(preparationDiff(derived))), 'INVALID_PREPARATION', 'Artifacts differ from the pinned rederived preparation.');
  check(canonical(manifest) === canonical(preparationManifest(original, derived, origin)), 'INVALID_PREPARATION', 'Manifest differs from the pinned rederived preparation.');
  return { original, patched, manifest };
}
function identity(value) {
  object(value, ['path', 'realPath', 'device', 'inode', 'mode']);
  absolute(value.path);
  check(value.realPath === value.path && typeof value.device === 'string' && /^(0|[1-9][0-9]*)$/.test(value.device) && typeof value.inode === 'string' && /^[1-9][0-9]*$/.test(value.inode) && Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777, 'INVALID_PREPARATION', 'Invalid saved target identity.');
  return value;
}
function makePlan(directory, preparation, targetIdentity) {
  const contentHash = digest(canonical({ scheme, identity: targetIdentity, preparation: preparation.manifest }));
  return { directory, manifest: { contentHash }, targets: [{ target: { identity: targetIdentity, original: preparation.manifest.original, patched: preparation.manifest.patched }, original: preparation.original, patched: preparation.patched }] };
}
async function loadStored(directory) {
  const preparation = await preparationAt(directory, true);
  const saved = object(parseJSON(await regularBytes(join(directory, 'transaction-plan.json'), true)), ['scheme', 'identity', 'contentHash']);
  check(saved.scheme === scheme, 'SCHEME_MISMATCH', 'Stored preparation uses a different admission scheme.');
  const plan = makePlan(directory, preparation, identity(saved.identity));
  check(plan.manifest.contentHash === saved.contentHash, 'INVALID_PREPARATION', 'Saved target and preparation identity mismatch.');
  return plan;
}
function executorFor(target, store) {
  return transactionExecutor({
    scheme,
    async loadSelected(options) {
      const directory = options.plan;
      absolute(directory);
      absolute(target);
      absolute(store);
      check(target !== directory && !target.startsWith(directory + sep) && target !== store && !target.startsWith(store + sep), 'PATH_ALIAS', 'Target cannot be a preparation or operation-store artifact.');
      const preparation = await preparationAt(directory);
      check(await realpath(target) === target, 'PATH_ALIAS', 'Target must be canonical.');
      const metadata = await lstat(target, { bigint: true });
      check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n, 'PATH_ALIAS', 'Target must be an unaliased regular file.');
      return makePlan(directory, preparation, { path: target, realPath: target, device: String(metadata.dev), inode: String(metadata.ino), mode: Number(metadata.mode & 0o7777n) });
    },
    loadStored,
    async copy(plan, destination) {
      await mkdir(destination, { mode: 0o700 });
      for (const file of files) await writeExclusive(join(destination, file), await regularBytes(join(plan.directory, file), true));
      await writeExclusive(join(destination, 'transaction-plan.json'), JSON.stringify({ scheme, identity: plan.targets[0].target.identity, contentHash: plan.manifest.contentHash }) + '\n');
      await syncDirectory(destination);
      check((await loadStored(destination)).manifest.contentHash === plan.manifest.contentHash, 'PLAN_CHANGED', 'Preparation changed while copying.');
    },
    unselected() { return { state: 'incompatible', diagnostics: [] }; },
    blockingProcesses(table) {
      const legacy = new Set(blockingProcesses(table));
      return table.filter(entry => legacy.has(entry) || /^node_repl(?:[.-].*)?$/.test(basename(entry.executable)));
    },
  });
}
async function main(args) {
  const json = args.includes('--json');
  let command = null;
  let result;
  try {
    const { values, positionals, tokens } = parseArgs({ args, options: { preparation: { type: 'string' }, target: { type: 'string' }, store: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true, tokens: true });
    const seen = new Set();
    for (const token of tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`);
      seen.add(token.name);
    }
    if (values.help) { process.stdout.write(usage); return; }
    command = positionals[0];
    if (positionals.length !== 1 || !['apply', 'status', 'restore', 'recover'].includes(command)) throw new Error('Expected apply, status, restore or recover. See --help.');
    for (const path of command === 'recover' ? [values.store] : [values.preparation, values.target, values.store]) {
      if (!path || !isAbsolute(path) || resolve(path) !== path) throw new Error('Require explicit normalized absolute --preparation, --target and --store paths (recover: --store only).');
    }
    if (command === 'recover' && (values.preparation || values.target)) throw new Error('recover uses authenticated stored selection; supply --store only.');
    result = await executorFor(values.target, values.store)[command]({ store: values.store, ...(values.preparation ? { plan: values.preparation } : {}) });
  } catch (error) {
    result = { schemaVersion: 1, command: ['apply', 'status', 'restore', 'recover'].includes(command) ? command : null, outcome: 'usage-error', exitCode: 2, data: null, diagnostics: [{ code: 'INVALID_ARGUMENTS', severity: 'error', message: error.message }] };
  }
  process.stdout.write(json ? JSON.stringify(result) + '\n' : renderHuman(result));
  process.exitCode = result.exitCode;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv.slice(2));
