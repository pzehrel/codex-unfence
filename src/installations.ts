import { lstat, readdir, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Diagnostic } from './result.js';
import { canonicalDirectory, check, regularBytes } from './transaction-storage.js';

export const CUA_SERVICE = 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs';
export interface Candidate {
  appPath: string;
  targetPath: string;
  version: string | null;
  build: string | null;
}
export interface DiscoveryReport {
  candidates: Candidate[];
  selection: 'none' | 'single' | 'required';
  diagnostics: Diagnostic[];
  runtime: 'not-verified';
}

function diagnostic(error: unknown, path: string): Diagnostic {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'INSTALLATION_UNAVAILABLE';
  return { code, severity: 'error', message: error instanceof Error ? error.message : 'Cannot inspect installation.', path };
}
async function versionAt(appPath: string): Promise<Pick<Candidate, 'version' | 'build'>> {
  let text: string;
  try { text = (await regularBytes(join(appPath, 'Contents/Info.plist'))).toString('utf8'); }
  catch { return { version: null, build: null }; }
  // Informational only. Unknown/binary plist formats never decide admission.
  const field = (key: string) => new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1] ?? null;
  return { version: field('CFBundleShortVersionString'), build: field('CFBundleVersion') };
}

/** Re-establish paths at every call; a discovery candidate never authorizes a write. */
export async function installationAt(appPath: string): Promise<Candidate> {
  check(isAbsolute(appPath) && resolve(appPath) === appPath, 'PATH_ALIAS', 'Installation requires a normalized absolute app path.', appPath);
  await canonicalDirectory(appPath);
  const targetPath = join(appPath, CUA_SERVICE);
  check(await realpath(targetPath) === targetPath, 'PATH_ALIAS', 'Installation target must have no symlink aliases.', targetPath);
  const metadata = await lstat(targetPath);
  check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, 'PATH_ALIAS', 'Installation target must be an unaliased regular file.', targetPath);
  await regularBytes(targetPath);
  return { appPath, targetPath, ...await versionAt(appPath) };
}

/** Enumerate only Applications roots and the declared CUA service; never scan user configuration. */
export async function discoverInstallations(selection: { appPath?: string } = {}): Promise<DiscoveryReport> {
  const candidates: Candidate[] = [];
  const diagnostics: Diagnostic[] = [];
  if (selection.appPath !== undefined) {
    try { candidates.push(await installationAt(selection.appPath)); }
    catch (error) { diagnostics.push(diagnostic(error, selection.appPath)); }
  } else {
    for (const root of ['/Applications', join(userInfo().homedir, 'Applications')]) {
      let names: string[];
      try { names = await readdir(root); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) diagnostics.push(diagnostic(error, root));
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.app')) continue;
        const appPath = join(root, name);
        try {
          // An unrelated application is not a malformed CUA installation.
          await lstat(join(appPath, CUA_SERVICE));
          candidates.push(await installationAt(appPath));
        }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) diagnostics.push(diagnostic(error, appPath));
        }
      }
    }
  }
  return { candidates, selection: candidates.length === 0 ? 'none' : candidates.length === 1 ? 'single' : 'required', diagnostics, runtime: 'not-verified' };
}
