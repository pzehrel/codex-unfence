import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { analyzeSource } from './analysis.js';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import type { Artifact, DetectionResult, Diagnostic } from './result.js';
import { EXIT_CODES } from './result.js';

function systemCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN';
}

function failure(path: string, error: unknown, code: string): Diagnostic {
  return { code, severity: 'error', message: 'Cannot inspect path.', path, systemCode: systemCode(error) };
}

export async function detect(pluginRoot?: string): Promise<DetectionResult> {
  if (process.platform !== 'darwin') {
    return {
      schemaVersion: 1, command: 'detect', outcome: 'runtime-error', exitCode: EXIT_CODES.runtimeError, data: null,
      diagnostics: [{ code: 'UNSUPPORTED_PLATFORM', severity: 'error', message: `Only macOS is supported; received ${process.platform}.` }],
    };
  }
  const root = resolve(pluginRoot ?? join(homedir(), '.codex/plugins/cache/openai-bundled'));
  const artifacts: Artifact[] = [];
  const diagnostics: Diagnostic[] = [];
  try {
    if (!(await stat(root)).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
    await readdir(root);
  } catch (error) {
    if (systemCode(error) !== 'ENOENT') {
      return {
        schemaVersion: 1, command: 'detect', outcome: 'runtime-error', exitCode: EXIT_CODES.runtimeError,
        data: { pluginRoot: root, artifacts, runtime: 'not-verified' },
        diagnostics: [failure(root, error, 'ROOT_UNAVAILABLE')],
      };
    }
  }

  for (const plugin of ['browser', 'chrome'] as const) {
    const directory = join(root, plugin);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (systemCode(error) !== 'ENOENT') diagnostics.push(failure(directory, error, 'DISCOVERY_FAILED'));
      continue;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const versionPath = join(directory, entry.name);
      try {
        if (!(await stat(versionPath)).isDirectory()) continue;
      } catch (error) {
        diagnostics.push(failure(versionPath, error, 'DISCOVERY_FAILED'));
        continue;
      }
      const path = join(versionPath, 'scripts/browser-service.mjs');
      const artifact: Artifact = {
        plugin, version: entry.name, path, realPath: null,
        availability: 'unavailable', compatibility: 'not-analyzed',
      };
      try {
        artifact.realPath = await realpath(path);
        if (!(await stat(path)).isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'NOT_A_FILE' });
        await access(path, constants.R_OK);
        const source = await readFile(path, 'utf8');
        artifact.availability = 'readable';
        artifact.analysis = analyzeSource(source);
        artifact.compatibility = artifact.analysis.compatibility;
        diagnostics.push(...artifact.analysis.diagnostics.map((diagnostic) => ({ ...diagnostic, path })));
      } catch (error) {
        diagnostics.push(failure(path, error, 'ARTIFACT_UNAVAILABLE'));
      }
      artifacts.push(artifact);
    }
  }

  const incompatible = artifacts.some((artifact) => artifact.compatibility === 'incompatible');
  const failed = diagnostics.some((diagnostic) => diagnostic.severity === 'error' &&
    ['ROOT_UNAVAILABLE', 'DISCOVERY_FAILED', 'ARTIFACT_UNAVAILABLE'].includes(diagnostic.code));
  if (artifacts.length === 0 && !failed) {
    diagnostics.push({ code: 'NO_ARTIFACTS', severity: 'info', message: 'No browser/chrome artifacts found.', path: root });
  }
  return {
    schemaVersion: 1,
    command: 'detect',
    outcome: failed ? 'runtime-error' : incompatible ? 'incompatible' : 'success',
    exitCode: failed ? EXIT_CODES.runtimeError : incompatible ? EXIT_CODES.incompatible : EXIT_CODES.success,
    data: { pluginRoot: root, artifacts, runtime: 'not-verified' },
    diagnostics,
  };
}
