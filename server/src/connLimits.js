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

export const MAX_CONNECTIONS_PER_IP = 150;
export const JOIN_WITHIN_MS = 60_000;

/**
 * The visitor's real address, and which header it came from (for the log).
 * Used by BOTH kinds of limit — live connections here, and the web requests'
 * limits in index.js (visitorIp) — so a visitor counts the same everywhere.
 *
 * Requests reach the server through Cloudflare and Render's proxy, so the
 * raw address is the proxy's — the same for everyone. In order:
 *   1. CF-Connecting-IP: set by Cloudflare, so a visitor can't fake it
 *   2. the LAST X-Forwarded-For entry: the one Render's own proxy added. (The
 *      first entry is whatever the visitor's browser claimed — easy to fake,
 *      which would let one person dodge the limits.)
 *   3. the raw address (local development, no proxy)
 * `handshake` is a Socket.IO handshake, or anything shaped like one:
 * { headers, address }.
 */
export function clientIp(handshake) {
  const h = handshake?.headers ?? {};
  const cf = String(h['cf-connecting-ip'] ?? '').trim();
  if (cf) return { ip: cf, from: 'cf-connecting-ip' };
  const xff = String(h['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  if (xff) return { ip: xff, from: 'x-forwarded-for' };
  return { ip: String(handshake?.address ?? 'unknown'), from: 'socket' };
}

// Which header visitors' addresses come from, logged once per kind per server
// start (never the address itself), so the proxy setup can be checked in the
// logs: "cf-connecting-ip" is the expected one on Render.
const sourcesSeen = new Set();
export function noteAddressSource(from) {
  if (sourcesSeen.has(from)) return;
  sourcesSeen.add(from);
  console.log(`[ip] visitor addresses are coming from: ${from}`);
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
