// Fixed room links: a group claims a name (e.g. "gracechurch") and uses the
// same link every week — turnly.io/gracechurch — instead of a new code each
// time.
//
// No accounts, so ownership is a secret: claiming a name hands back a HOST
// KEY, once. Joining with it makes you the host of that room, every time —
// even if guests got there first. Without it you're a normal guest; if the
// host hasn't arrived yet you wait ("Waiting for the host to start").
//
// Each name is a small file in storage (storage.js — R2, or a folder when
// developing): names/<name>.json = { name, title, keyHash, createdAt,
// startsAt?, durationMin?, scheduled? }.
//
// Scheduling (scheduleMeeting) uses the same thing: a scheduled meeting is a
// claimed room — a fresh meeting code, or one of your names — with a start
// time, so whoever scheduled it is the host and guests who come early wait.
// One-off scheduled meetings are deleted a day after they end (sweepNames).
// Only a hash of the key is kept, so even someone who could read the
// storage couldn't host your room.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { deleteObject, getText, listKeys, putObject, putObjectIfNew } from './storage.js';

// 3-30 characters: lowercase letters, numbers, and hyphens between them.
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
// The shape of a generated meeting code ("abc-defg-hij") stays for codes.
const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// Words that look official or clash with the site's own pages.
const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'help',
  'host',
  'login',
  'new',
  'start', // the app's home screen (/start — the landing page is /)
  'demo', // the landing page's live demo (/demo)
  'rec',
  'recording',
  'recordings',
  'settings',
  'support',
  'turnly',
  'www',
]);

/** Is this usable as a room name? (Lowercase it first.) */
export function validName(name) {
  return (
    typeof name === 'string' && NAME_RE.test(name) && !CODE_RE.test(name) && !RESERVED.has(name)
  );
}

const keyOf = (name) => `names/${name}.json`;
const hash = (key) => createHash('sha256').update(String(key)).digest();

// Recently looked-up names (claimed records, or null = free), so every join
// doesn't wait on storage. A claim updates it straight away.
const cache = new Map(); // name -> { record, at }
const CACHE_MS = 5 * 60 * 1000;

// Anything shaped like a room id we might have on file: a name, or a
// meeting code (a scheduled meeting's room).
export const mightBeClaimed = (id) => typeof id === 'string' && NAME_RE.test(id);

/** The claimed record for a name (or scheduled code), or null if none. */
export async function lookupName(name) {
  if (!mightBeClaimed(name)) return null;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.record;
  const text = await getText(keyOf(name));
  let record = null;
  try {
    record = text ? JSON.parse(text) : null;
  } catch {
    record = null;
  }
  cache.set(name, { record, at: Date.now() });
  return record;
}

/**
 * Claim a name. Returns { ok: true, hostKey } — the key is shown ONCE — or
 * { ok: false, error } ('invalid' / 'taken').
 */
export async function claimName(name, title, extra = {}, { allowCode = false } = {}) {
  const ok = allowCode ? mightBeClaimed(name) && !RESERVED.has(name) : validName(name);
  if (!ok) return { ok: false, error: 'invalid' };
  if (await lookupName(name)) return { ok: false, error: 'taken' };
  const hostKey = randomBytes(18).toString('base64url');
  const record = {
    name,
    title: String(title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80),
    keyHash: hash(hostKey).toString('hex'),
    createdAt: Date.now(),
    ...extra,
  };
  const saved = await putObjectIfNew(
    keyOf(name),
    Buffer.from(JSON.stringify(record)),
    'application/json',
  );
  if (!saved) {
    cache.delete(name);
    return { ok: false, error: 'taken' };
  }
  cache.set(name, { record, at: Date.now() });
  return { ok: true, hostKey };
}

/** Does this key make you the host of this claimed name? */
export function isHostKey(record, key) {
  if (!record || typeof key !== 'string' || !key) return false;
  const expected = Buffer.from(record.keyHash, 'hex');
  const given = hash(key);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/* --------------------------------------------------------------------------
 * Scheduling
 * ------------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;
const cleanTitle = (t) =>
  String(t ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

// A meeting code like the app's own ("abc-defg-hij").
function newCode() {
  const letters = [...randomBytes(10)].map((n) => String.fromCharCode(97 + (n % 26))).join('');
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

/** Is this a sensible start time / length? (Within the next year.) */
export function validSchedule(startsAt, durationMin) {
  return (
    Number.isFinite(startsAt) &&
    startsAt > Date.now() - DAY_MS &&
    startsAt < Date.now() + 366 * DAY_MS &&
    Number.isInteger(durationMin) &&
    durationMin >= 5 &&
    durationMin <= 12 * 60
  );
}

/**
 * Schedule a meeting on a fresh meeting code. Returns { ok, room, hostKey }.
 * (The key, as with a name, is shown once — and saved on the scheduler's
 * device.)
 */
export async function scheduleMeeting(title, startsAt, durationMin) {
  for (let tries = 0; tries < 5; tries += 1) {
    const room = newCode();
    const result = await claimName(
      room,
      cleanTitle(title),
      { startsAt, durationMin, scheduled: true },
      { allowCode: true },
    );
    if (result.ok) return { ok: true, room, hostKey: result.hostKey };
  }
  return { ok: false, error: 'busy' };
}

/**
 * Schedule the next meeting on a name you own (the host key proves it):
 * updates its start time / length and, if given, its title.
 */
export async function scheduleOnName(name, hostKey, title, startsAt, durationMin) {
  const record = await lookupName(name);
  if (!record || !isHostKey(record, hostKey)) return { ok: false, error: 'not yours' };
  const next = { ...record, startsAt, durationMin, title: cleanTitle(title) || record.title };
  await putObject(keyOf(name), Buffer.from(JSON.stringify(next)), 'application/json');
  cache.set(name, { record: next, at: Date.now() });
  return { ok: true, room: name };
}

/** What anyone may know about a room: its title and when it's on. */
export function publicInfo(record) {
  return {
    title: record.title,
    startsAt: record.startsAt ?? null,
    durationMin: record.durationMin ?? null,
  };
}

/** Delete one-off scheduled meetings a day after they end. Hourly. */
export async function sweepNames() {
  try {
    for (const { key } of await listKeys('names/')) {
      const text = await getText(key);
      let r = null;
      try {
        r = text ? JSON.parse(text) : null;
      } catch {
        r = null;
      }
      if (r?.scheduled && r.startsAt + (r.durationMin ?? 0) * 60_000 + DAY_MS < Date.now()) {
        await deleteObject(key);
        cache.delete(r.name);
        console.log(`[names] scheduled meeting ${r.name} is over — removed`);
      }
    }
  } catch (err) {
    console.error('[names] clean-up failed:', err.message);
  }
}
