// Synthetic public business-API driver; no production command or test switches.
import { discoverInstallations } from '../../dist/installations.js';
const [command, payload] = process.argv.slice(2);
const selection = JSON.parse(payload);
let result;
if (command === 'discover') result = await discoverInstallations(selection);
else {
  const { deriveCua } = await import('../../dist/cua-analysis.js');
  const { createManagedPatches } = await import('../../dist/managed-patches.js');
  const manager = createManagedPatches({ derive: deriveCua, tool: { packageName: 'codex-browser-liberation-patch', version: '9.8.7-synthetic', executable: 'codex-browser-patch' } });
  if (command === 'inspect' || command === 'status') result = await manager[command](selection);
  else if (['apply', 'restore', 'recover'].includes(command)) {
    const inspection = await manager.inspect(selection);
    result = await manager[command]({ candidate: selection, inspectionToken: inspection.inspectionToken, confirmed: true });
  } else throw new Error('Unknown test driver command.');
}
process.stdout.write(JSON.stringify(result) + '\n');
