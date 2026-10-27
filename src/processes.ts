import { execFile } from 'node:child_process';
import { basename } from 'node:path';

function execute(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}
export const PROCESS_LIMITATION = 'Process checks use ps snapshots and executable/argument identities; processes may start after inspection. No process is terminated. Runtime loading and website operation remain not-verified. Running applications and related services only trigger warnings; process identity enumeration is required for concurrency locks.';
export const RESTART_REQUIRED = 'Fully exit the application and related browser services (browser-service and node_repl), then restart the application to load the changed files.';

export interface ProcessIdentity {
  pid: number;
  start: string;
  executable: string;
  command: string;
}

// BSD/macOS ps accepts field widths through headers, rather than GNU's comm:width syntax.
// Keep command last so -ww leaves its arguments unbounded. Reject a full comm field:
// its executable identity might have been truncated, even if the resulting path looks valid.
const executableHeader = 'EXECUTABLE' + '_'.repeat(2038);
const processFormat = `pid=PID,lstart=START,comm=${executableHeader},command=COMMAND`;

/** Capture executable identity and arguments together; unrelated process churn is harmless. */
export async function processTable(): Promise<ProcessIdentity[]> {
  const output = await execute(['-axww', '-o', processFormat]);
  const [header = '', ...lines] = output.split('\n');
  if (!new RegExp(`^\\s*PID\\s+START\\s+${executableHeader} COMMAND\\s*$`).test(header)) throw new Error('Invalid process enumeration header.');
  const startOffset = header.indexOf('START');
  const executableOffset = header.indexOf(executableHeader);
  const commandOffset = header.indexOf('COMMAND');
  if (commandOffset !== executableOffset + executableHeader.length + 1) throw new Error('Invalid process enumeration columns.');
  const table: ProcessIdentity[] = [];
  const seen = new Set<number>();
  for (const line of lines.filter((line) => line.trim())) {
    const pidText = line.slice(0, startOffset).trim();
    const pid = Number(pidText);
    const start = line.slice(startOffset, executableOffset).trim().replace(/\s+/g, ' ');
    const executable = line.slice(executableOffset, commandOffset - 1).trimEnd();
    const command = line.slice(commandOffset);
    if (!/^\d+$/.test(pidText) || !Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)
      || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start)
      || !executable.trim() || executable.length >= executableHeader.length
      || line[commandOffset - 1] !== ' ' || !command.trim()) throw new Error('Invalid process identity enumeration.');
    seen.add(pid);
    table.push({ pid, start, executable, command });
  }
  if (!seen.has(process.pid)) throw new Error('Cannot establish this process identity.');
  return table;
}

/** Match actual app executables, not arbitrary mentions of Codex in shell/test commands. */
export function blockingProcesses(table: ProcessIdentity[]): ProcessIdentity[] {
  return table.filter((entry) => {
    // This transaction process names the target in CLI arguments but never loads it.
    if (entry.pid === process.pid) return false;
    const executable = entry.executable;
    if (/\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(executable)) return true;
    if (basename(executable) === 'browser-service' || basename(executable) === 'browser-service.mjs') return true;
    if (!/^(?:node(?:js)?|bun|deno)$/.test(basename(executable))) return false;
    // A browser-service script must be an argument to a runtime, never a substring of shell text.
    return /(?:^|\s)(?:"[^"\n]*\/browser-service\.mjs"|'[^'\n]*\/browser-service\.mjs'|[^\s"']*\/?browser-service\.mjs)(?=\s|$)/.test(entry.command);
  });
}
