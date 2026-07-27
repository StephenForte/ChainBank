import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is a build-time artifact served as static files by the Fastify
// web service, so it emits into the same dist tree as the compiled server.
export default defineConfig({
  root: 'dashboard',
  plugins: [react()],
  build: {
    outDir: '../dist/dashboard',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
});
