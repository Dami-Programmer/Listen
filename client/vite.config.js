import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Read .env from the repo root, not from client/.
  envDir: path.resolve(__dirname, '..'),
  server: {
    port: 5173,
  },
});
