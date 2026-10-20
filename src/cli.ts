#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { detect } from './discovery.js';
import { prepare } from './plan.js';
import { apply, recover, restore, status } from './transactions.js';
import { isAbsolute } from 'node:path';
import { EXIT_CODES, renderHuman } from './result.js';
import type { CommandResult } from './result.js';
import { managedCli } from './managed-cli.js';

const help = `codex-unfence — macOS Codex browser plugin structural detection

Usage:
  codex-unfence                         interactive discovery, check and action selection
  codex-unfence check [--app <absolute-app-path>] [--json]
  codex-unfence install [--app <absolute-app-path>]
  codex-unfence uninstall [--app <absolute-app-path>]

check reports every discovered installation without writing.
install and uninstall guide rollback of interrupted operations before continuing.
Advanced managed aliases: apply, restore, status, recover.

Managed changes require interactive stdin/stdout and explicit confirmation; --json cannot authorize writes.
Exit and reopen the host manually. Sealed-resource changes invalidate its signature.
Recovery data stays private outside npm cache; keep the matching local tarball while unpublished.
Structural support, write readiness and runtime verification are separate. Runtime: not-verified.

Legacy explicit review-plan commands:
  codex-unfence detect [--plugin-root <directory>] [--json]
  codex-unfence prepare [--plugin-root <directory>] --target <absolute-artifact-path> [--target <path> ...] --output <new-plan-directory> [--json]
  codex-unfence prepare [--plugin-root <directory>] --all-compatible --output <new-plan-directory> [--json]
  codex-unfence apply --plan <directory> --store <private-directory> [--json]
  codex-unfence restore --plan <directory> --store <private-directory> [--json]
  codex-unfence status --plan <directory> --store <private-directory> [--json]
  codex-unfence status --target <absolute-artifact-path> [--target <path> ...] --store <private-directory> [--json]
  codex-unfence recover --store <private-directory> [--json]
  codex-unfence --help

Default root: ~/.codex/plugins/cache/openai-bundled
Read-only discovery and finite AST structural proof are available.
Only one proven site-status source/response/agent/blocking chain is compatible.
Unsupported patterns and ambiguity are rejected. Complete finite deferred initialization,
request/response, receiver, cache/inflight and actual policy proofs enable one local response-copy
transform and rederivable plans. Partial proofs never grant a target.
Legacy-only plans retain v1; selections containing deferred targets use v2 per-target patterns.
Standard host capabilities, runtime.fetch/JSON and Node standard modules are trusted interfaces;
current-file relevant mutation or unknown escape still rejects. Runtime remains not-verified.
Changing disk source does not immediately clear an already cached blocked result.
prepare requires explicit selection and creates a review plan without changing plugins.
Exact paths come from detect. --all-compatible filters compatible artifacts explicitly.
Aliases to the same file are rejected. Existing output paths are never overwritten.
Plans retain UTF-8 originals, patched artifacts, UTF-16 evidence, local diffs and hashes.
Plan integrity is consistency, not authentication or proof of tool application.
apply and restore operate on exactly the selected browser/chrome versions in a plan.
All targets, plans, backups, processes and unfinished transactions preflight before target writes.
Target sibling locks are sorted and deduplicated after the store lock, including across stores.
Each target keeps its actual before state, including mixed original/applied and no-op entries.
Later write failure rolls back actual changed targets; failed rollback requires explicit recover.
Individual replacements are atomic; the whole group is not an atomic filesystem exchange.
status reports selected targets and whole pending groups, including their owning stores.
All operation commands require explicit --store. status is read-only.
The store must be private (0700), owned by this user, and use canonical paths.
apply and restore record durable intent and a private authenticated backup before atomic rename.
restore returns a trusted target to verified original content; known originals report already-original.
Patched contents require verified tool records and backups; patch shape alone proves no provenance.
An incomplete transaction blocks ordinary writes, including from other stores.
recover always rolls back to that operation's before state; it never continues apply or restore.
An interrupted restore is rolled back to its actual pre-restore state, usually tool-applied.
Keep the store and sibling .codex-unfence.lock history until recovery is complete.
Unknown contents and aliases are conflicts. Exit Codex/ChatGPT and browser-service first.
Process checks use ps snapshots; detection is limited and never terminates processes.
Files and parent directories are fsynced; crash recovery is tested with SIGKILL.
This does not claim power-loss durability or exclusion of external updaters.
Store HMACs bind operation records separately from plans; same-user hostile edits
that can read the private key are outside this local provenance trust boundary.
Runtime loading and website operation are not verified. Version metadata does
not identify the running version. detect creates no patch plans or backups.

Output protocol: schemaVersion 1. Exit codes: 0 success, 1 runtime failure,
2 invalid arguments, 3 incompatible (including mixed compatible/incompatible), 4 conflict.
check aggregates runtime failure, conflict, incompatibility, then success.
check exits 1 when no installations are found; empty legacy detect succeeds.
Write blockers are reported separately; check success does not authorize writes.
JSON results (including errors) go to stdout.
`;

const args = process.argv.slice(2);
const json = args.includes('--json') || args.some((arg) => arg.startsWith('--json='));

async function main(): Promise<CommandResult | null> {
  try {
    const route = parseArgs({ args, allowPositionals: true, strict: false, tokens: true, options: {
      app: { type: 'string' }, plan: { type: 'string' }, store: { type: 'string' },
      'plugin-root': { type: 'string' }, target: { type: 'string', multiple: true }, output: { type: 'string' },
      'all-compatible': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    const legacy = route.tokens.some(token => token.kind === 'option' && (token.name === 'plan' || token.name === 'store'));
    if (!route.values.help && !legacy && (route.positionals.length === 0 || ['install', 'uninstall', 'check', 'status', 'apply', 'restore', 'recover'].includes(route.positionals[0] ?? ''))) return await managedCli(args);
    const { values, positionals, tokens } = parseArgs({
      args,
      options: {
        'plugin-root': { type: 'string' },
        target: { type: 'string', multiple: true },
        'all-compatible': { type: 'boolean' },
        output: { type: 'string' },
        plan: { type: 'string' },
        store: { type: 'string' },
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
    if (values.help && (positionals.length === 0 || (positionals.length === 1 && ['install', 'uninstall', 'check', 'detect', 'prepare', 'apply', 'restore', 'status', 'recover'].includes(positionals[0] ?? '')))) {
      process.stdout.write(help);
      return null;
    }
    const command = positionals[0];
    if (positionals.length !== 1 || !['detect', 'prepare', 'apply', 'restore', 'status', 'recover'].includes(command ?? '')) throw new Error('Expected command: detect, prepare, apply, restore, status or recover. Use --help for usage.');
    if (command === 'apply' || command === 'restore' || command === 'status' || command === 'recover') {
      if (values['plugin-root'] !== undefined || (values.target && command !== 'status') || values['all-compatible'] || values.output !== undefined) throw new Error('Operation commands use --plan and --store selection.');
      const store = values.store;
      if (!store || !isAbsolute(store)) throw new Error('--store requires an explicit absolute operation directory.');
      if (command === 'recover') {
        if (values.plan !== undefined) throw new Error('recover uses the stored transaction plan; select only --store.');
        return await recover({ store });
      }
      if (command === 'status' && values.target) {
        if (values.plan || values.target.some((path) => !isAbsolute(path)) || new Set(values.target).size !== values.target.length) throw new Error('status requires unique absolute --target paths or a --plan selection.');
        return await status({ store, targets: values.target });
      }
      if (!values.plan || !isAbsolute(values.plan)) throw new Error('--plan requires an explicit absolute review directory.');
      return await ({ apply, restore, status }[command])({ store, plan: values.plan });
    }
    if (values.plan !== undefined || values.store !== undefined) throw new Error('--plan and --store require apply, restore, status or recover.');
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
      command: args[0] === 'install' || args[0] === 'uninstall' || args[0] === 'check' || args[0] === 'detect' || args[0] === 'prepare' || args[0] === 'apply' || args[0] === 'restore' || args[0] === 'status' || args[0] === 'recover' ? args[0] : null,
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
