// Synthetic public business-API driver; no production command or test switches.
import { discoverInstallations } from '../../dist/installations.js';
const [command, payload] = process.argv.slice(2);
if (command !== 'discover') throw new Error('Unknown test driver command.');
process.stdout.write(JSON.stringify(await discoverInstallations(JSON.parse(payload))) + '\n');
