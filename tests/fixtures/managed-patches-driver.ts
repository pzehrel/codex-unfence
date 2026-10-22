// Synthetic public business-API driver; no production command or test switches.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candidate } from '../../src/installations.js';
import { discoverInstallations } from '../../src/installations.js';
const [command, payload] = process.argv.slice(2);
if (!payload) throw new Error('Test driver payload is required.');
const selection: Candidate = JSON.parse(payload);
let result;
if (command === 'discover') result = await discoverInstallations(selection);
else {
  const { deriveCua } = await import('../../src/cua-analysis.js');
  const { createManagedPatches } = await import('../../src/managed-patches.js');
  let derivations = 0;
  const manager = createManagedPatches({ derive(source) { derivations++; return deriveCua(source); }, tool: { packageName: 'codex-unfence', version: '9.8.7-synthetic', executable: 'codex-unfence' } });
  if (command === 'legacy-apply') {
    const { deriveCua: historical } = await import('../../src/cua-legacy-analysis.js');
    const previous = createManagedPatches({ derive: historical, tool: { packageName: 'codex-unfence', version: '0.2.0', executable: 'codex-unfence' } });
    const inspection = await previous.inspect(selection);
    result = await previous.apply({ candidate: selection, inspectionToken: inspection.inspectionToken ?? '', confirmed: true });
  } else if (command === 'repeat-validation') {
    const steps = [];
    for (const action of ['apply', 'apply', 'restore', 'restore', 'apply'] as const) {
      const inspection = await manager.inspect(selection);
      derivations = 0;
      const before = await stat(selection.targetPath, { bigint: true });
      const operation = await manager[action]({ candidate: selection, inspectionToken: inspection.inspectionToken ?? '', confirmed: true });
      const after = await stat(selection.targetPath, { bigint: true });
      steps.push({ operation, derivations, identityUnchanged: before.ino === after.ino && before.mtimeNs === after.mtimeNs });
    }
    result = { steps };
  } else if (command === 'inspect-after-mutation') {
    const before = await manager.inspect(selection);
    if (!before.recovery) throw new Error('Expected managed preparation.');
    if (before.derivation) {
      Object.assign(before.derivation, { support: 'unsupported', change: null, diagnostics: [{ code: 'CALLER_MUTATION', severity: 'error', message: 'Synthetic caller edit.' }] });
    }
    const independent = await manager.inspect(selection);
    const path = join(before.recovery.preparation, 'source.original.mjs');
    const bytes = await readFile(path);
    await writeFile(path, '// changed between public operations\n');
    const changed = await manager.inspect(selection);
    await writeFile(path, bytes);
    const restored = await manager.inspect(selection);
    result = { independent, changed, restored };
  } else if (command === 'inspect' || command === 'status') result = await manager[command](selection);
  else if (command === 'apply' || command === 'restore' || command === 'recover') {
    const inspection = await manager.inspect(selection);
    result = await manager[command]({ candidate: selection, inspectionToken: inspection.inspectionToken ?? '', confirmed: true });
  } else if (command === 'stale-confirmation') {
    const inspection = await manager.inspect(selection);
    await writeFile(selection.targetPath, '// changed after check\n');
    result = await manager.apply({ candidate: selection, inspectionToken: inspection.inspectionToken ?? '', confirmed: true });
  } else throw new Error('Unknown test driver command.');
}
process.stdout.write(JSON.stringify(result) + '\n');
