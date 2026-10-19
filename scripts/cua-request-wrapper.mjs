#!/usr/bin/env node
import { derivePinned, preparationManifest, preparationDiff } from './cua-wrapper-recipe.mjs';
export { transformRequestTransport } from './cua-wrapper-recipe.mjs';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const usage = `Usage: node scripts/cua-request-wrapper.mjs --source PATH --output-dir NEWDIR
Prepare only: pinned CUA 26.1013.40934 / build 20770 / browser-desktop 0.1.1.
NEWDIR must be one new direct child of this repository's existing evidence/ directory.
No symlinks, existing output or .app output paths. Private directory 0700; files 0600.
Outputs: source.original.mjs, source.patched.mjs, manifest.json, local-diff.txt.
Assessment: version-scoped-reviewed-pattern; mechanical-edit; runtime: not-verified.
Does not install, apply or execute the source. No hash/profile overrides.
`;

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
  const { expected, transformed, patched } = derivePinned(bytes);
  const manifest = preparationManifest(bytes, { transformed, patched }, { requestedPath: resolve(sourcePath), realPath: origin });
  const diff = preparationDiff({ expected, transformed });
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
