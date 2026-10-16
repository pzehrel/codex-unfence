#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { detect } from './discovery.js';
import { EXIT_CODES, renderHuman } from './result.js';
import type { CommandResult } from './result.js';

const help = `codex-browser-patch — macOS Codex browser plugin discovery

Usage:
  codex-browser-patch detect [--plugin-root <directory>] [--json]
  codex-browser-patch --help

Default root: ~/.codex/plugins/cache/openai-bundled
Only read-only discovery is available. Structural compatibility is not analyzed.
Runtime loading and website operation are not verified. Version metadata does
not identify the running version. No patch plans or backups are created.

Output protocol: schemaVersion 1. Exit codes: 0 success, 1 runtime failure,
2 invalid arguments. JSON results (including errors) go to stdout.
`;

const args = process.argv.slice(2);
const json = args.includes('--json') || args.some((arg) => arg.startsWith('--json='));

async function main(): Promise<CommandResult | null> {
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      options: {
        'plugin-root': { type: 'string' },
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
      if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`);
      seen.add(token.name);
    }
    if (values.help && (positionals.length === 0 || (positionals.length === 1 && positionals[0] === 'detect'))) {
      process.stdout.write(help);
      return null;
    }
    if (positionals.length !== 1 || positionals[0] !== 'detect') throw new Error('Expected command: detect. Use --help for usage.');
    const root = values['plugin-root'];
    if (root !== undefined && (root.length === 0 || root.startsWith('-'))) throw new Error('--plugin-root requires a directory path.');
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
      command: args[0] === 'detect' ? 'detect' : null,
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
