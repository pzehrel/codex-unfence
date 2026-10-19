import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeSource } from './analysis.js';
import { loadPlan } from './plan.js';
import { blockingProcesses } from './processes.js';
import { transactionExecutor } from './transaction-engine.js';
import { check, regularBytes, syncDirectory, writeExclusive } from './transaction-storage.js';

// Legacy admission stays exclusively loadPlan: no profile fallback, format change
// or new interpretation of historical structural plans and signed journals.
const executor = transactionExecutor({
  scheme: 'structural',
  loadSelected: (options) => loadPlan(options.plan ?? ''),
  loadStored: loadPlan,
  async copy(plan, destination) {
    await mkdir(destination, { mode: 0o700 });
    await mkdir(join(destination, 'contents'), { mode: 0o700 });
    for (const file of await readdir(join(plan.directory, 'contents'))) {
      await writeExclusive(join(destination, 'contents', file), await regularBytes(join(plan.directory, 'contents', file)));
    }
    await writeExclusive(join(destination, 'complete.json'), await regularBytes(join(plan.directory, 'complete.json')));
    await syncDirectory(join(destination, 'contents'));
    await syncDirectory(destination);
    const copied = await loadPlan(destination);
    check(copied.manifest.contentHash === plan.manifest.contentHash, 'PLAN_CHANGED', 'Plan changed while copying.');
  },
  unselected(_path, bytes) {
    const analysis = analyzeSource(bytes.toString('utf8'));
    const untrusted = analysis.diagnostics.some((entry) => entry.code === 'UNTRUSTED_PATCHED_SHAPE');
    return { state: untrusted ? 'conflict' : analysis.compatibility === 'compatible' ? 'original' : 'incompatible', diagnostics: analysis.diagnostics };
  },
  blockingProcesses,
});

export const { apply, restore, status, recover } = executor;
