// Fixed room links on this side (see server/src/names.js): reading the room
// from the address (?room=gracechurch, or the short form /gracechurch), and
// remembering host keys on this device so the owner is always the host.

const KEYS = 'turnly.hostKeys'; // { name: hostKey }

// Same rules as the server: 3-30 lowercase letters / numbers / hyphens. A
// generated meeting code ("abc-defg-hij") is a code, not a name.
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// Paths that are pages of the site, never a room (see main.jsx).
const PAGES = new Set(['start', 'demo', 'privacy']);
export const looksLikeName = (id) => NAME_RE.test(id) && !CODE_RE.test(id) && !PAGES.has(id);

/** Turn "Grace Church!" into "gracechurch" (a suggestion while typing). */
export function nameFromTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30);
}

function readKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(KEYS) ?? '{}');
    return keys && typeof keys === 'object' ? keys : {};
  } catch {
    return {};
  }
}

/** The host key this device has for a room name, if any. */
export const hostKeyFor = (name) => readKeys()[String(name ?? '').toLowerCase()] ?? null;

/** Remember a host key on this device. */
export function saveHostKey(name, key) {
  if (!name || !key) return;
  try {
    localStorage.setItem(KEYS, JSON.stringify({ ...readKeys(), [name.toLowerCase()]: key }));
  } catch {
    // storage blocked: the host link still works, it just isn't remembered
  }
}

/**
 * The room in the address: ?room=… or the short /name form. A host link's
 * ?key=… is saved on this device and taken out of the address bar, so it
 * isn't shared by accident when someone copies the address.
 */
export function readRoomFromUrl() {
  const url = new URL(window.location.href);
  let room = url.searchParams.get('room') ?? '';
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!room && path && !path.includes('/') && looksLikeName(path.toLowerCase())) {
    room = path.toLowerCase();
  }
  const key = url.searchParams.get('key');
  if (key && room) {
    saveHostKey(room, key);
    url.searchParams.delete('key');
    window.history.replaceState({}, '', url);
  }
  return room;
}

/** The two links for a claimed name: the one to share, and the private host link. */
export function nameLinks(name, hostKey) {
  const share = `${window.location.origin}/${name}`;
  return { share, host: `${share}?key=${encodeURIComponent(hostKey)}` };
}

/** The fixed room names this device is the host of (for scheduling on one). */
export const ownedNames = () => Object.keys(readKeys()).filter(looksLikeName).sort();
