// Explicit child-process fixture. Never shipped in the npm package.
// Allows the macOS discovery contract to run on CI without a Codex installation.
Object.defineProperty(process, 'platform', { value: 'darwin' });
