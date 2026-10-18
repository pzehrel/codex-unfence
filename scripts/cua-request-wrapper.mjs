import { parse, parseExpressionAt } from 'acorn';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const profile = Object.freeze({
  id: 'cua-request-wrapper-26.1013.40934-build20770',
  appVersion: '26.1013.40934', build: '20770', pluginVersion: '0.1.1',
  size: 1938669, sha256: '44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e',
  start: 1084567, end: 1084585,
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = `Usage: node scripts/cua-request-wrapper.mjs --source PATH --output-dir NEWDIR
Prepare only: pinned CUA 26.1013.40934 / build 20770 / browser-desktop 0.1.1.
NEWDIR must be one new direct child of this repository's existing evidence/ directory.
No symlinks, existing output or .app output paths. Private directory 0700; files 0600.
Outputs: source.original.mjs, source.patched.mjs, manifest.json, local-diff.txt.
Assessment: version-scoped-reviewed-pattern; mechanical-edit; runtime: not-verified.
Does not install, apply or execute the source. No hash/profile overrides.
`;

// This adapter is serialized into one explicitly reviewed transport expression.
// Supported JSON records have Object.prototype/null prototypes and only own,
// enumerable string data properties. Accessors, symbols and exotic objects pass
// through unchanged; this is not a general Response/Proxy transparency contract.
function adaptResponse(response) {
  function isRecord(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    return Reflect.ownKeys(value).every((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && property.enumerable && Object.hasOwn(property, 'value');
    });
  }
  return {
    get ok() { return response.ok; },
    async json() {
      const body = await response.json();
      if (!isRecord(body) || !Object.hasOwn(body, 'feature_status')) return body;
      const status = body.feature_status;
      if (!isRecord(status) || !Object.hasOwn(status, 'agent') || status.agent !== true) return body;
      return { ...body, feature_status: { ...status, agent: false } };
    },
  };
}

/** Mechanical UTF-16 edit at a caller-reviewed expression, not compatibility proof. */
export function transformRequestTransport(source, { start, end, expected }) {
  if (typeof source !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end > source.length || typeof expected !== 'string'
    || source.slice(start, end) !== expected) throw new Error('Reviewed expression does not match source.');
  parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const expression = parseExpressionAt(expected, 0, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
  if (expression.type !== 'AwaitExpression' || expression.end !== expected.length
    || expression.argument.type !== 'CallExpression' || expression.argument.callee.type !== 'MemberExpression') {
    throw new Error('Reviewed expression must await the original member call.');
  }
  const replacement = `((${adaptResponse.toString()})(${expected}))`;
  const patched = source.slice(0, start) + replacement + source.slice(end);
  parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  return {
    source: patched,
    range: { start, end, unit: 'utf16' },
    replacement,
    assessment: 'version-scoped-reviewed-pattern',
    operation: 'mechanical-edit',
    runtime: 'not-verified',
  };
}

function rejectAppPath(path) {
  if (path.split(/[\\/]/).some(part => /\.app$/i.test(part))) throw new Error('Refusing .app output path.');
}

async function absent(path) {
  try { await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Output already exists; refusing overwrite.');
}

async function outputPath(requested) {
  rejectAppPath(requested);
  const output = resolve(requested);
  const evidence = join(repository, 'evidence');
  if (dirname(output) !== evidence) throw new Error('Output must be one new direct child of repository evidence/.');
  const parent = await lstat(evidence);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Evidence directory must be an existing directory, not a symlink.');
  const canonical = await realpath(evidence);
  rejectAppPath(canonical);
  await absent(output);
  return join(canonical, basename(output));
}

async function prepare(sourcePath, requestedOutput) {
  const output = await outputPath(requestedOutput);
  const origin = await realpath(sourcePath);
  const sourceFile = await open(origin, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await sourceFile.stat();
    if (!before.isFile()) throw new Error('Source must be a regular file.');
    bytes = await sourceFile.readFile();
    const after = await sourceFile.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed while reading.');
  } finally { await sourceFile.close(); }
  if (bytes.length !== profile.size || digest(bytes) !== profile.sha256) {
    throw new Error('Pinned source identity mismatch: exact size and SHA-256 required.');
  }
  const source = bytes.toString('utf8');
  if (!Buffer.from(source).equals(bytes)) throw new Error('Source is not round-trip UTF-8.');
  const expected = source.slice(profile.start, profile.end);
  const transformed = transformRequestTransport(source, { start: profile.start, end: profile.end, expected });
  const patched = Buffer.from(transformed.source);
  const originalPrefix = Buffer.from(source.slice(0, profile.start));
  const originalSuffix = Buffer.from(source.slice(profile.end));
  if (!patched.subarray(0, originalPrefix.length).equals(originalPrefix)
    || !patched.subarray(patched.length - originalSuffix.length).equals(originalSuffix)) {
    throw new Error('Bytes outside reviewed expression changed.');
  }
  const manifest = {
    kind: 'cua-request-wrapper-local-preparation',
    profile: { id: profile.id, appVersion: profile.appVersion, build: profile.build, pluginVersion: profile.pluginVersion },
    assessment: transformed.assessment, operation: transformed.operation, runtime: transformed.runtime,
    origin: { requestedPath: resolve(sourcePath), realPath: origin },
    original: { file: 'source.original.mjs', size: bytes.length, sha256: digest(bytes) },
    patched: { file: 'source.patched.mjs', size: patched.length, sha256: digest(patched) },
    range: transformed.range,
    patchedRange: { start: profile.start, end: profile.start + transformed.replacement.length, unit: 'utf16' },
    scope: 'reviewed dedicated site-status transport; original fetch guard, member call and consumer retained',
    jsonPolicy: 'Object.prototype/null records with own enumerable string data properties; own feature_status.agent strictly true only',
    outsideRange: 'byte-identical', syntax: 'parsed-before-and-after',
  };
  const diff = `Mechanical expression replacement; UTF-16 [${profile.start},${profile.end})\n--- source.original.mjs\n+++ source.patched.mjs\n-${expected}\n+${transformed.replacement}\n`;
  await mkdir(output, { mode: 0o700 }); // Exclusive, never recursive or reused.
  const owned = await lstat(output);
  const created = [];
  async function stillOwned() {
    const current = await lstat(output);
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('Output directory identity changed.');
  }
  try {
    for (const [name, content] of [
      ['source.original.mjs', bytes], ['source.patched.mjs', patched],
      ['local-diff.txt', diff], ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
    ]) {
      await stillOwned();
      const destination = join(output, name);
      const handle = await open(destination, 'wx', 0o600);
      try {
        const identity = await handle.stat();
        created.push({ destination, dev: identity.dev, ino: identity.ino });
        await handle.writeFile(content);
      } finally { await handle.close(); }
    }
    await stillOwned();
  } catch (error) {
    // Only unlink our successfully created files, and only in our original directory.
    // rmdir refuses foreign contents; never recursively delete a raced/reused path.
    try {
      await stillOwned();
      for (const file of created.reverse()) {
        const current = await lstat(file.destination);
        if (current.dev !== file.dev || current.ino !== file.ino) throw new Error('Output file identity changed.');
        await unlink(file.destination);
      }
      await rmdir(output);
    } catch { /* Preserve the original failure, leaving uncertain ownership untouched. */ }
    throw error;
  }
  return { outputDirectory: output, manifest: join(output, 'manifest.json'), assessment: transformed.assessment, operation: transformed.operation, runtime: transformed.runtime };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(usage); return; }
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output-dir'
    || !args[1] || !args[3] || !isAbsolute(args[1]) || !isAbsolute(args[3])) {
    throw new Error('Expected --source PATH --output-dir NEWDIR, both absolute paths. See --help.');
  }
  process.stdout.write(JSON.stringify(await prepare(args[1], args[3]), null, 2) + '\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
