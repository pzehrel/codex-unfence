import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import requiredPreload from './scripts/eslint-test-boundaries.mjs';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.claude/**', 'evidence/**', 'patch-plans/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.ts'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' } },
  },
  {
    files: ['tests/**/*.{mjs,cjs,js,mts,cts,ts}'],
    ignores: ['tests/helpers/cli.mjs', 'tests/helpers/npm-package.mjs'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['node:child_process', 'child_process'].map((name) => ({ name, message: 'Use the shared CLI launcher in tests/helpers/cli.mjs.' })),
      }],
      'no-restricted-syntax': ['error',
        {
          selector: ':matches(CallExpression, ImportExpression) > Literal[value=/^(node:)?child_process$/]',
          message: 'Use the shared CLI launcher in tests/helpers/cli.mjs.',
        },
        {
          selector: ':matches(CallExpression, ImportExpression) > TemplateLiteral[expressions.length=0] > TemplateElement[value.raw=/^(node:)?child_process$/]',
          message: 'Use the shared CLI launcher in tests/helpers/cli.mjs.',
        },
        {
          // The ps fixture may save execFile and install its wrapper, but may not call this launcher directly.
          selector: 'CallExpression[callee.type="MemberExpression"][callee.object.name="childProcess"]:matches([callee.computed=false][callee.property.name="execFile"], [callee.computed=true][callee.property.value="execFile"])',
          message: 'Direct childProcess.execFile calls must use the shared CLI launcher in tests/helpers/cli.mjs.',
        },
        {
          selector: 'CallExpression > MemberExpression.callee[object.name="childProcess"][computed=true] > TemplateLiteral.property[expressions.length=0] > TemplateElement[value.cooked="execFile"]',
          message: 'Direct childProcess.execFile calls must use the shared CLI launcher in tests/helpers/cli.mjs.',
        },
      ],
    },
  },
  {
    files: ['tests/fixtures/npx-final-bin.cjs', 'tests/fixtures/managed-boundaries.cjs'],
    plugins: { 'test-boundaries': { rules: { 'required-preload': requiredPreload } } },
    rules: { 'test-boundaries/required-preload': 'error' },
  },
  {
    files: ['tests/fixtures/npx-final-bin.cjs', 'tests/fixtures/managed-boundaries.cjs', 'tests/fixtures/transaction-boundaries.cjs'],
    rules: {
      // The exact import below patches execFile for synthetic ps output; it cannot launch CLI children.
      'no-restricted-properties': ['error', ...['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork'].map((property) => ({
        object: 'childProcess', property, message: 'Use the shared CLI launcher in tests/helpers/cli.mjs.',
      }))],
    },
  },
);
