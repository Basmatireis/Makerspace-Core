import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  resolve: {
    alias: {
      '~@ibm/plex': fileURLToPath(new URL('./node_modules/@ibm/plex', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
