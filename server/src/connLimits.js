// Limits on raw connections, so nobody can flood the server's memory.
//
// Every Socket.IO connection may send big messages (chat files, recording
// pieces), and the server is small. Without limits, someone could open dozens
// of connections that never join a meeting and push junk until the server
// runs out of memory — ending every meeting. So (index.js, io.use + the
// connection handler):
//   - at most MAX_CONNECTIONS_PER_IP open connections per visitor address —
//     generous on purpose: a church hall, office, school or mobile network
//     often shows up as ONE address for many real people
//   - a connection that hasn't asked to join or rejoin a meeting within
//     JOIN_WITHIN_MS is closed (the app always asks straight after
//     connecting; people knocking or on "You left · Rejoin" have asked)

export const MAX_CONNECTIONS_PER_IP = 50;
export const JOIN_WITHIN_MS = 60_000;

/**
 * The visitor's real address, and which header it came from (for the log).
 * Requests reach the server through Cloudflare and Render's proxy, so the
 * raw address is the proxy's — the same for everyone. Cloudflare puts the
 * real one in CF-Connecting-IP (set by Cloudflare, so a visitor can't fake
 * it); failing that, the first X-Forwarded-For entry; failing that, the raw
 * address (local development).
 */
export function clientIp(handshake) {
  const h = handshake?.headers ?? {};
  const cf = String(h['cf-connecting-ip'] ?? '').trim();
  if (cf) return { ip: cf, from: 'cf-connecting-ip' };
  const xff = String(h['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
  if (xff) return { ip: xff, from: 'x-forwarded-for' };
  return { ip: String(handshake?.address ?? 'unknown'), from: 'socket' };
}

/** Counts open connections per address; refuses beyond `max`. */
export function createConnectionCounter(max = MAX_CONNECTIONS_PER_IP) {
  const counts = new Map(); // ip -> open connections
  return {
    /** Count one more connection from `ip`; false if it's over the limit. */
    tryAdd(ip) {
      const n = counts.get(ip) ?? 0;
      if (n >= max) return false;
      counts.set(ip, n + 1);
      return true;
    },
    /** One connection from `ip` closed. */
    remove(ip) {
      const n = (counts.get(ip) ?? 0) - 1;
      if (n > 0) counts.set(ip, n);
      else counts.delete(ip);
    },
    count: (ip) => counts.get(ip) ?? 0,
  };
}
