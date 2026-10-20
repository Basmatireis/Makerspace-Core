import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// The standalone signage player lives at /player/ (nginx serves player.html there); the dev and preview servers do the same.
function playerRoute(): Plugin {
  const rewrite = (request: { url?: string }, _response: unknown, next: () => void) => {
    const path = request.url?.split('?')[0];
    if (path === '/player' || path === '/player/') request.url = '/player.html';
    next();
  };
  return {
    name: 'player-route',
    configureServer: (server) => { server.middlewares.use(rewrite); },
    configurePreviewServer: (server) => { server.middlewares.use(rewrite); },
  };
}

export default defineConfig({
  plugins: [react(), playerRoute()],
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
