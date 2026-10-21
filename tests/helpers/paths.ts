import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Tests execute from .build/tests/helpers; fixtures containing source text stay in the repository.
export const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const publishedCli = join(repositoryRoot, 'dist/cli.js');
export function sourceFixture(name: string): URL {
  return pathToFileURL(join(repositoryRoot, 'tests/fixtures', name));
}
