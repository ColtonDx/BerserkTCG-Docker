import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverTarget = process.env['VITE_SERVER_PROXY'] ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 so the dev server is reachable from outside the container.
    host: '0.0.0.0',
    port: 5173,
    // `art-assets/` lives at the repo root, outside this app's directory.
    fs: { allow: ['../..'] },
    // Bind-mounted source on Linux/Docker does not always emit inotify events.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
      // Card art is served by the API process too, so `vite dev` shows the
      // real board rather than a grid of broken images.
      '/cards': { target: serverTarget, changeOrigin: true },
      '/socket.io': { target: serverTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
