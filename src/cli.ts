#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { EXIT_CODES, renderHuman } from './result.js';
import type { CommandResult } from './result.js';
import { managedCli } from './managed-cli.js';

const help = `codex-unfence — macOS Codex browser site-status patch

Usage:
  codex-unfence                         interactive discovery, check and action selection
  codex-unfence check [--app <absolute-app-path>] [--json]
  codex-unfence install [--app <absolute-app-path>]
  codex-unfence uninstall [--app <absolute-app-path>]
  codex-unfence --help

check reports every discovered installation without writing.
install and uninstall guide rollback of interrupted operations before continuing.
Advanced managed aliases: apply, restore, status, recover.
All selections use --app; recovery materials are managed automatically.

Managed changes require interactive stdin/stdout and explicit confirmation; --json cannot authorize writes.
Exit and reopen the host manually. Sealed-resource changes invalidate its signature.
Recovery data stays private outside npm cache; keep the matching local tarball while unpublished.
Structural support, write readiness and runtime verification are separate. Runtime: not-verified.
Changing disk source does not immediately clear an already cached blocked result.

Output protocol: schemaVersion 1. Exit codes: 0 success, 1 runtime failure,
2 invalid arguments, 3 incompatible (including mixed compatible/incompatible), 4 conflict.
check aggregates runtime failure, conflict, incompatibility, then success.
check exits 1 when no installations are found.
Write blockers are reported separately; check success does not authorize writes.
JSON results (including errors) go to stdout.
`;

const args = process.argv.slice(2);
const json = args.includes('--json') || args.some((arg) => arg.startsWith('--json='));
const commands = ['install', 'uninstall', 'check', 'status', 'apply', 'restore', 'recover'] as const;

async function main(): Promise<CommandResult | null> {
  try {
    const { values, positionals, tokens } = parseArgs({
      args, options: { app: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true, allowPositionals: true, tokens: true,
    });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`);
      seen.add(token.name);
    }
    if (positionals.length > 1 || positionals.some(command => !commands.some(known => known === command))) throw new Error('Expected command: install, check or uninstall. Use --help for usage.');
    if (values.help) {
      process.stdout.write(help);
      return null;
    }
    return await managedCli(args);
  } catch (error) {
    const command = commands.find(command => command === args[0]) ?? null;
    return {
      schemaVersion: 1, command, outcome: 'usage-error', exitCode: EXIT_CODES.usageError, data: null,
      diagnostics: [{ code: 'INVALID_ARGUMENTS', severity: 'error', message: error instanceof Error ? error.message : 'Invalid arguments.' }],
    };
  }
}

const result = await main();
if (result) {
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : renderHuman(result));
  process.exitCode = result.exitCode;
}
