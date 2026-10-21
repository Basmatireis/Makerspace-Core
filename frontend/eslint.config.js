import js from '@eslint/js';
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
