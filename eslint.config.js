import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'drizzle/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'scripts/print-database-ca.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/require-await': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Number']",
          message: 'Never convert blockchain quantities to floating-point numbers.',
        },
      ],
    },
  },
  {
    // Domain modules stay free of framework, database, network, and environment access.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', 'drizzle-orm*', 'viem*', 'resend', 'pg', '**/infrastructure/**'],
              message: 'Domain modules must not depend on frameworks or infrastructure.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Domain modules must not read environment variables.',
        },
      ],
    },
  },
  {
    // Only the composition root and configuration layer may read the environment.
    files: ['src/**/*.ts'],
    ignores: ['src/config/**', 'src/api/server.ts', 'src/jobs/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through src/config instead of process.env.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'src/observability/**/*.ts', 'src/jobs/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Plain Node scripts sit outside every tsconfig, so no-undef needs the
    // runtime globals declared explicitly.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    files: ['dashboard/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './dashboard/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
);
