import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

// Only the declaration-level dead code that knip cannot see. Style rules stay out
// so that scripts/check-dead-code.cjs can count issues and compare them to a baseline.
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
];
