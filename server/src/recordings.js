// Meeting recordings: the files and their bookkeeping (no room logic here —
// index.js decides who records and when).
//
// How a recording is made: one person's browser in the call (the
// "recorder") draws the meeting into a video and sends it here a second at a
// time (recorder.js on the client). If the recorder leaves, someone else
// takes over — so a recording is a list of PARTS, one per recorder, played
// back to back on the recording page.
//
// Each recording lives in storage (storage.js) as:
//   rec/<id>/manifest.json   title, times, and the list of parts
//   rec/<id>/part-<n>.<ext>  each part's video file
// The manifest is saved whenever something changes, so a finished recording
// survives this server restarting or going to sleep.
//
// Recordings are kept for KEEP_MS after the meeting ends, then deleted for
// good (sweep()). The id is long and random: it's the only way to find one.

import { randomBytes } from 'node:crypto';
import { RECORDING_KEEP_MS as KEEP_MS } from '@listen/shared';
import { deleteObject, getText, listKeys, openUpload, putObject } from './storage.js';
// A recording still marked "recording" this long after its last change was
// cut off (e.g. the server restarted mid-meeting): treat it as ended then.
const STALE_MS = 6 * 60 * 60 * 1000;
// After a recorder is told to stop, wait this long for its last second of
// video before closing the part anyway.
const DRAIN_MS = 4000;
// Never take more than this per part (~3 hours at the recording's bitrate):
// a runaway or hostile recorder can't fill the storage.
const PART_MAX_BYTES = 2 * 1024 * 1024 * 1024;

// Video formats a recorder may send, and the file ending for each.
const TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const baseType = (type) =>
  String(type ?? '')
    .split(';')[0]
    .trim();

const keyOf = (id, file) => `rec/${id}/${file}`;

// Recordings being made right now: id -> {
//   manifest,
//   part: null | { n, type, upload, size, startedAt, closing, timer, queue }
// }
const live = new Map();

async function saveManifest(m) {
  m.updatedAt = Date.now();
  await putObject(keyOf(m.id, 'manifest.json'), Buffer.from(JSON.stringify(m)), 'application/json');
}

/** Start a new recording. Returns its id. */
export async function startRecording({ title }) {
  const id = randomBytes(16).toString('base64url');
  const manifest = {
    id,
    title: String(title ?? '').slice(0, 120),
    startedAt: Date.now(),
    endedAt: null,
    expiresAt: null,
    parts: [], // { n, file, type, size, startedAt, endedAt }
  };
  // part: the part being received right now (see addChunk); expected: the
  // number of the part the current recorder was given (newPart).
  live.set(id, { manifest, part: null, nextPart: 1, expected: null });
  await saveManifest(manifest);
  return id;
}

/** Reserve the next part's number for a new recorder (`by`: their socket id). */
export function newPart(id, by) {
  const rec = live.get(id);
  if (!rec) return null;
  const n = rec.nextPart;
  rec.nextPart += 1;
  // Only this part, from this person, may start now (plus the last second
  // of a part that's closing).
  rec.expected = { n, by };
  return n;
}

/**
 * A second (or so) of video from the recorder, for part `n`. The first chunk
 * of a part says the video format and opens its file. Returns false if it
 * isn't wanted (wrong recording / part / sender, unknown format, too big).
 * `by` is the sender's socket id.
 */
export function addChunk(id, n, type, data, final, by) {
  const rec = live.get(id);
  if (!rec || !Buffer.isBuffer(data)) return false;

  // A new part starting: close whatever was before it, open its file.
  if (!rec.part || rec.part.n !== n) {
    if (n !== rec.expected?.n || by !== rec.expected.by) return false;
    const ext = TYPES[baseType(type)];
    if (!ext) return false;
    if (rec.part) closePart(rec); // (a late closing part — finish it now)
    const file = `part-${n}.${ext}`;
    rec.part = {
      n,
      by,
      file,
      type: baseType(type),
      upload: openUpload(keyOf(id, file), baseType(type)),
      size: 0,
      startedAt: Date.now(),
      closing: false,
      queue: Promise.resolve(),
    };
  }
  const part = rec.part;
  if (by !== part.by || part.size + data.length > PART_MAX_BYTES) return false;
  part.size += data.length;
  // Writes go one after another, in the order they arrived.
  part.queue = part.queue
    .then(() => part.upload.write(data))
    .catch((err) => {
      part.failed = true;
      console.error(`[rec ${id}] saving part ${n} failed:`, err.message);
    });
  if (final && part.closing) closePart(rec);
  return true;
}

// Finish the current part's file and add it to the manifest.
function closePart(rec) {
  const part = rec.part;
  if (!part) return Promise.resolve();
  rec.part = null;
  clearTimeout(part.timer);
  const m = rec.manifest;
  return part.queue
    .then(async () => {
      if (part.failed || !part.size) {
        await part.upload.abort().catch(() => {});
        return;
      }
      const size = await part.upload.finish();
      m.parts.push({
        n: part.n,
        file: part.file,
        type: part.type,
        size,
        startedAt: part.startedAt,
        endedAt: Date.now(),
      });
      m.parts.sort((a, b) => a.n - b.n);
      await saveManifest(m);
      console.log(`[rec ${m.id}] part ${part.n} saved (${Math.round(size / 1024)} KB)`);
    })
    .catch((err) => console.error(`[rec ${m.id}] closing part ${part.n} failed:`, err.message))
    .finally(() => part.closed?.());
}

/**
 * The current recorder is done (handed over, or recording stopped). If they're
 * still connected, wait a moment for their last chunk (sent `final`).
 */
export function endPart(id, { drain = false } = {}) {
  const rec = live.get(id);
  if (!rec) return Promise.resolve();
  rec.expected = null; // no new part may start until someone is assigned
  const part = rec.part;
  if (!part) return Promise.resolve();
  if (!drain) return closePart(rec);
  // Closed by the recorder's `final` chunk (addChunk), or by this timer.
  part.closing = true;
  part.timer = setTimeout(() => closePart(rec), DRAIN_MS);
  return new Promise((resolve) => {
    part.closed = resolve;
  });
}

/** The meeting's recording is over (stopped, or everyone left). */
export async function finishRecording(id, { drain = false } = {}) {
  const rec = live.get(id);
  if (!rec) return;
  await endPart(id, { drain });
  const m = rec.manifest;
  m.endedAt = Date.now();
  m.expiresAt = m.endedAt + KEEP_MS;
  live.delete(id);
  await saveManifest(m).catch((err) => console.error(`[rec ${id}] save failed:`, err.message));
  console.log(
    `[rec ${id}] finished — ${m.parts.length} part(s), deleted after ${new Date(m.expiresAt).toISOString()}`,
  );
}

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(id);

/** A recording's manifest (from memory while it's live), or null. */
export async function getManifest(id) {
  if (!validId(id)) return null;
  const rec = live.get(id);
  if (rec) return rec.manifest;
  const text = await getText(keyOf(id, 'manifest.json'));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** When this recording goes (or went) away. */
export function expiryOf(m) {
  if (m.expiresAt) return m.expiresAt;
  if (live.has(m.id)) return null; // still recording
  return (m.updatedAt ?? m.startedAt) + STALE_MS + KEEP_MS; // cut off mid-meeting
}

/** Storage key of one part's file, if it exists in the manifest. */
export function partKey(m, n) {
  const part = m.parts.find((p) => p.n === n);
  return part ? { key: keyOf(m.id, part.file), part } : null;
}

/** Delete one recording completely. */
async function remove(id) {
  for (const { key } of await listKeys(`rec/${id}/`)) await deleteObject(key);
  console.log(`[rec ${id}] deleted (expired)`);
}

/** Delete every recording past its time. Runs at startup and every hour. */
export async function sweep() {
  try {
    const keys = await listKeys('rec/');
    const ids = new Set(keys.map((k) => k.key.split('/')[1]));
    const now = Date.now();
    for (const id of ids) {
      if (live.has(id)) continue;
      const m = await getManifest(id);
      const newest = Math.max(
        ...keys.filter((k) => k.key.startsWith(`rec/${id}/`)).map((k) => k.modified),
      );
      // No manifest (broken upload): judge by the files' own age.
      const expires = m ? expiryOf(m) : newest + STALE_MS + KEEP_MS;
      if (expires && expires <= now) await remove(id);
    }
  } catch (err) {
    console.error('[rec] clean-up failed:', err.message);
  }
}
