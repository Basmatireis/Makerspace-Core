import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { playerShellFiles, type BuildManifest } from './src/player/shellFiles.ts';

// The standalone signage player lives at /player/ (nginx serves player.html there); the dev and preview servers do the same.
function playerRoute(): Plugin {
  const rewrite = (request: { url?: string }, _response: unknown, next: () => void) => {
    const path = request.url?.split('?')[0];
    if (path === '/player' || path === '/player/') request.url = '/player.html';
    next();
  };
  return {
    name: 'player-route',
    configureServer: (server) => {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(rewrite);
    },
  };
}

// The player's service worker (src/player/sw.ts) is a third build entry with a stable file name, /player/sw.js. After the
// build this fills in the hashed files of the player entry (from the build manifest) that the worker precaches, plus a
// hash of that list: the worker file changes exactly when the player shell changes, which makes browsers update it.
// Lazy chunks (the rich text renderer) are precached too: a display that starts offline must be able to load them.
function playerServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'player-service-worker',
    apply: 'build',
    configResolved: (config) => {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      handler() {
        const manifest = JSON.parse(readFileSync(resolve(outDir, '.vite/manifest.json'), 'utf8')) as BuildManifest;
        const list = playerShellFiles(manifest);
        const version = createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 12);
        const path = resolve(outDir, 'player/sw.js');
        let code = readFileSync(path, 'utf8');
        const before = code;
        code = code
          .replace(/(["'`])__PLAYER_SHELL_FILES__\1/, JSON.stringify(list))
          .replace(/__PLAYER_SHELL_VERSION__/, version);
        if (code === before) throw new Error('player service worker: placeholders not found in player/sw.js');
        writeFileSync(path, code);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), playerRoute(), playerServiceWorker()],
  resolve: {
    alias: {
      '~@ibm/plex': fileURLToPath(new URL('./node_modules/@ibm/plex', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        player: fileURLToPath(new URL('./player.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/player/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'player/sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET ?? 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});
