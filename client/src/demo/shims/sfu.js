// The browser's stand-in for the server's sfu.js (see vite.config.js): the
// demo has no Cloudflare SFU — its calls use direct connections.
export const sfuEnabled = () => false;
