// Chat attachments (photos and files sent in the chat), kept in storage
// instead of in the server's memory.
//
// They used to ride along inside every chat message as data: URLs, so a busy
// room could hold up to 40 MB of files in memory for the whole meeting — on a
// small server, a few such rooms could crash it. Now:
//
//   1. the browser still sends the file over the socket (index.js, CHAT_SEND)
//   2. saveChatFile puts it in storage (R2 — the same place as recordings;
//      a temp folder in local development) under a random, unguessable id,
//      next to a small note of its name, type and size
//   3. the chat message carries only a link: <server>/files/<id>
//   4. GET /files/:id (index.js) streams it back to whoever has the link
//
// Files are deleted when their sender unsends them, when the room closes, and
// in any case within a day (sweepChatFiles, run hourly from index.js).

import { randomUUID } from 'node:crypto';
import { deleteObject, getObject, getText, listKeys, putObject } from './storage.js';

const PREFIX = 'chat/';
const KEEP_MS = 24 * 60 * 60 * 1000; // a day at most
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Shown in the browser when opened; everything else is sent as a download, so
// an uploaded web page or script can never run as a page on this server.
const INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

/**
 * Save one attachment from its data: URL. Returns { id, size }, or null if
 * the data: URL is malformed or bigger than `maxBytes`.
 */
export async function saveChatFile(dataUrl, { name, type }, maxBytes) {
  // data:<type>[;base64],<data> — split at the first comma (no regex over a
  // multi-megabyte string)
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const data = dataUrl.slice(comma + 1);
  const bytes = header.endsWith(';base64')
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data));
  if (!bytes.length || bytes.length > maxBytes) return null;

  const id = randomUUID();
  const fileType = String(type || header.split(';')[0] || 'application/octet-stream').slice(0, 100);
  await putObject(`${PREFIX}${id}`, bytes, fileType);
  await putObject(
    `${PREFIX}${id}.json`,
    JSON.stringify({ name, type: fileType, size: bytes.length, savedAt: Date.now() }),
    'application/json',
  );
  return { id, size: bytes.length };
}

/**
 * Open a saved attachment for sending back. Returns null if the id isn't a
 * real one or it's gone (unsent, room closed, or older than a day);
 * otherwise { name, type, size, inline, body (a stream) }.
 */
export async function openChatFile(id) {
  if (!ID_RE.test(String(id))) return null;
  const metaText = await getText(`${PREFIX}${id}.json`);
  if (!metaText) return null;
  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch {
    return null;
  }
  if (Date.now() - meta.savedAt > KEEP_MS) return null;
  const file = await getObject(`${PREFIX}${id}`);
  if (!file) return null;
  return {
    name: String(meta.name || 'file'),
    type: String(meta.type || 'application/octet-stream'),
    size: file.size,
    inline: INLINE_TYPES.has(meta.type),
    body: file.body,
  };
}

/** The attachment id inside one of our /files/<id> links, or null. */
export function chatFileIdOf(url) {
  const m = /\/files\/([0-9a-f-]{36})(?:[?#]|$)/.exec(String(url ?? ''));
  return m && ID_RE.test(m[1]) ? m[1] : null;
}

/** Delete one attachment (and its note). Never throws. */
export async function deleteChatFile(id) {
  if (!ID_RE.test(String(id))) return;
  await Promise.all([
    deleteObject(`${PREFIX}${id}`).catch(() => {}),
    deleteObject(`${PREFIX}${id}.json`).catch(() => {}),
  ]);
}

/** Delete every attachment in a list of chat messages (a room that closed). */
export async function deleteChatFilesOf(messages = []) {
  const ids = messages.map((m) => chatFileIdOf(m.file?.url)).filter(Boolean);
  await Promise.all(ids.map(deleteChatFile));
}

/** Delete attachments older than a day. Runs hourly (index.js). */
export async function sweepChatFiles() {
  try {
    const now = Date.now();
    for (const { key, modified } of await listKeys(PREFIX)) {
      if (now - modified > KEEP_MS) await deleteObject(key).catch(() => {});
    }
  } catch (err) {
    console.error('[chat files] cleanup failed:', err.message);
  }
}
