#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { EXIT_CODES, renderHuman } from './result.js';
import type { CommandResult } from './result.js';
import type { ToolIdentity } from './managed-state.js';
import { commands, parseCliOptions, renderHelp } from './cli-options.js';
import type { CliOptions } from './cli-options.js';
import { managedCli } from './managed-cli.js';

const args = process.argv.slice(2);
const json = args.includes('--json') || args.some((arg) => arg.startsWith('--json='));

async function packagedTool(): Promise<ToolIdentity> {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const executable = metadata.bin && typeof metadata.bin === 'object' ? Object.keys(metadata.bin)[0] : undefined;
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string' || !executable) throw new Error('安装包缺少工具名称、版本或命令信息。');
  return { packageName: metadata.name, version: metadata.version, executable };
}

async function main(): Promise<CommandResult | null> {
  let options: CliOptions;
  try {
    options = parseCliOptions(args);
  } catch (error) {
    return {
      schemaVersion: 1, command: commands.find(command => args.includes(command)) ?? null, outcome: 'usage-error', exitCode: EXIT_CODES.usageError, data: null,
      diagnostics: [{ code: 'INVALID_ARGUMENTS', severity: 'error', message: error instanceof Error ? error.message : '参数无效。' }],
    };
  }
  try {
    if (options.help) {
      process.stdout.write(renderHelp(options.command));
      return null;
    }
    const tool = await packagedTool();
    if (options.version) {
      process.stdout.write(`${tool.version}\n`);
      return null;
    }
    return await managedCli(options, tool);
  } catch (error) {
    return {
      schemaVersion: 1, command: options.command ?? null, outcome: 'runtime-error', exitCode: EXIT_CODES.runtimeError, data: null,
      diagnostics: [{ code: 'COMMAND_FAILED', severity: 'error', message: error instanceof Error ? error.message : '命令执行失败。' }],
    };
  }
}

const result = await main();
if (result) {
  const output = json ? `${JSON.stringify(result)}\n` : renderHuman(result);
  if (!json && result.outcome === 'usage-error') process.stderr.write(output);
  else process.stdout.write(output);
  process.exitCode = result.exitCode;
}
