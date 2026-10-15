import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The landing page's live demo runs the server's own meeting rules in the
// browser (server/src/rooms.js + activities.js — see src/demo/demoServer.js).
// Those two files import two server-only things; in the browser they get
// small stand-ins instead (src/demo/shims/).
const serverInBrowser = {
  name: 'turnly-server-in-browser',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !importer.replace(/\\/g, '/').includes('/server/src/')) return null;
    if (source === 'node:crypto') return path.resolve(__dirname, 'src/demo/shims/crypto.js');
    if (source === './sfu.js') return path.resolve(__dirname, 'src/demo/shims/sfu.js');
    return null;
  },
};

export default defineConfig({
  plugins: [serverInBrowser, react()],
  // Read .env from the repo root, not from client/.
  envDir: path.resolve(__dirname, '..'),
  server: {
    port: 5173,
  },
});
