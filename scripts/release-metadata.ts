import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function npmTagForRelease(version: string, tag: string, prerelease: boolean): 'latest' | 'next' {
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} must match package.json version: v${version}.`);
  }
  const hasPrerelease = /^[^+]*-/.test(version);
  if (prerelease !== hasPrerelease) {
    throw new Error('The GitHub Release prerelease flag must match the package version prerelease suffix.');
  }
  return prerelease ? 'next' : 'latest';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata)
    || typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error('package.json must contain a version.');
  }
  const { RELEASE_TAG, RELEASE_PRERELEASE, GITHUB_OUTPUT } = process.env;
  if (!RELEASE_TAG || !GITHUB_OUTPUT || !['true', 'false'].includes(RELEASE_PRERELEASE ?? '')) {
    throw new Error('RELEASE_TAG, RELEASE_PRERELEASE and GITHUB_OUTPUT are required.');
  }
  const npmTag = npmTagForRelease(metadata.version, RELEASE_TAG, RELEASE_PRERELEASE === 'true');
  appendFileSync(GITHUB_OUTPUT, `npm-tag=${npmTag}\n`);
  process.stdout.write(`Publishing ${metadata.version} to npm tag ${npmTag}.\n`);
}
