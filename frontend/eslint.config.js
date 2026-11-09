import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { readdirSync } from 'node:fs';
import { URL } from 'node:url';
import tseslint from 'typescript-eslint';

const otherFeatures = readdirSync(new URL('./src/features', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'signage')
  .map((entry) => entry.name);

export default tseslint.config(
  { ignores: ['dist', 'src/api/generated'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-hooks 7 added React Compiler diagnostics. This application does not use the React Compiler, so the
      // three rules below only flag patterns that are deliberate here and correct without it:
      // - set-state-in-effect: drafts and dialog state are reset or seeded from server data, props and the URL in
      //   effects, and the remaining findings are media-query and debounce sync. Rewriting them to key/derived state
      //   would change behavior for no benefit.
      // - purity: relative-time displays and "is this in the future" checks read the clock while rendering on purpose;
      //   they are recomputed on every render and never memoized.
      // - incompatible-library: only reports react-hook-form's watch(), which works as documented without the
      //   compiler. useWatch is used where a subscription is needed.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ['**/*.tsx'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // A scrollable region must be keyboard-focusable (WCAG 2.1.1), so tabIndex=0 on role="region" is the correct
      // pattern (ScrollRegion). The recommended default only allows it on interactive-widget roles ("tabpanel").
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'], tags: [] }],
    },
  },
  {
    // Type-aware rules, deliberately limited to the two that catch real bugs (a rejection nobody sees, an async
    // function where a void callback is expected). The rest of the type-checked presets stays off.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // A missing await in a Playwright spec is a real bug, so the e2e suite gets the same two rules. tsconfig.e2e.json
    // only supplies the program for linting: it is not referenced by tsconfig.json because the specs still have type
    // errors (13, in mock data) that `tsc -b` would report; fixing those is outside this change.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: { parserOptions: { project: './tsconfig.e2e.json', tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // The pnpm hook file is CommonJS and runs in Node.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable' } },
  },
  {
    // The standalone signage player (docs/signage.md, "Player app") stays small: no design system, no application shell,
    // no server-state or routing libraries. Type-only imports of generated models are free.
    files: ['src/player/**/*.{ts,tsx}'],
    ignores: ['src/player/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@carbon/*', '@ibm/*'], message: 'The player does not use Carbon.', allowTypeImports: true },
            {
              group: ['@tanstack/*', 'react-router', 'react-router-dom', 'react-hook-form', 'react-markdown'],
              message: 'The player has no server-state, routing or form libraries.',
              allowTypeImports: true,
            },
            {
              group: ['**/app/*', '**/app'],
              message: 'The player must not import the application.',
              allowTypeImports: true,
            },
            {
              group: ['**/api/http-client', '**/api/query-client', '**/api/generated/*/*'],
              message: 'The player uses its own tiny fetch wrapper (src/player/api.ts).',
              allowTypeImports: true,
            },
            // Of the signage feature only engine/, render/ and layouts are shared; src/player/imports.test.ts checks the whole import graph.
            {
              group: otherFeatures.map((name) => `**/features/${name}/**`),
              message: 'The player may only share the signage engine, renderer and layouts.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
