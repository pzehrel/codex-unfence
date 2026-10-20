import { createInterface } from 'node:readline';
import type { createManagedPatches, Inspection, Candidate } from './managed-patches.js';
import type { OperationResult } from './result.js';
import { renderHuman } from './result.js';

type Managed = ReturnType<typeof createManagedPatches>;
export async function guide(managed: Managed, selection: { appPath?: string }, action?: 'apply' | 'restore' | 'recover'): Promise<OperationResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive stdin and stdout terminals are required for managed changes.');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  async function ask(prompt: string) {
    process.stdout.write(prompt);
    const line = await lines.next();
    return line.done ? null : line.value.trim();
  }
  try {
    const discovery = await managed.discover(selection);
    for (const diagnostic of discovery.diagnostics) process.stdout.write(`[${diagnostic.code}] ${diagnostic.message}\n`);
    if (!discovery.candidates.length) throw new Error('No CUA installation found; provide --app with its absolute path.');
    let candidate: Candidate | undefined = discovery.candidates[0];
    if (discovery.candidates.length > 1) {
      discovery.candidates.forEach((entry, index) => process.stdout.write(`${index + 1}. ${entry.appPath}\n`));
      const choice = await ask('Select installation number, or cancel: ');
      if (choice === null || choice === 'cancel') return null;
      candidate = /^\d+$/.test(choice) ? discovery.candidates[Number(choice) - 1] : undefined;
      if (!candidate) throw new Error('Select one listed installation number.');
    }
    if (!candidate) throw new Error('No installation selected.');
    let inspection: Inspection = await managed.inspect(candidate);
    while (true) {
      process.stdout.write(`Installation: ${inspection.candidate.appPath}\nTarget: ${inspection.candidate.targetPath}\nStructural support: ${inspection.support}; file state: ${inspection.state}; write readiness: ${inspection.writeReadiness}\n`);
      for (const diagnostic of [...inspection.diagnostics, ...inspection.blockers]) process.stdout.write(`[${diagnostic.code}] ${diagnostic.message}\n`);
      const command = action ?? await ask('Action (apply, restore, recover, recheck, cancel): ');
      if (command === null || command === 'cancel') { process.stdout.write('Cancelled; installation unchanged.\n'); return null; }
      if (command === 'recheck') { inspection = await managed.inspect(candidate); continue; }
      if (command !== 'apply' && command !== 'restore' && command !== 'recover') throw new Error('Choose a listed action.');
      process.stdout.write(`Target: ${inspection.candidate.targetPath}\nScope: site-status response only; original request and predicate stay.\nBackups and recovery data remain private outside npm cache.\nChanging sealed resources invalidates the application signature; this tool does not sign it.\nExit the host and related services yourself before writing.\n${command === 'recover' ? 'Recover rolls back to the interrupted operation before state; it never continues apply or restore.\n' : ''}`);
      const confirmed = await ask(`Type yes to ${command}, anything else cancels: `);
      if (confirmed !== 'yes') { process.stdout.write('Cancelled; installation unchanged.\n'); return null; }
      if (!inspection.inspectionToken) throw new Error('No verified inspection token; inspect again.');
      const result = await managed[command]({ candidate: inspection.candidate, inspectionToken: inspection.inspectionToken, confirmed: true });
      process.stdout.write(renderHuman(result));
      process.stdout.write('Runtime: not-verified. Reopen the host manually. The patch persists until restore.\nUse the same local package tarball to run status or restore; npm cache is separate from recovery data.\n');
      return result;
    }
  } finally { input.close(); }
}
