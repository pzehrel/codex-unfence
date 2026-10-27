import { CUA_SCHEME } from './cua-contract.js';
import { detectCuaPatch } from './cua-patch-detection.js';
import type { DeriveCua } from './cua-contract.js';
import { copyManagedPlan, loadManagedPlan, managedRecord } from './managed-state.js';
import { blockingProcesses } from './processes.js';
import type { ProcessIdentity } from './processes.js';
import { basename } from 'node:path';
import { transactionExecutor } from './transaction-engine.js';
import { check } from './transaction-storage.js';

export function cuaBlockingProcesses(table: ProcessIdentity[]): ProcessIdentity[] {
  const common = new Set(blockingProcesses(table));
  return table.filter((entry) => entry.pid !== process.pid && (common.has(entry) || /^node_repl(?:[.-].*)?$/.test(basename(entry.executable))));
}

/** The only adapter admitting dynamically derived CUA bytes to the transaction engine. */
export function cuaExecutor(derive: DeriveCua) {
  return transactionExecutor({
    scheme: CUA_SCHEME,
    async loadSelected(options) {
      check(options.plan, 'SELECTION_REQUIRED', 'Managed preparation is required.');
      return loadManagedPlan(options.plan, derive);
    },
    loadStored(directory) { return loadManagedPlan(directory, derive); },
    copy(plan, destination) { return copyManagedPlan(plan, destination, derive); },
    unselected(_path, bytes) {
      const source = bytes.toString('utf8');
      if (!Buffer.from(source).equals(bytes)) return { state: 'incompatible', diagnostics: [{ code: 'INVALID_SOURCE', severity: 'error', message: 'Target must be lossless UTF-8.' }] };
      const detected = detectCuaPatch(source);
      if (detected) return { state: 'tool-applied', diagnostics: [{ code: 'PATCH_DETECTED', severity: 'info', message: 'The complete known patch is present at the site-status JSON result. Recovery records are verified separately.' }, { code: 'RECOVERY_UNAVAILABLE', severity: 'warning', message: 'Patch detected from source, but no trusted recovery record is available. Automatic uninstall is unavailable.' }] };
      const derived = derive(source);
      return { state: derived.support === 'supported' ? 'original' : 'incompatible', diagnostics: [...derived.diagnostics] };
    },
    async validateSelected(plan) {
      for (const item of plan.targets) {
        const current = await managedRecord(item.target.identity.path, derive);
        check(current?.plan.manifest.contentHash === plan.manifest.contentHash, 'INSPECTION_CHANGED', 'Managed selection changed while acquiring locks.');
      }
    },
    blockingProcesses: cuaBlockingProcesses,
  });
}
