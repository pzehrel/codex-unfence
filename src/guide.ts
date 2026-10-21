import { createInterface } from 'node:readline';
import type { createManagedPatches, Inspection, Candidate } from './managed-patches.js';
import type { OperationResult } from './result.js';
import { publicActionName, renderHuman } from './result.js';

type Managed = ReturnType<typeof createManagedPatches>;
export async function guide(managed: Managed, selection: { appPath?: string }, action?: string): Promise<OperationResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive stdin and stdout terminals are required for managed changes.');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  async function ask(prompt: string, exact = false) {
    process.stdout.write(prompt);
    const line = await lines.next();
    return line.done ? null : exact ? line.value : line.value.trim();
  }
  let recoveredOperation = false;
  function cancelled() {
    process.stdout.write(recoveredOperation ? 'Recovery completed; subsequent action cancelled. Check the reported file state before reopening the host.\n' : 'Cancelled; installation unchanged.\n');
  }
  try {
    const discovery = await managed.discover(selection);
    for (const diagnostic of discovery.diagnostics) process.stdout.write(`[${diagnostic.code}] ${diagnostic.message}\n`);
    if (!discovery.candidates.length) {
      if (action !== 'install' && action !== 'uninstall') throw new Error('No CUA installation found; provide --app with its absolute path.');
      const conflict = discovery.diagnostics.some(entry => ['PATH_ALIAS', 'IDENTITY_CHANGED', 'TARGET_CHANGED', 'UNTRUSTED_STORE'].includes(entry.code));
      const result: OperationResult = { schemaVersion: 1, command: action, outcome: conflict ? 'conflict' : 'runtime-error', exitCode: conflict ? 4 : 1, data: null, diagnostics: [...discovery.diagnostics, { code: 'NO_INSTALLATIONS', severity: 'error', message: 'No CUA installation found; provide --app with its absolute path.' }] };
      process.stdout.write(renderHuman(result));
      return result;
    }
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
      if (inspection.recovery) process.stdout.write(`Recovery tool: ${inspection.recovery.tool.packageName}@${inspection.recovery.tool.version}; executable: ${inspection.recovery.tool.executable}\nKeep access to the matching tool version and all recovery data.\n`);
      const requested = action ?? await ask(`Action (${[...inspection.allowedActions.map(publicActionName), 'recheck', 'cancel'].join(', ')}): `);
      if (requested === null || requested === 'cancel') { cancelled(); return null; }
      if (requested === 'recheck') { inspection = await managed.inspect(candidate); continue; }
      const command = requested === 'install' ? 'apply' : requested === 'uninstall' ? 'restore' : requested;
      if (command !== 'apply' && command !== 'restore' && command !== 'recover') throw new Error('Choose a listed action.');
      if ((requested === 'install' || requested === 'uninstall') && inspection.state === 'incomplete' && inspection.allowedActions.includes('recover')) {
        process.stdout.write('An interrupted operation must be rolled back before continuing. Recovery returns to its before state; it does not finish that operation.\nExit the host and related services yourself before writing.\n');
        const confirmed = await ask('Type yes to recover before continuing, anything else cancels: ', true);
        if (confirmed !== 'yes') { cancelled(); return null; }
        if (!inspection.inspectionToken) throw new Error('No verified inspection token; inspect again.');
        const recovered = await managed.recover({ candidate: inspection.candidate, inspectionToken: inspection.inspectionToken, confirmed: true });
        process.stdout.write(renderHuman(recovered));
        if (recovered.exitCode !== 0) {
          process.stdout.write('Recovery did not complete. Keep recovery data and run check before reopening the host.\n');
          return recovered;
        }
        recoveredOperation = true;
        inspection = await managed.inspect(candidate);
        continue;
      }
      if (requested === 'uninstall' && inspection.state === 'original' && !inspection.recovery && inspection.support === 'supported' && inspection.writeReadiness === 'ready') {
        process.stdout.write('uninstall: success\nAlready uninstalled; original file unchanged.\nRuntime: not-verified.\n');
        return null;
      }
      if (!inspection.allowedActions.includes(command)) {
        process.stdout.write(`Action ${publicActionName(command)} is unavailable; resolve the diagnostics and recheck.\n`);
        if (!action) continue;
        const choice = await ask('Action (recheck, cancel): ');
        if (choice !== 'recheck') {
          const outcome = inspection.writeReadiness === 'unknown' || inspection.operation?.outcome === 'runtime-error' ? 'runtime-error'
            : inspection.state === 'conflict' || inspection.blockers.length ? 'conflict' : 'incompatible';
          const result: OperationResult = { schemaVersion: 1, command: requested === 'install' || requested === 'uninstall' ? requested : command, outcome, exitCode: outcome === 'runtime-error' ? 1 : outcome === 'conflict' ? 4 : 3, data: null, diagnostics: [...inspection.diagnostics, ...inspection.blockers] };
          process.stdout.write(renderHuman(result));
          return result;
        }
        inspection = await managed.inspect(candidate);
        continue;
      }
      for (const evidence of inspection.derivation?.evidence ?? []) process.stdout.write(`Support: ${evidence.description}\n`);
      for (const assumption of inspection.derivation?.assumptions ?? []) process.stdout.write(`Assumption: ${assumption}\n`);
      process.stdout.write(`Target: ${inspection.candidate.targetPath}\nScope: site-status response only; original request and predicate stay.\nBackups and recovery data remain private outside npm cache.\nChanging sealed resources invalidates the application signature; this tool does not sign it.\nExit the host and related services yourself before writing.\n${command === 'recover' ? 'Recover rolls back to the interrupted operation before state; it never continues apply or restore.\n' : ''}`);
      const confirmed = await ask(`Type yes to ${publicActionName(command)}, anything else cancels: `, true);
      if (confirmed !== 'yes') { cancelled(); return null; }
      if (!inspection.inspectionToken) throw new Error('No verified inspection token; inspect again.');
      const result = await managed[command]({ candidate: inspection.candidate, inspectionToken: inspection.inspectionToken, confirmed: true });
      process.stdout.write(renderHuman({ ...result, command: requested === 'install' || requested === 'uninstall' ? requested : result.command }));
      if (result.exitCode === 0) {
        process.stdout.write('Runtime: not-verified. Reopen the host manually after checking the reported file state.\n');
        if (result.data?.targets.some(target => target.state === 'tool-applied')) process.stdout.write('The patch persists until uninstall.\n');
      } else process.stdout.write('Operation did not complete successfully. Keep recovery data and run check before reopening the host; rerun install or uninstall to recover an incomplete operation.\n');
      process.stdout.write('Keep the matching tool version and recovery data; npm cache is separate from recovery data.\n');
      return result;
    }
  } finally { input.close(); }
}
