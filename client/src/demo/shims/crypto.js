// The browser's stand-in for Node's 'node:crypto' — the only part the
// server's rooms.js / activities.js use (see vite.config.js).
export const randomUUID = () => globalThis.crypto.randomUUID();
