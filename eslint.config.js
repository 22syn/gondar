import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      // Off for TypeScript on typescript-eslint's own advice: tsc already errors
      // on genuinely undefined identifiers (verified: TS2304), while eslint
      // cannot see type space and false-positives on type-only globals. This
      // cost a full day of red CI on 2026-07-26 (`RequestInit` in telegramBot.ts)
      // — and since ci.yml runs lint -> build -> test, it skipped build and test
      // entirely. Declaring globals one at a time only defers the next instance.
      'no-undef': 'off',
    },
  },
];
