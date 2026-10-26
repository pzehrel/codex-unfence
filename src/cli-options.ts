import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

export const commands = ['install', 'uninstall', 'check', 'status', 'apply', 'restore', 'recover'] as const;
export type Command = typeof commands[number];
export interface CliOptions {
  command: Command | undefined;
  app: string | undefined;
  json: boolean;
  help: boolean;
  version: boolean;
}

export function isCommand(value: string): value is Command {
  return commands.some(command => command === value);
}

export function parseCliOptions(args: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        app: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true, allowPositionals: true, tokens: true,
    });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    const option = error instanceof Error ? error.message.match(/'(-[^']+)'/)?.[1] : undefined;
    const message = code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `未知选项${option ? ` ${option}` : ''}，请使用 --help 查看支持的参数。`
      : code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? `选项${option ? ` ${option}` : ''}的值无效：--app 需要路径，其他选项不接受值。`
        : '无法解析参数，请使用 --help 查看用法。';
    throw new Error(message);
  }
  const { values, positionals, tokens } = parsed;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`选项重复：--${token.name}`);
    seen.add(token.name);
  }
  const command = positionals[0];
  if (positionals.length > 1 || command !== undefined && !isCommand(command)) {
    throw new Error('命令无效。请使用 install、check 或 uninstall；使用 --help 查看完整用法。');
  }
  if (values.help && values.version) throw new Error('请分别使用 --help 和 --version。');
  if (values.version && (command !== undefined || values.app !== undefined || values.json)) {
    throw new Error('--version 不能与命令、--app 或 --json 同时使用。');
  }
  if (values.help && values.json) throw new Error('--help 不能与 --json 同时使用。');
  if (values.app !== undefined && !isAbsolute(values.app)) throw new Error('--app 需要应用的绝对路径。');
  if (!values.help && !values.version && command !== 'check' && command !== 'status' && (values.json || !process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('安装、卸载、恢复和默认引导需要交互终端，且不能使用 --json。');
  }
  return { command: command !== undefined && isCommand(command) ? command : undefined, app: values.app, json: values.json ?? false, help: values.help ?? false, version: values.version ?? false };
}

const descriptions: Record<Command, string> = {
  install: '安装补丁，写入前需要确认。',
  check: '检查所有发现的应用，不修改文件。',
  uninstall: '卸载补丁，恢复经过验证的原始文件。',
  status: '查看一个应用的文件状态，不修改文件。',
  apply: 'install 的别名。',
  restore: 'uninstall 的别名。',
  recover: '将中断的操作回滚到操作前的文件状态。',
};

export function renderHelp(command?: Command): string {
  const readOnly = command === 'check' || command === 'status';
  const lines = ['codex-unfence — macOS Codex 浏览器站点状态补丁', ''];
  if (command) {
    lines.push(descriptions[command], '', '用法：', `  codex-unfence ${command} [--app <应用绝对路径>]${readOnly ? ' [--json]' : ''}`, '');
  } else {
    lines.push('用法：', '  codex-unfence [命令] [选项]', '', '命令：');
    for (const name of ['install', 'check', 'uninstall'] as const) lines.push(`  ${name.padEnd(12)}${descriptions[name]}`);
    lines.push('', '不带命令运行时，进入交互引导。', '', '其他命令：');
    for (const name of ['status', 'apply', 'restore', 'recover'] as const) lines.push(`  ${name.padEnd(12)}${descriptions[name]}`);
    lines.push('');
  }
  lines.push('选项：', '  --app <应用绝对路径>  指定要操作的应用。');
  if (!command || readOnly) lines.push('  --json                以 JSON 输出 check/status 结果。');
  lines.push('  -h, --help            查看命令帮助。');
  if (!command) lines.push('  -v, --version         查看当前工具版本。');
  lines.push('', '示例：');
  if (command) {
    lines.push(`  codex-unfence ${command} --app /Applications/Codex.app${readOnly ? ' --json' : ''}`);
  } else {
    lines.push('  codex-unfence check', '  codex-unfence check --app /Applications/Codex.app --json', '  codex-unfence install', '  codex-unfence uninstall', '  codex-unfence check --help');
  }
  if (!command || !readOnly) lines.push('', '修改文件前：', '  需要交互终端，并输入 yes 确认。', '  请自行退出 Codex 及相关浏览器服务。', '  若上次操作中断，install/uninstall 会先引导回滚。', '  修改应用资源会使应用签名校验失败。', '  请保留对应版本的工具和恢复数据，以便卸载或恢复。');
  lines.push('', '退出码：', '  0  成功', '  1  运行失败或未找到应用', '  2  参数错误', '  3  应用不兼容', '  4  文件或恢复状态冲突');
  if (!command || readOnly) lines.push('', 'check 汇总所有应用，按运行失败、冲突、不兼容、成功的顺序确定结果。', '未找到应用时，check 返回退出码 1。', '写入条件单独报告；检查成功不代表可以写入。', '文件检查不验证补丁在应用运行时是否生效。', 'JSON 结果和错误均输出到 stdout，协议版本为 schemaVersion 1。');
  return lines.join('\n') + '\n';
}
