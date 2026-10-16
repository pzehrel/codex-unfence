import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.claude/**', 'evidence/**', 'patch-plans/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.ts'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' } },
  },
);
