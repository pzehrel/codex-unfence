// Synthetic public business-API driver; no production command or test switches.
import { writeFile } from 'node:fs/promises';
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
  const manager = createManagedPatches({ derive: deriveCua, tool: { packageName: 'codex-unfence', version: '9.8.7-synthetic', executable: 'codex-unfence' } });
  if (command === 'inspect' || command === 'status') result = await manager[command](selection);
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
