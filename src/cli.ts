#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { detect } from './discovery.js';
import { prepare } from './plan.js';
import { isAbsolute } from 'node:path';
import { EXIT_CODES, renderHuman } from './result.js';
import type { CommandResult } from './result.js';

const help = `codex-browser-patch — macOS Codex browser plugin structural detection

Usage:
  codex-browser-patch detect [--plugin-root <directory>] [--json]
  codex-browser-patch prepare [--plugin-root <directory>] --target <absolute-artifact-path> [--target <path> ...] --output <new-plan-directory> [--json]
  codex-browser-patch prepare [--plugin-root <directory>] --all-compatible --output <new-plan-directory> [--json]
  codex-browser-patch --help

Default root: ~/.codex/plugins/cache/openai-bundled
Read-only discovery and finite AST structural proof are available.
Only one proven site-status source/response/agent/blocking chain is compatible.
Unsupported patterns, ambiguity and deferred initialization are rejected.
prepare requires explicit selection and creates a review plan without changing plugins.
Exact paths come from detect. --all-compatible filters compatible artifacts explicitly.
Aliases to the same file are rejected. Existing output paths are never overwritten.
Plans retain UTF-8 originals, patched artifacts, UTF-16 evidence, local diffs and hashes.
Plan integrity is consistency, not authentication or proof of tool application.
Runtime loading and website operation are not verified. Version metadata does
not identify the running version. detect creates no patch plans or backups.

Output protocol: schemaVersion 1. Exit codes: 0 success, 1 runtime failure,
2 invalid arguments, 3 incompatible (including mixed compatible/incompatible).
Runtime failures take precedence over incompatibility; empty discovery succeeds.
JSON results (including errors) go to stdout.
`;

const args = process.argv.slice(2);
const json = args.includes('--json') || args.some((arg) => arg.startsWith('--json='));

async function main(): Promise<CommandResult | null> {
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      options: {
        'plugin-root': { type: 'string' },
        target: { type: 'string', multiple: true },
        'all-compatible': { type: 'boolean' },
        output: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option') continue;
      if (token.name !== 'target' && seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`);
      seen.add(token.name);
    }
    if (values.help && (positionals.length === 0 || (positionals.length === 1 && ['detect', 'prepare'].includes(positionals[0] ?? '')))) {
      process.stdout.write(help);
      return null;
    }
    const command = positionals[0];
    if (positionals.length !== 1 || (command !== 'detect' && command !== 'prepare')) throw new Error('Expected command: detect or prepare. Use --help for usage.');
    const root = values['plugin-root'];
    if (root !== undefined && (root.length === 0 || root.startsWith('-'))) throw new Error('--plugin-root requires a directory path.');
    if (command === 'detect' && (values.target || values['all-compatible'] || values.output !== undefined)) throw new Error('Selection and output options require prepare.');
    if (command === 'prepare') {
      const targets = values.target ?? [];
      const allCompatible = values['all-compatible'] ?? false;
      if (allCompatible === (targets.length > 0)) throw new Error('Choose repeated --target paths or --all-compatible explicitly.');
      if (targets.some((path) => !isAbsolute(path))) throw new Error('--target requires an exact absolute artifact path from detect.');
      if (new Set(targets).size !== targets.length) throw new Error('Duplicate --target path.');
      const output = values.output;
      if (!output || output.startsWith('-')) throw new Error('--output requires a new plan directory.');
      return await prepare({ ...(root !== undefined ? { pluginRoot: root } : {}), targets, allCompatible, output });
    }
    try {
      return await detect(root);
    } catch (error) {
      return {
        schemaVersion: 1, command: 'detect', outcome: 'runtime-error', exitCode: EXIT_CODES.runtimeError, data: null,
        diagnostics: [{ code: 'DISCOVERY_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Discovery failed.' }],
      };
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      command: args[0] === 'detect' ? 'detect' : args[0] === 'prepare' ? 'prepare' : null,
      outcome: 'usage-error',
      exitCode: EXIT_CODES.usageError,
      data: null,
      diagnostics: [{ code: 'INVALID_ARGUMENTS', severity: 'error', message: error instanceof Error ? error.message : 'Invalid arguments.' }],
    };
  }
}

const result = await main();
if (result) {
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : renderHuman(result));
  process.exitCode = result.exitCode;
}
