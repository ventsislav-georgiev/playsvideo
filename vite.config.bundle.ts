import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist-bundle',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'bundle.html'),
    },
  },
  base: './',
  worker: {
    format: 'es',
  },
});
