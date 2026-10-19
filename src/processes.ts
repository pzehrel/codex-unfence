import { execFile } from 'node:child_process';
import { basename } from 'node:path';

function execute(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}
export const PROCESS_LIMITATION = 'Process checks use ps snapshots and executable/argument identities; processes may start after inspection. No process is terminated. Runtime loading and website operation remain not-verified.';

export interface ProcessIdentity {
  pid: number;
  start: string;
  executable: string;
  command: string;
}

/** Fail closed when either executable identity or command enumeration is unavailable. */
export async function processTable(): Promise<ProcessIdentity[]> {
  const identities = await execute(['-axww', '-o', 'pid=,lstart=,comm=']);
  const commands = await execute(['-axww', '-o', 'pid=,command=']);
  const args = new Map<number, string>();
  for (const line of commands.split('\n').filter((line) => line.trim())) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || args.has(Number(match[1]))) throw new Error('Invalid process command enumeration.');
    if (/^\/?(?:bin\/)?ps\s+-axww\s+-o\s+pid=,command=$/.test(match[2] ?? '')) continue;
    args.set(Number(match[1]), match[2] ?? '');
  }
  const table: ProcessIdentity[] = [];
  const seen = new Set<number>();
  for (const line of identities.split('\n').filter((line) => line.trim())) {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) throw new Error('Invalid process executable enumeration.');
    const pid = Number(match[1]);
    if (match[3] === '/bin/ps' || match[3] === 'ps') continue;
    if (seen.has(pid) || !args.has(pid)) throw new Error('Process enumeration changed; retry after processes settle.');
    seen.add(pid);
    table.push({ pid, start: (match[2] ?? '').replace(/\s+/g, ' '), executable: match[3] ?? '', command: args.get(pid) ?? '' });
  }
  if ([...args.keys()].some((pid) => !seen.has(pid))) throw new Error('Process enumeration changed; retry after processes settle.');
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
