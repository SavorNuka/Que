import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'resources/**',
      /**
       * The sanity-test harnesses (docs/ASSUMPTIONS.md "Test artifacts").
       *
       * Excluded on principle, not to get a green build. These are
       * point-in-time records: docs/PROCESS.md commits to never editing them,
       * because their value is being an honest account of what was run and
       * what it returned. Linting a file you have undertaken not to change
       * can only produce pressure to change it.
       *
       * They are also nothing like application code — CommonJS and ESM side by
       * side, and skin-sandbox2.js is half Node and half Chromium page, so any
       * globals list that satisfied it would be a lie told to every other file.
       * Nothing imports them; they are run directly and their output IS the
       * check, so a broken harness announces itself on the first run.
       *
       * The test for a legitimate exclusion: would linting this ever prevent a
       * defect that reaches a user? Here, no. A lint failure under src/ or
       * tests/ is never resolved this way.
       */
      'docs/sanity-tests/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
    },
  },
  {
    /**
     * The hooks rules exist specifically to catch dependency-array mistakes.
     * Their absence is part of why M0 shipped a useAsync that re-ran its effect
     * on every render — 4,559 IPC calls in 300 ms. See docs/AAR-M0.md.
     */
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Scripts are plain Node ESM, not part of the typed program.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  }
);
