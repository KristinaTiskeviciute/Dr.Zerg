import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // In development the relay runs separately (`npm run dev:server`, port 8787).
    proxy: {
      '/parties': { target: 'http://localhost:8787', ws: true },
    },
  },
});
