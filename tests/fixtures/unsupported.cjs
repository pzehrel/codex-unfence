// Explicit child-process fixture for the production platform guard.
Object.defineProperty(process, 'platform', { value: 'linux' });
