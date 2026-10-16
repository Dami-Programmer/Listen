// Signaling + moderation server.
//
// Phase 1 — the server owns all room state (see rooms.js). Every state change is
// broadcast as a full room-state snapshot so clients never reconstruct state
// incrementally.
//
// Phase 2 — the server also relays WebRTC negotiation messages between peers
// (the RTC_SIGNAL handler below). The media itself (audio/video) flows
// browser-to-browser and never touches this server; all we do is pass the
// "let's connect" paperwork (SDP offers/answers and ICE candidates) from one
// socket to another. This is what "signaling server" means.
//
// With Cloudflare's SFU configured (sfu.js), the media goes through Cloudflare
// instead: each browser sends its tracks there once and receives everyone
// else's from there. Every step goes through this server (the SFU_* handlers
// below), which holds the Cloudflare secret and decides who may send what.
//
// Phases 4-7 — host-authoritative moderation. Every host-only action is
// re-checked here (requireHostRoom) regardless of what the client shows. In a
// peer-to-peer (mesh) call, "mute" and "listener" are cooperative: the server
// asks the target's client to disable its own tracks. Through the SFU,
// "listener" is enforced: the server won't pass on a listener's audio
// (enforceMedia). The host's Mute button stays a polite request either way —
// a muted speaker may unmute themselves.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import {
  CHAT_FILE_MAX_BYTES,
  EVENTS,
  MODES,
  REACTIONS,
  RECONNECT_GRACE_MS,
  STICKERS,
} from '@listen/shared';
import * as sfu from './sfu.js';
import * as recordings from './recordings.js';
import {
  deleteChatFile,
  deleteChatFilesOf,
  openChatFile,
  saveChatFile,
  sweepChatFiles,
  chatFileIdOf,
} from './chatFiles.js';
import {
  claimName,
  isHostKey,
  lookupName,
  mightBeClaimed,
  publicInfo,
  scheduleMeeting,
  scheduleOnName,
  sweepNames,
  validName,
  validSchedule,
} from './names.js';
import {
  askerOf,
  askQuestion,
  clearPoll,
  closeQuestion,
  endPoll,
  meetingReport,
  startPoll,
  voteQuestion,
  votePoll,
} from './activities.js';
import { checkStorage, getObject } from './storage.js';
import {
  addChatMessage,
  addParticipant,
  addWaiting,
  admitWaiting,
  clearFloor,
  createPass,
  demoteCohost,
  denyWaiting,
  editChatMessage,
  findTicket,
  findTrack,
  getRoom,
  grantFloor,
  makeHost,
  isAway,
  lowerHand,
  markAway,
  maySend,
  moveParticipant,
  mediaOf,
  passFloor,
  promoteCohost,
  raiseHand,
  rekey,
  removeParticipant,
  removeWaiting,
  reorderQueue,
  revokeFloor,
  roomOf,
  setDevice,
  setLock,
  setCam,
  setMic,
  setMode,
  setSharing,
  setSpeaking,
  snapshot,
  ticketOf,
  unsendChatMessage,
  deleteChatMessage,
  setChatMuted,
  isChatMuted,
  setCaptionWatcher,
  mayCaption,
  usePass,
} from './rooms.js';

// Load the single .env from the repo root (two levels up from server/src).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
// This server's own public address, for links it hands out (chat files —
// chatFiles.js). Render sets RENDER_EXTERNAL_URL; locally it's localhost.
// (Not taken from the visitor's request, which a client could fake.)
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(
  /\/$/,
  '',
);

// ICE servers every browser uses to connect its calls. STUN finds a direct
// route between two people; on networks that block direct routes (mobile data,
// strict office / school Wi-Fi) only a TURN relay gets audio and video through.
// The relay comes from a provider, configured in the env — either:
//
//  Cloudflare (recommended): short-lived logins fetched from Cloudflare's API.
//   CLOUDFLARE_TURN_KEY_ID     the TURN key's ID   (Cloudflare dashboard)
//   CLOUDFLARE_TURN_API_TOKEN  the TURN key's API token
//
//  ...or any provider with a fixed login (e.g. Metered):
//   TURN_URLS        comma-separated turn: / turns: URLs
//   TURN_USERNAME    the provider's username
//   TURN_CREDENTIAL  the provider's password
//
// Without either, calls work only where a direct route exists.
const STUN_ONLY = [{ urls: 'stun:stun.l.google.com:19302' }];
const CF_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID;
const CF_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN;
const CF_TTL_S = 24 * 60 * 60; // each Cloudflare login lasts a day...
const CF_REFRESH_MS = 12 * 60 * 60 * 1000; // ...and is replaced every 12 hours

// The list handed to every joiner (see the join ack). Starts with the fixed
// config; Cloudflare replaces it once its login arrives.
let iceServers = STUN_ONLY;
const TURN_URLS = (process.env.TURN_URLS ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
if (TURN_URLS.length) {
  iceServers = [
    ...STUN_ONLY,
    {
      urls: TURN_URLS,
      username: process.env.TURN_USERNAME ?? '',
      credential: process.env.TURN_CREDENTIAL ?? '',
    },
  ];
  console.log(`[server] TURN relay configured (${TURN_URLS.length} url(s))`);
}

async function refreshCloudflareTurn() {
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: CF_TTL_S }),
        // Joins wait on this request — never let a slow Cloudflare hold them up
        // for more than a few seconds (they fall back to the previous list).
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    // Cloudflare also lists port 53, which browsers block — drop those URLs.
    iceServers = (data.iceServers ?? [])
      .map((server) => ({
        ...server,
        urls: [].concat(server.urls).filter((u) => !/:53(\?|$)/.test(u)),
      }))
      .filter((server) => server.urls.length);
    console.log('[server] Cloudflare TURN relay ready');
  } catch (err) {
    console.error('[server] could not get Cloudflare TURN credentials:', err.message);
  }
}

// Joins wait for this, so even the first person after a cold start gets the
// relay. It always settles (errors are logged, not thrown).
let iceReady = Promise.resolve();
if (CF_KEY_ID && CF_TOKEN) {
  iceReady = refreshCloudflareTurn();
  setInterval(refreshCloudflareTurn, CF_REFRESH_MS).unref();
} else if (!TURN_URLS.length) {
  console.log(
    '[server] no TURN relay configured — calls across strict networks will have no media',
  );
}

console.log(
  sfu.sfuEnabled()
    ? '[server] Cloudflare SFU on — calls go through Cloudflare'
    : '[server] no Cloudflare SFU configured — calls are peer-to-peer (mesh)',
);

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, phase: 7, time: new Date().toISOString() });
});

// --- Fixed room links (names.js) ----------------------------------------------
// The home page checks a name is free as you type it, then claims it. A claim
// hands back the host key ONCE — it's never shown again.
const CLAIM_LIMIT = { max: 5, perMs: 60 * 60 * 1000 }; // per IP: 5 an hour
const claimHits = new Map(); // ip -> timestamps inside the window

app.get('/names/:name', async (req, res) => {
  const name = String(req.params.name ?? '').toLowerCase();
  if (!validName(name)) return res.json({ ok: true, valid: false, available: false });
  try {
    const taken = Boolean(await lookupName(name)) || Boolean(getRoom(name));
    res.json({ ok: true, valid: true, available: !taken });
  } catch (err) {
    console.error('[names] lookup failed:', err.message);
    res.status(500).json({ ok: false, error: 'Couldn’t check that name. Try again.' });
  }
});

app.post('/names', async (req, res) => {
  const now = Date.now();
  const recent = (claimHits.get(req.ip) ?? []).filter((t) => now - t < CLAIM_LIMIT.perMs);
  if (recent.length >= CLAIM_LIMIT.max) {
    return res.status(429).json({ ok: false, error: 'Too many new names. Try again later.' });
  }
  const name = String(req.body?.name ?? '').toLowerCase();
  if (!validName(name)) {
    return res.status(400).json({
      ok: false,
      error: 'Use 3-30 lowercase letters, numbers or hyphens (like grace-church).',
    });
  }
  // A meeting already running under that code can't be taken over.
  if (getRoom(name)) return res.status(409).json({ ok: false, error: 'That name is taken.' });
  try {
    const result = await claimName(name, req.body?.title);
    if (!result.ok) {
      return res.status(409).json({ ok: false, error: 'That name is taken.' });
    }
    recent.push(now);
    claimHits.set(req.ip, recent);
    console.log(`[names] "${name}" claimed`);
    res.json({ ok: true, name, hostKey: result.hostKey });
  } catch (err) {
    console.error('[names] claim failed:', err.message);
    res.status(500).json({ ok: false, error: 'Couldn’t save that name. Try again.' });
  }
});

// What anyone may know about a fixed / scheduled room: its title and when
// it's on (the lobby shows "Scheduled: Sunday 4:00 pm").
app.get('/names/:name/info', async (req, res) => {
  const name = String(req.params.name ?? '').toLowerCase();
  try {
    const record = mightBeClaimed(name) ? await lookupName(name) : null;
    if (!record) return res.status(404).json({ ok: false });
    res.json({ ok: true, ...publicInfo(record) });
  } catch (err) {
    console.error('[names] info failed:', err.message);
    res.status(500).json({ ok: false });
  }
});

// Schedule a meeting: on a fresh meeting code, or on a name you own (with
// its host key). Returns the room (and, for a fresh one, its host key —
// shown once).
app.post('/schedules', async (req, res) => {
  const now = Date.now();
  const recent = (claimHits.get(req.ip) ?? []).filter((t) => now - t < CLAIM_LIMIT.perMs);
  if (recent.length >= CLAIM_LIMIT.max) {
    return res.status(429).json({ ok: false, error: 'Too many new meetings. Try again later.' });
  }
  const startsAt = Number(req.body?.startsAt);
  const durationMin = Number(req.body?.durationMin);
  if (!validSchedule(startsAt, durationMin)) {
    return res.status(400).json({ ok: false, error: 'Pick a date and time in the next year.' });
  }
  const title = req.body?.title;
  try {
    const name = req.body?.name ? String(req.body.name).toLowerCase() : null;
    const result = name
      ? await scheduleOnName(name, req.body?.hostKey, title, startsAt, durationMin)
      : await scheduleMeeting(title, startsAt, durationMin);
    if (!result.ok) {
      return res
        .status(403)
        .json({ ok: false, error: 'You can only schedule on a link you’re the host of.' });
    }
    recent.push(now);
    claimHits.set(req.ip, recent);
    console.log(`[names] meeting scheduled in ${result.room}`);
    res.json({ ok: true, room: result.room, hostKey: result.hostKey ?? null });
  } catch (err) {
    console.error('[names] scheduling failed:', err.message);
    res.status(500).json({ ok: false, error: 'Couldn’t schedule it. Try again.' });
  }
});

// Guests who opened a fixed room's link before its host arrived: they wait
// here (room id -> socketId -> { name, avatar }) until the host joins, then
// knock like anyone else (the host lets them in).
const awaitingHost = new Map();

// --- Watching a recording (the ?rec=<id> page, RecordingPage.jsx) -----------
// Recordings are stored in R2, but every viewer gets them from here — some
// networks can't reach R2 directly. The long random id in the link is the
// only key; it stops working once the recording is deleted.

// About a recording: title, times, whether it's still going, and its parts.
app.get('/recordings/:id', async (req, res) => {
  try {
    const m = await recordings.getManifest(req.params.id);
    if (!m) return res.status(404).json({ ok: false, error: 'not found' });
    const expiresAt = recordings.expiryOf(m);
    if (expiresAt && expiresAt <= Date.now()) {
      return res.status(410).json({ ok: false, error: 'expired' });
    }
    res.json({
      ok: true,
      title: m.title,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      expiresAt,
      recording: !m.endedAt && !expiresAt, // still being recorded
      parts: m.parts.map(({ n, type, size, startedAt, endedAt }) => ({
        n,
        type,
        size,
        startedAt,
        endedAt,
      })),
    });
  } catch (err) {
    console.error('[rec] reading a recording failed:', err.message);
    res.status(500).json({ ok: false, error: 'Couldn’t load the recording.' });
  }
});

// One part's video. Supports byte ranges (how players skip ahead), and
// ?download=1 to save it as a file.
app.get('/recordings/:id/parts/:n', async (req, res) => {
  try {
    const m = await recordings.getManifest(req.params.id);
    const expiresAt = m && recordings.expiryOf(m);
    const found = m && recordings.partKey(m, Number(req.params.n));
    if (!found || (expiresAt && expiresAt <= Date.now())) return res.sendStatus(404);
    const { key, part } = found;

    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const range = match
      ? { start: Number(match[1]), end: match[2] ? Number(match[2]) : null }
      : null;
    if (range && range.start >= part.size) {
      return res.status(416).set('Content-Range', `bytes */${part.size}`).end();
    }
    const file = await getObject(key, range);
    if (!file) return res.sendStatus(404);

    res.status(file.status);
    res.set({
      'Content-Type': part.type,
      'Content-Length': String(file.end - file.start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    });
    if (file.status === 206)
      res.set('Content-Range', `bytes ${file.start}-${file.end}/${file.size}`);
    if (req.query.download) {
      const ext = part.type === 'video/webm' ? 'webm' : 'mp4';
      const name = `${m.title || 'Turnly'} - recording part ${part.n}`.replace(/[^\w .-]/g, '_');
      res.set('Content-Disposition', `attachment; filename="${name}.${ext}"`);
    }
    file.body.on('error', () => res.destroy());
    req.on('close', () => file.body.destroy());
    file.body.pipe(res);
  } catch (err) {
    console.error('[rec] sending a recording failed:', err.message);
    if (!res.headersSent) res.sendStatus(500);
    else res.destroy();
  }
});

// --- Reviews from the "You left the meeting" screen -------------------------
// After leaving a call, people can write what to improve (UI / UX). Each review
// is emailed to the app's owner through Resend (resend.com), configured in the
// env — so the owner's address and the key never sit in the code:
//   RESEND_API_KEY  the Resend API key
//   FEEDBACK_TO     where reviews are sent (the owner's inbox)
//   FEEDBACK_FROM   optional sender; defaults to Resend's test sender, which
//                   can only deliver to the Resend account's own email —
//                   exactly what's needed here
// Without the key, reviews are written to the server log instead (Render's
// "Logs" tab), so none are lost while email isn't set up yet.
//
// The browser has already left the call (its socket is closed), so this is a
// plain HTTP POST rather than a socket event.
const FEEDBACK_MAX_CHARS = 2000;
const FEEDBACK_LIMIT = { max: 5, perMs: 10 * 60 * 1000 }; // per IP: 5 every 10 minutes
const feedbackHits = new Map(); // ip -> timestamps inside the window

// Render sits in front of the app as a proxy; trust it so req.ip is the
// visitor's real address (used only for the rate limit above).
app.set('trust proxy', 1);

// One line of plain text from whatever the browser sent: a string, no line
// breaks (it may end up in an email subject), and not too long.
const oneLine = (v, max) =>
  (typeof v === 'string' ? v : '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);

app.post('/feedback', async (req, res) => {
  // Rate limit, so nobody can flood the inbox.
  const now = Date.now();
  const recent = (feedbackHits.get(req.ip) ?? []).filter((t) => now - t < FEEDBACK_LIMIT.perMs);
  if (recent.length >= FEEDBACK_LIMIT.max) {
    return res.status(429).json({ ok: false, error: 'Too many reviews. Try again later.' });
  }
  recent.push(now);
  feedbackHits.set(req.ip, recent);

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const comment = (typeof body.comment === 'string' ? body.comment : '')
    .trim()
    .slice(0, FEEDBACK_MAX_CHARS);
  if (!comment) return res.status(400).json({ ok: false, error: 'Write something first.' });

  // A little context, so a review like "the buttons are too small" can be
  // matched to a phone or a laptop. All of it comes from the browser, so it's
  // treated as plain text and trimmed.
  const name = oneLine(body.name, 60) || 'Someone';
  const meeting = oneLine(body.meeting, 120) || 'a meeting';
  const device = body.device === 'phone' ? 'phone' : 'computer';
  const browser = oneLine(req.get('user-agent'), 300);
  const when = new Date().toUTCString();

  const subject = `Turnly review from ${name}`;
  const text = [
    comment,
    '',
    '—',
    `From: ${name}`,
    `Meeting: ${meeting}`,
    `Device: ${device}`,
    `Browser: ${browser}`,
    `Sent: ${when}`,
  ].join('\n');

  const key = process.env.RESEND_API_KEY;
  const to = process.env.FEEDBACK_TO;
  if (!key || !to) {
    console.log(`[feedback] (email not set up — logging it instead)\n${subject}\n${text}`);
    return res.json({ ok: true });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.FEEDBACK_FROM || 'Turnly <onboarding@resend.dev>',
        to: [to],
        subject,
        text, // plain text only — nothing from the browser is treated as HTML
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    console.log(`[feedback] emailed a review from ${name}`);
    res.json({ ok: true });
  } catch (err) {
    // Keep the review even if the email failed.
    console.error('[feedback] email failed:', err.message, `\n${subject}\n${text}`);
    res.status(502).json({ ok: false, error: 'Couldn’t send right now. Please try again.' });
  }
});

// --- Errors from visitors' browsers (client/src/errorReport.js) ---------------
// When something crashes or a call goes wrong in someone's browser, it's sent
// here and written to the log, one entry each — on Render, search the logs
// for "[client-error]". Nothing is stored or emailed.
//
// The browser sends it with sendBeacon as plain text (that way it doesn't need
// a CORS pre-check), so this route reads text and parses the JSON itself.
// Everything in it comes from the browser: cleaned and trimmed before logging,
// and rate-limited per visitor so nobody can flood the logs.
const CLIENT_ERROR_LIMIT = { max: 30, perMs: 10 * 60 * 1000 }; // per IP: 30 every 10 minutes
const clientErrorHits = new Map(); // ip -> timestamps inside the window
const CLIENT_ERROR_KINDS = new Set(['crash', 'error', 'promise', 'call']);
const CLIENT_ERROR_PAGES = new Set(['landing', 'demo', 'home', 'meeting', 'recording']);

app.post('/client-errors', express.text({ type: 'text/plain', limit: '8kb' }), (req, res) => {
  const now = Date.now();
  const recent = (clientErrorHits.get(req.ip) ?? []).filter(
    (t) => now - t < CLIENT_ERROR_LIMIT.perMs,
  );
  // Over the limit: quietly drop it (the browser doesn't look at the answer).
  if (recent.length >= CLIENT_ERROR_LIMIT.max) return res.status(204).end();
  recent.push(now);
  clientErrorHits.set(req.ip, recent);

  let body;
  try {
    body = JSON.parse(typeof req.body === 'string' ? req.body : '');
  } catch {
    return res.status(400).end();
  }
  if (!body || typeof body !== 'object') return res.status(400).end();

  const kind = CLIENT_ERROR_KINDS.has(body.kind) ? body.kind : 'error';
  const page = CLIENT_ERROR_PAGES.has(body.page) ? body.page : 'unknown';
  const message = oneLine(body.message, 300) || '(no message)';
  const where = oneLine(body.where, 120);
  const browser = oneLine(req.get('user-agent'), 200);
  // the stack keeps its lines (that's what makes it readable), each one cleaned
  const stack = (typeof body.stack === 'string' ? body.stack : '')
    .split('\n')
    .slice(0, 8)
    .map((line) => oneLine(line, 200))
    .filter(Boolean);

  console.error(
    [
      `[client-error] ${kind} on ${page}: ${message}`,
      where && `  in ${where}`,
      ...stack.map((line) => `  ${line}`),
      `  browser: ${browser}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  res.status(204).end();
});

// --- Chat files (chatFiles.js) -------------------------------------------------
// A photo or file sent in a meeting's chat. Whoever has the link (everyone in
// that meeting got it in the chat) can open it; the id is random and
// unguessable. Photos and PDFs open in the browser; anything else, or
// ?download=1, is sent as a download — never shown as a page on this server.
app.get('/files/:id', async (req, res) => {
  try {
    const f = await openChatFile(req.params.id);
    if (!f) return res.status(404).send('This file is no longer available.');
    const asDownload = !f.inline || req.query.download;
    res.set({
      'Content-Type': f.inline ? f.type : 'application/octet-stream',
      'Content-Length': String(f.size),
      'Content-Disposition': `${asDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, max-age=3600',
      // belt and braces: the browser mustn't guess another type, or run anything
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    });
    f.body.on('error', () => res.destroy());
    f.body.pipe(res);
  } catch (err) {
    console.error('[chat files] reading failed:', err.message);
    res.status(500).send('Couldn’t load this file.');
  }
});

// Forget visitors whose rate-limit window has passed, so the map doesn't grow
// for ever on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of clientErrorHits) {
    if (hits.every((t) => now - t >= CLIENT_ERROR_LIMIT.perMs)) clientErrorHits.delete(ip);
  }
}, CLIENT_ERROR_LIMIT.perMs).unref();

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
  // Chat attachments travel as data: URLs — allow frames well over the 1 MB
  // default (a 5 MB file is ~6.7 MB base64, plus JSON overhead).
  maxHttpBufferSize: 12 * 1024 * 1024,
  // Notice a dead connection (internet gone, laptop lid shut) within ~20 s
  // instead of the default ~45 s: the server pings every 10 s and gives up
  // after 10 s without an answer. That's when "Reconnecting…" shows for
  // everyone else and the 1-minute seat hold starts.
  pingInterval: 10_000,
  pingTimeout: 10_000,
});

// Disconnect reasons that mean "they meant to go" — pressed Leave / closed the
// tab (the client closed it), or we removed / denied them (the server closed
// it). Anything else (transport close, ping timeout, …) is a network drop, and
// gets the seat held for RECONNECT_GRACE_MS.
const DELIBERATE = new Set([
  'client namespace disconnect',
  'server namespace disconnect',
  'server shutting down',
]);

// socketId -> the timer that gives up a dropped person's seat.
const awayTimers = new Map();

// Take someone out of their room for good and tell everyone. Used when they
// leave on purpose, and when a dropped person's hold runs out.
function finishLeave(socketId) {
  clearTimeout(awayTimers.get(socketId));
  awayTimers.delete(socketId);

  // (Looked up before they're removed: the room may close with them.)
  const before = roomOf(socketId)?.room;
  const wasRecorder = Boolean(before?.recording) && before.recording.recorderId === socketId;

  const result = removeParticipant(socketId);
  if (!result) return;

  const { roomId, room, admitted } = result;
  if (room === null) {
    console.log(`[room ${roomId}] closed (empty)`);
    // Its chat files go with it (chatFiles.js).
    deleteChatFilesOf(before?.chat).catch(() => {});
    // The last person has gone: the recording (if any) is finished.
    if (before?.recording) endRecording(before);
    return;
  }

  // The room emptied but someone was waiting — they were just made host.
  if (admitted) {
    const sock = io.sockets.sockets.get(admitted);
    if (sock) {
      sock.join(roomId);
      sock.emit(EVENTS.ADMITTED, {
        selfId: admitted,
        state: snapshot(roomId),
        chat: [...room.chat],
        ticket: ticketOf(room, admitted),
      });
    }
    console.log(`[room ${roomId}] host left; ${admitted} let in from the waiting room as host`);
  }

  // The recorder left: someone else carries on the recording.
  if (wasRecorder) handOver(roomId, room);

  console.log(
    `[room ${roomId}] - ${socketId} — ${Object.keys(room.participants).length} left,` +
      ` host is ${room.hostId}`,
  );
  broadcastRoom(roomId);
}

// --- Recording the meeting (see EVENTS.REC_* and recordings.js) -------------
// One browser in the call records; the server keeps track of which one.

// Who should record: someone connected right now (not reconnecting) whose
// browser can record — a laptop / desktop over a phone (much lighter work for
// it), the host and co-host first. `prefer` (whoever pressed Record) wins if
// they're on a laptop, or if nobody is.
function pickRecorder(room, prefer = null) {
  const can = (id) =>
    Boolean(id) &&
    Boolean(room.participants[id]) &&
    !room.away[id] &&
    room.participants[id].canRecord !== false &&
    io.sockets.sockets.has(id);
  const desktop = (id) => room.participants[id].desktop === true;
  if (can(prefer) && desktop(prefer)) return prefer;
  const everyone = [room.hostId, room.cohostId, ...Object.keys(room.participants)].filter(
    (id, i, all) => can(id) && all.indexOf(id) === i,
  );
  return everyone.find(desktop) ?? (can(prefer) ? prefer : everyone[0]) ?? null;
}

// The recording moves to a (new) recorder: the old recorder's part is closed —
// after a moment for its last second of video when `drain` (they're still
// here) — and the new one starts the next part. Nobody able: it waits for
// someone to (re)connect (see handleResume).
function handOver(roomId, room, { prefer = null, drain = false } = {}) {
  const rec = room.recording;
  if (!rec?.id) return;
  recordings.endPart(rec.id, { drain }).catch(() => {});
  const next = pickRecorder(room, prefer);
  rec.recorderId = next;
  rec.part = next ? recordings.newPart(rec.id, next) : null;
  console.log(
    next
      ? `[room ${roomId}] ${next} records part ${rec.part}`
      : `[room ${roomId}] recording paused — nobody can record right now`,
  );
}

// The recording is over (stopped, or the room emptied).
function endRecording(room) {
  const rec = room.recording;
  room.recording = null;
  if (!rec?.id) return;
  // Still connected? Give the recorder a moment to send its last second.
  const drain = Boolean(rec.recorderId) && io.sockets.sockets.has(rec.recorderId);
  recordings.finishRecording(rec.id, { drain }).catch((err) => {
    console.error(`[rec ${rec.id}] finishing failed:`, err.message);
  });
}

// A line from Turnly itself in the chat ("Sam started recording"), with the
// recording's id so the chat can link to it. `extra` adds other fields
// (`question`: the id of a question it announces).
function postNote(roomId, room, text, recording, extra = {}) {
  const message = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    from: null,
    name: 'Turnly',
    ts: Date.now(),
    kind: 'note',
    text,
    recording,
    ...extra,
  };
  addChatMessage(room, message);
  io.to(roomId).emit(EVENTS.CHAT_MESSAGE, message);
}

// --- Breakout rooms ---------------------------------------------------------
// The main room's breakout rooms are "<main>~1", "<main>~2", … Moving
// someone (relocate) keeps their seat: ticket, mic / camera, Cloudflare
// media (rooms.js moveParticipant). Their own socket is told (EVENTS.MOVED)
// and switches Socket.IO rooms; a dropped one finds its seat on resume.

// main room id -> { timers: [...] } (the 1-minute warning and the end)
const breakoutTimers = new Map();
const BREAKOUT_MAX_ROOMS = 20;

function relocate(socketId, fromId, toId, create) {
  const fromRoom = getRoom(fromId);
  const wasRecorder = fromRoom?.recording?.recorderId === socketId;
  const to = moveParticipant(fromId, toId, socketId, create);
  if (!to) return null;
  // The main room's recorder went off to a breakout: someone else records.
  if (wasRecorder && getRoom(fromId)) handOver(fromId, getRoom(fromId));
  const sock = io.sockets.sockets.get(socketId);
  if (sock) {
    sock.leave(fromId);
    sock.join(toId);
    sock.data.setRoom?.(toId);
    sock.emit(EVENTS.MOVED, {
      selfId: socketId,
      state: snapshot(toId),
      chat: [...to.chat],
      ticket: ticketOf(to, socketId),
    });
  }
  return to;
}

// What a breakout room is made of, if it has to be (re)created: the first
// person sent there, or the next one after it emptied out.
function breakoutRoomInfo(mainId, k) {
  const main = getRoom(mainId);
  return {
    title: `${main?.title || mainId} · Room ${k + 1}`,
    breakoutOf: { main: mainId, name: `Room ${k + 1}`, endsAt: main?.breakouts?.endsAt ?? null },
  };
}

// Split everyone but the host and co-host into `count` rooms: at random, or
// as the host chose (`assign`: { personId: room index }; anyone left out
// stays in the main room).
function startBreakouts(mainId, count, minutes, assign = null) {
  const main = getRoom(mainId);
  const people = Object.keys(main.participants).filter(
    (id) => id !== main.hostId && id !== main.cohostId,
  );
  for (let i = people.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [people[i], people[j]] = [people[j], people[i]];
  }
  // The host's choice keeps every room they asked for (some may start empty);
  // a shuffle never makes more rooms than people.
  const n = assign
    ? Math.max(1, Math.min(count, BREAKOUT_MAX_ROOMS))
    : Math.max(1, Math.min(count, people.length, BREAKOUT_MAX_ROOMS));
  const endsAt = minutes > 0 ? Date.now() + minutes * 60_000 : null;
  const ids = Array.from({ length: n }, (_, i) => `${mainId}~${i + 1}`);
  main.breakouts = { ids, endsAt };
  people.forEach((id, i) => {
    const k = assign ? assign[id] : i % n;
    if (!Number.isInteger(k) || k < 0 || k >= n) return; // stays in the main room
    relocate(id, mainId, ids[k], breakoutRoomInfo(mainId, k));
  });
  for (const [i, id] of ids.entries()) {
    const room = getRoom(id);
    if (!room) continue;
    postNote(
      id,
      room,
      endsAt
        ? `Welcome to Room ${i + 1}! You'll all go back to the main room in ${minutes} minutes.`
        : `Welcome to Room ${i + 1}! The host will bring everyone back.`,
      null,
    );
    broadcastRoom(id);
  }
  // Timers: a 1-minute warning, then everyone back.
  const timers = [];
  if (endsAt) {
    if (minutes > 1) {
      timers.push(
        setTimeout(
          () => {
            for (const id of ids) {
              const room = getRoom(id);
              if (room) postNote(id, room, '⏳ 1 minute left, then back to the main room.', null);
            }
          },
          (minutes - 1) * 60_000,
        ),
      );
    }
    timers.push(setTimeout(() => endBreakouts(mainId), minutes * 60_000));
  }
  breakoutTimers.set(mainId, { timers });
  console.log(`[room ${mainId}] breakouts: ${people.length} people into ${n} rooms`);
}

// The host moved one person: into room `to` (index), or -1 = the main room.
// They can be in the main room (a late joiner, or left out) or any breakout.
function moveBreakoutPerson(mainId, personId, to, byName) {
  const main = getRoom(mainId);
  const ids = main?.breakouts?.ids ?? [];
  const fromId = [mainId, ...ids].find((id) => getRoom(id)?.participants[personId]);
  if (!fromId) return 'They’re not in this meeting any more.';
  if (personId === main.hostId || personId === main.cohostId) {
    return 'The host and cohost stay in the main room.';
  }
  const toId = to === -1 ? mainId : ids[to];
  if (!toId) return 'Pick a room.';
  if (toId === fromId) return null; // already there
  const name = getRoom(fromId).participants[personId].name;
  const target = relocate(
    personId,
    fromId,
    toId,
    to === -1 ? { title: main.title ?? '' } : breakoutRoomInfo(mainId, to),
  );
  if (!target) return 'Couldn’t move them. Try again.';
  postNote(toId, target, `🧩 ${byName} moved ${name} here.`, null);
  for (const id of new Set([fromId, toId, mainId])) if (getRoom(id)) broadcastRoom(id);
  return null;
}

// Everyone back to the main room.
function endBreakouts(mainId) {
  for (const t of breakoutTimers.get(mainId)?.timers ?? []) clearTimeout(t);
  breakoutTimers.delete(mainId);
  const main = getRoom(mainId);
  const ids = main?.breakouts?.ids ?? [];
  const title = main?.title ?? '';
  for (const id of ids) {
    const room = getRoom(id);
    for (const pid of Object.keys(room?.participants ?? {})) {
      relocate(pid, id, mainId, { title });
    }
  }
  const back = getRoom(mainId);
  if (back) {
    back.breakouts = null;
    broadcastRoom(mainId);
  }
  console.log(`[room ${mainId}] breakouts ended`);
}

// Per-socket rate limits (see `allow` in the connection handler). Generous for
// a person, tight for a script. Events not listed here aren't limited
// (WebRTC signaling in particular sends bursts of ICE candidates).
const RATE_LIMITS = {
  [EVENTS.CHAT_SEND]: { max: 10, perMs: 10_000 },
  [EVENTS.CHAT_EDIT]: { max: 10, perMs: 10_000 },
  [EVENTS.CHAT_UNSEND]: { max: 10, perMs: 10_000 },
  [EVENTS.CHAT_DELETE]: { max: 20, perMs: 10_000 },
  [EVENTS.CHAT_MUTE]: { max: 20, perMs: 10_000 },
  // captions: a few updates a second while someone talks (the client sends
  // at most ~3 a second), plus the odd on / off
  [EVENTS.CAPTION]: { max: 60, perMs: 10_000 },
  [EVENTS.CAPTIONS_WANT]: { max: 10, perMs: 10_000 },
  [EVENTS.CHAT_TYPING]: { max: 20, perMs: 10_000 },
  [EVENTS.RAISE_HAND]: { max: 10, perMs: 10_000 },
  [EVENTS.LOWER_HAND]: { max: 20, perMs: 10_000 },
  [EVENTS.SPEAKING]: { max: 60, perMs: 10_000 },
  // The video desk: a few calls each time someone joins, leaves, or turns a
  // camera / share on or off. Each one is a Cloudflare API call, so cap it.
  [EVENTS.SFU_SESSION]: { max: 10, perMs: 60_000 },
  [EVENTS.SFU_PUBLISH]: { max: 30, perMs: 10_000 },
  [EVENTS.SFU_PULL]: { max: 60, perMs: 10_000 },
  [EVENTS.SFU_ANSWER]: { max: 60, perMs: 10_000 },
  [EVENTS.SFU_CLOSE]: { max: 60, perMs: 10_000 },
  [EVENTS.SFU_LAYERS]: { max: 30, perMs: 10_000 },
  // Recording: about one chunk a second from the recorder.
  [EVENTS.REC_START]: { max: 5, perMs: 60_000 },
  [EVENTS.REC_STOP]: { max: 5, perMs: 60_000 },
  [EVENTS.REC_CHUNK]: { max: 40, perMs: 10_000 },
  [EVENTS.DEVICE]: { max: 10, perMs: 60_000 },
  // Reactions, questions, polls, the report.
  [EVENTS.REACT]: { max: 15, perMs: 10_000 },
  [EVENTS.Q_ASK]: { max: 5, perMs: 30_000 },
  [EVENTS.Q_VOTE]: { max: 30, perMs: 10_000 },
  [EVENTS.Q_CLOSE]: { max: 20, perMs: 10_000 },
  [EVENTS.POLL_START]: { max: 5, perMs: 30_000 },
  [EVENTS.POLL_VOTE]: { max: 20, perMs: 10_000 },
  [EVENTS.POLL_END]: { max: 10, perMs: 10_000 },
  [EVENTS.POLL_CLEAR]: { max: 10, perMs: 10_000 },
  [EVENTS.REPORT_GET]: { max: 10, perMs: 10_000 },
  [EVENTS.BREAKOUT_START]: { max: 5, perMs: 30_000 },
  [EVENTS.BREAKOUT_END]: { max: 5, perMs: 30_000 },
  [EVENTS.BREAKOUT_MOVE]: { max: 30, perMs: 30_000 },
  [EVENTS.BREAKOUT_MESSAGE]: { max: 10, perMs: 30_000 },
};

// Last line of defence: log anything that slipped past the handler wrapper
// instead of letting it kill every call on the server.
process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

// Send the current snapshot of a room to everyone in it.
function broadcastRoom(roomId) {
  // A recording nobody could take over (everyone was reconnecting): someone
  // is back or has joined — give it to them.
  const room = getRoom(roomId);
  if (room?.recording?.id && !room.recording.recorderId && pickRecorder(room)) {
    handOver(roomId, room);
  }
  enforceMedia(roomId);
  const state = snapshot(roomId);
  if (state) io.to(roomId).emit(EVENTS.ROOM_STATE, state);
}

// --- Cloudflare SFU: who may send what -------------------------------------
// Runs on every change (broadcastRoom). A track someone may no longer send —
// a listener's audio, a screen share that isn't the room's current one — is
// already left out of the snapshot (rooms.js), so everyone stops receiving it
// at once. Their own browser then closes it; if it hasn't within
// ENFORCE_GRACE_MS (an old or tampered client), the server forces Cloudflare
// to drop it. That's what makes "listeners can't talk" real, not just a
// polite request.
const ENFORCE_GRACE_MS = 3000;

function enforceMedia(roomId) {
  const room = getRoom(roomId);
  if (!room || !sfu.sfuEnabled()) return;
  for (const [id, m] of Object.entries(room.media)) {
    for (const [kind, t] of Object.entries(m.tracks)) {
      if (maySend(room, id, kind) || t.cutTimer) continue;
      t.cutTimer = setTimeout(() => {
        t.cutTimer = null;
        // Still there (same Cloudflare session, same track), and still not
        // allowed (not handed the floor back meanwhile)? Force it off.
        const owner = Object.entries(room.media).find(
          ([, x]) => x.sessionId === m.sessionId && x.tracks[kind] === t,
        );
        if (!owner || maySend(room, owner[0], kind)) return;
        delete owner[1].tracks[kind];
        sfu
          .close(m.sessionId, [t.mid])
          .then(() => console.log(`[room ${roomId}] forced ${kind} off (sender didn't stop)`))
          .catch((err) =>
            console.error(`[room ${roomId}] forcing ${kind} off failed:`, err.message),
          );
      }, ENFORCE_GRACE_MS);
      t.cutTimer.unref?.();
    }
  }
}

io.on('connection', (socket) => {
  console.log(`[socket] connected ${socket.id}`);

  // Remember which room this socket joined so disconnect can clean up and,
  // when the host leaves, we can tell the room who was promoted.
  let joinedRoomId = null;
  // Breakout rooms move people between rooms (relocate, above).
  socket.data.setRoom = (id) => {
    joinedRoomId = id;
  };

  // Every event goes through `on` instead of `socket.on`. Anyone can send
  // anything, so a handler must never throw: an exception inside a Socket.IO
  // handler takes down the whole process (every call in every room). This:
  //  - turns a missing / null / non-object payload into {}
  //  - passes `ack` only if it's really a function (a stray extra argument
  //    would otherwise make `ack?.()` throw "ack is not a function")
  //  - logs, instead of crashing on, anything a handler still throws
  //  - applies the optional rate limit (see `allow` below)
  function on(event, handler, limit = RATE_LIMITS[event]) {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : undefined;
      if (limit && !allow(event, limit)) {
        reply?.({ ok: false, error: 'slow down' });
        return;
      }
      const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      try {
        const result = handler(p, reply);
        if (result instanceof Promise) {
          result.catch((err) => console.error(`[socket] ${event} failed for ${socket.id}:`, err));
        }
      } catch (err) {
        console.error(`[socket] ${event} failed for ${socket.id}:`, err);
      }
    });
  }

  // Per-socket rate limit: at most `max` events of one kind per `perMs`.
  // Keeps one person from flooding the room (chat spam, 5 MB files in a loop).
  const hits = new Map(); // event -> timestamps inside the current window
  function allow(event, { max, perMs }) {
    const now = Date.now();
    const recent = (hits.get(event) ?? []).filter((t) => now - t < perMs);
    if (recent.length >= max) {
      hits.set(event, recent);
      return false;
    }
    recent.push(now);
    hits.set(event, recent);
    return true;
  }

  // Wait for the TURN login (instant after the first few seconds of uptime).
  // (A fixed room's name is looked up first — see handleJoin.)
  on(
    EVENTS.JOIN_ROOM,
    async (payload, ack) => {
      await iceReady;
      const asked = String(payload.roomId || '')
        .trim()
        .toLowerCase();
      let record = null;
      try {
        // (a fixed room's name, or a scheduled meeting's code)
        record = mightBeClaimed(asked) ? await lookupName(asked) : null;
      } catch (err) {
        console.error('[names] lookup failed:', err.message);
        return ack?.({ ok: false, error: 'Couldn’t open that room. Try again.' });
      }
      handleJoin(payload, ack, record);
    },
    { max: 5, perMs: 10_000 },
  );

  // `record`: the claimed name, if the room is a fixed one (names.js).
  function handleJoin({ roomId, name, avatar, title, hostKey } = {}, ack, record = null) {
    if (socket.disconnected) return; // left while we waited
    // A fixed room's id is its name, always in lowercase.
    const id = record
      ? record.name
      : String(roomId || '')
          .trim()
          .slice(0, 64);
    // Joined with the name's host key: the host, every time.
    const owner = isHostKey(record, hostKey);
    // Breakout rooms ("<main>~2") are only entered by being sent there.
    if (id.includes('~')) return ack?.({ ok: false, error: 'That meeting isn’t available.' });
    if (!id) {
      socket.emit(EVENTS.ERROR, { message: 'roomId is required' });
      ack?.({ ok: false, error: 'roomId is required' });
      return;
    }
    if (joinedRoomId) {
      socket.emit(EVENTS.ERROR, { message: 'already in a room' });
      ack?.({ ok: false, error: 'already in a room' });
      return;
    }

    // Knock: the room exists, is locked, and isn't empty -> wait for a
    // moderator. Waiters aren't in the Socket.IO room, so they get nothing
    // until they're admitted.
    const existing = getRoom(id);

    // A fixed room whose host hasn't arrived: wait for them.
    if (record && !owner && !existing) {
      joinedRoomId = id;
      if (!awaitingHost.has(id)) awaitingHost.set(id, new Map());
      awaitingHost.get(id).set(socket.id, { name, avatar });
      console.log(`[room ${id}] ~ ${socket.id} waiting for the host to arrive`);
      ack?.({ ok: true, waiting: true, forHost: true, selfId: socket.id, iceServers });
      return;
    }

    if (!owner && existing && existing.locked && Object.keys(existing.participants).length > 0) {
      joinedRoomId = id;
      addWaiting(existing, socket.id, name, avatar);
      console.log(`[room ${id}] ~ ${socket.id} knocking (${existing.waiting[socket.id].name})`);
      ack?.({ ok: true, waiting: true, selfId: socket.id, iceServers });
      broadcastRoom(id); // moderators' waiting list updates
      return;
    }

    joinedRoomId = id;
    socket.join(id);
    // (A fixed room is always titled with the name it was claimed under.)
    const room = addParticipant(
      id,
      socket.id,
      name,
      avatar,
      record ? record.title || title : title,
    );
    if (owner) {
      makeHost(room, socket.id); // even if a guest got here first
      // Anyone who was waiting for the host now knocks (the host lets them in).
      const early = awaitingHost.get(id);
      awaitingHost.delete(id);
      for (const [sid, who] of early ?? []) {
        if (io.sockets.sockets.has(sid)) addWaiting(room, sid, who.name, who.avatar);
      }
    }
    console.log(
      `[room ${id}] + ${socket.id} (${room.participants[socket.id].name})` +
        `${room.hostId === socket.id ? ' [host]' : ''} — ${Object.keys(room.participants).length} in room`,
    );

    ack?.({
      ok: true,
      selfId: socket.id,
      state: snapshot(id),
      chat: [...room.chat],
      iceServers,
      ticket: ticketOf(room, socket.id), // their secret way back in after a drop
    });
    broadcastRoom(id);
  }

  // --- Getting back in with a ticket (see EVENTS.RESUME) ------------------
  // Two ways the same ticket gets you back in:
  //  - after a network drop: the client's internet came back and Socket.IO
  //    opened a fresh connection (new socket id). The seat is still held, so
  //    it moves onto this connection and the call carries on.
  //  - after pressing Leave: the "Rejoin" button, within a minute. The seat
  //    is gone, but the rejoin pass puts them back with their old role.
  on(EVENTS.RESUME, (payload, ack) => iceReady.then(() => handleResume(payload, ack)), {
    max: 5,
    perMs: 10_000,
  });

  function handleResume({ ticket } = {}, ack) {
    if (socket.disconnected) return; // dropped again while we waited
    if (joinedRoomId) return ack?.({ ok: false, error: 'already in a room' });

    const found = findTicket(ticket);
    if (!found) return handleRejoin(ticket, ack); // no held seat — maybe they left on purpose
    const { roomId, room, oldId } = found;

    // Cancel the "give up their seat" timer.
    clearTimeout(awayTimers.get(oldId));
    awayTimers.delete(oldId);

    // Often the client notices the drop and reconnects BEFORE the server has
    // noticed the old connection is dead. Close the old one ourselves, flagged
    // so its disconnect handler knows the seat has moved and does nothing.
    const old = io.sockets.sockets.get(oldId);
    if (old) {
      old.data.replaced = true;
      old.disconnect(true);
    }

    rekey(room, oldId, socket.id);
    joinedRoomId = roomId;
    socket.join(roomId);
    console.log(`[room ${roomId}] ↺ ${oldId} reconnected as ${socket.id}`);

    ack?.({
      ok: true,
      selfId: socket.id,
      state: snapshot(roomId),
      chat: [...room.chat],
      iceServers,
      ticket: ticketOf(room, socket.id),
    });
    broadcastRoom(roomId); // everyone swaps the old id for the new one
  }

  // "Rejoin" within a minute of pressing Leave: straight back in (no knock,
  // even through a locked door) with their old role — see usePass.
  function handleRejoin(ticket, ack) {
    const back = usePass(ticket, socket.id);
    if (!back) return ack?.({ ok: false, error: 'expired' }); // too late, or server restarted
    const { roomId, room } = back;
    joinedRoomId = roomId;
    socket.join(roomId);
    console.log(
      `[room ${roomId}] ↩ ${socket.id} (${room.participants[socket.id].name}) rejoined` +
        ` as ${room.participants[socket.id].role}`,
    );
    ack?.({
      ok: true,
      selfId: socket.id,
      state: snapshot(roomId),
      chat: [...room.chat],
      iceServers,
      ticket: ticketOf(room, socket.id), // a fresh ticket for this new seat
    });
    broadcastRoom(roomId);
  }

  // A moderator is the host OR the appointed co-host. Every Phase 4/5/7 control
  // is open to both; only appointing/dropping a co-host stays host-only.
  function isModerator() {
    const room = getRoom(joinedRoomId);
    return Boolean(room && (socket.id === room.hostId || socket.id === room.cohostId));
  }

  // Guard for moderator-only actions. Returns the room, or acks an error + null.
  function requireModeratorRoom(ack) {
    const room = getRoom(joinedRoomId);
    if (!room) {
      ack?.({ ok: false, error: 'not in a room' });
      return null;
    }
    if (!isModerator()) {
      socket.emit(EVENTS.ERROR, { message: 'only a moderator can do that' });
      ack?.({ ok: false, error: 'only a moderator can do that' });
      return null;
    }
    return room;
  }

  // --- Phase 4: the moderator mode toggle --------------------------------
  // A moderator flips the whole room between 'open' (free-for-all) and
  // 'moderated' (every non-moderator becomes a listener; each listener's client
  // then silences its own mic/camera). Rejected for anyone who isn't a
  // moderator — the first place the server enforces "host-authoritative".
  on(EVENTS.SET_MODE, ({ mode } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (mode !== MODES.OPEN && mode !== MODES.MODERATED) {
      ack?.({ ok: false, error: `unknown mode: ${mode}` });
      return;
    }

    setMode(room, mode); // recomputes every non-moderator role
    console.log(`[room ${joinedRoomId}] mode -> ${mode} (by ${socket.id})`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 5: hand-raising & the speaker queue --------------------------
  //
  // Two listener-driven events (raise / lower my own hand) and three
  // moderator-only events (grant, revoke, clear the floor), all gated with
  // requireModeratorRoom.
  //
  // Every handler ends the same way: mutate room state via a rooms.js helper,
  // then broadcast a fresh snapshot. The helpers are all no-ops when the action
  // isn't valid (wrong mode, wrong role, not queued), so the handlers stay thin.

  on(EVENTS.RAISE_HAND, (_payload, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) return ack?.({ ok: false, error: 'not in a room' });
    raiseHand(room, socket.id); // no-op unless I'm a listener in a moderated room
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // A listener lowers their own hand; a moderator may lower anyone's ("Dismiss"
  // in the dashboard) by passing { targetId }.
  on(EVENTS.LOWER_HAND, ({ targetId } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) return ack?.({ ok: false, error: 'not in a room' });

    let subject = socket.id;
    if (targetId && targetId !== socket.id) {
      if (!isModerator()) {
        return ack?.({ ok: false, error: 'only a moderator can lower another hand' });
      }
      subject = targetId;
    }

    lowerHand(room, subject);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.GRANT_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    grantFloor(room, targetId); // listener -> speaker, off the queue
    console.log(`[room ${joinedRoomId}] grant floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.REVOKE_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    revokeFloor(room, targetId); // speaker -> listener
    console.log(`[room ${joinedRoomId}] revoke floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.CLEAR_FLOOR, (_payload, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    clearFloor(room); // every non-moderator speaker -> listener
    console.log(`[room ${joinedRoomId}] floor cleared by ${socket.id}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // A speaker gives up the floor themselves — the first raised hand takes it,
  // or the speaker just drops to listener if no hand is up.
  on(EVENTS.PASS_MIC, (_payload, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) return ack?.({ ok: false, error: 'not in a room' });
    const { passed, next } = passFloor(room, socket.id);
    if (!passed) return ack?.({ ok: false, error: 'you are not a speaker' });
    console.log(
      `[room ${joinedRoomId}] ${socket.id} passed the mic` +
        (next ? ` -> ${next}` : ' (queue empty)'),
    );
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 7: full moderation controls ------------------------------
  //
  // Moderator-only actions on a specific participant. The target must be a real
  // member of the room, never the caller, and never the host — nobody (not even
  // a co-host) mutes or removes the host. (Dropping a co-host is demote-cohost,
  // below, which is host-only.)
  function requireTarget(room, targetId, ack) {
    if (!targetId || !room.participants[targetId]) {
      ack?.({ ok: false, error: 'unknown participant' });
      return null;
    }
    if (targetId === socket.id) {
      ack?.({ ok: false, error: 'that action cannot target yourself' });
      return null;
    }
    if (targetId === room.hostId) {
      ack?.({ ok: false, error: 'the host cannot be targeted' });
      return null;
    }
    return targetId;
  }

  // Force-mute: the server can't touch peer-to-peer media, so it just asks the
  // target's client to disable its own mic track. Cooperative — they can unmute
  // themselves again. No room state changes, so no broadcast.
  on(EVENTS.FORCE_MUTE, ({ targetId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    const target = requireTarget(room, targetId, ack);
    if (!target) return;
    io.to(target).emit(EVENTS.FORCE_MUTE);
    console.log(`[room ${joinedRoomId}] ${socket.id} muted ${target}`);
    ack?.({ ok: true });
  });

  // Remove from call: tell the target why, then drop their socket. The normal
  // 'disconnect' handler below does the room cleanup + broadcast. A client that
  // is disconnected by the server does not auto-reconnect, so they land back on
  // the join screen and can rejoin if they want.
  on(EVENTS.REMOVE_PARTICIPANT, ({ targetId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    const target = requireTarget(room, targetId, ack);
    if (!target) return;
    const targetSocket = io.sockets.sockets.get(target);
    console.log(`[room ${joinedRoomId}] ${socket.id} removed ${target}`);
    ack?.({ ok: true });
    if (targetSocket) {
      targetSocket.emit(EVENTS.REMOVED);
      targetSocket.disconnect(true);
    }
    // Removing someone whose connection had dropped: there's no socket to
    // close, so take them out now — and their ticket with them, so they
    // can't reconnect into the seat they were just removed from.
    if (isAway(room, target)) finishLeave(target);
  });

  // Reorder the queue. `order` must be a permutation of the current queue —
  // reorderQueue rejects anything else, so a stale list is a safe no-op.
  on(EVENTS.REORDER_QUEUE, ({ order } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    reorderQueue(room, order);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Co-host (host-only) --------------------------------------------
  // The host hands full moderator power to one other participant, and can drop
  // them back to a normal participant at any time. A co-host cannot appoint or
  // drop a co-host, so these two stay strictly host-gated.
  function requireHostRoom(ack) {
    const room = getRoom(joinedRoomId);
    if (!room) {
      ack?.({ ok: false, error: 'not in a room' });
      return null;
    }
    if (socket.id !== room.hostId) {
      socket.emit(EVENTS.ERROR, { message: 'only the host can do that' });
      ack?.({ ok: false, error: 'only the host can do that' });
      return null;
    }
    return room;
  }

  on(EVENTS.PROMOTE_COHOST, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    if (!targetId || !room.participants[targetId] || targetId === room.hostId) {
      return ack?.({ ok: false, error: 'unknown participant' });
    }
    promoteCohost(room, targetId);
    console.log(`[room ${joinedRoomId}] host ${socket.id} made ${targetId} co-host`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.DEMOTE_COHOST, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    const subject = targetId || room.cohostId;
    if (!subject || subject !== room.cohostId) {
      return ack?.({ ok: false, error: 'not the co-host' });
    }
    demoteCohost(room, subject);
    console.log(`[room ${joinedRoomId}] host ${socket.id} dropped co-host ${subject}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Waiting room (added after co-host) -----------------------------
  // Moderator-only: let a knocker in, turn them away, or toggle the lock.

  // Move one waiter into the room proper and hand them the full state.
  function letIn(room, targetId) {
    const sock = io.sockets.sockets.get(targetId);
    if (!sock) {
      denyWaiting(room, targetId); // socket vanished — drop the stale entry
      return false;
    }
    admitWaiting(room, targetId);
    sock.join(joinedRoomId);
    sock.emit(EVENTS.ADMITTED, {
      selfId: targetId,
      state: snapshot(joinedRoomId),
      chat: [...room.chat],
      ticket: ticketOf(room, targetId),
    });
    return true;
  }

  on(EVENTS.ADMIT, ({ socketId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (!room.waiting[socketId]) return ack?.({ ok: false, error: 'not waiting' });
    letIn(room, socketId);
    console.log(`[room ${joinedRoomId}] ${socket.id} admitted ${socketId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.DENY, ({ socketId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (!room.waiting[socketId]) return ack?.({ ok: false, error: 'not waiting' });
    denyWaiting(room, socketId);
    // Drop the denied socket entirely — it still has this room pinned as its
    // "joined" room, so without a disconnect a retry would be told it's
    // "already in a room". A fresh socket knocks cleanly.
    const denied = io.sockets.sockets.get(socketId);
    if (denied) {
      denied.emit(EVENTS.DENIED);
      denied.disconnect(true);
    }
    console.log(`[room ${joinedRoomId}] ${socket.id} denied ${socketId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.SET_LOCK, ({ locked } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    setLock(room, locked);
    if (!room.locked) {
      // Unlocking lets in everyone currently waiting.
      for (const sid of Object.keys(room.waiting)) letIn(room, sid);
    }
    console.log(`[room ${joinedRoomId}] ${room.locked ? 'locked' : 'unlocked'} by ${socket.id}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- In-call chat (added after Phase 7) --------------------------------
  // Anyone in the room may post — chat is independent of the speaker floor, so
  // listeners get to talk too. The server names, trims, length-caps and
  // timestamps every message, keeps a bounded history, and fans it out on its
  // own event (never in room-state, which would resend the whole log on every
  // join/role change). Text is escaped by React on render.
  on(EVENTS.CHAT_SEND, async ({ text, kind, file } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    const participant = room?.participants[socket.id];
    if (!room || !participant) {
      ack?.({ ok: false, error: 'not in a room' });
      return;
    }
    // A moderator muted this person's chat (CHAT_MUTE below).
    if (isChatMuted(room, socket.id)) {
      return ack?.({ ok: false, error: 'The host has muted your chat.' });
    }
    const roomId = joinedRoomId; // (saving a file takes a moment)

    const base = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from: socket.id,
      name: participant.name,
      ts: Date.now(),
    };
    let message;

    if (kind === 'file') {
      const url = typeof file?.url === 'string' ? file.url : '';
      if (!url.startsWith('data:')) {
        return ack?.({ ok: false, error: 'bad attachment' });
      }
      // data: URL length ~= 1.37 * raw bytes (base64 + a short header).
      if (url.length > CHAT_FILE_MAX_BYTES * 1.4) {
        return ack?.({ ok: false, error: 'attachment too large' });
      }
      const name =
        String(file?.name ?? 'file')
          .replace(/[/\\\r\n\t]/g, '_')
          .trim()
          .slice(0, 200) || 'file';
      const type = String(file?.type ?? 'application/octet-stream').slice(0, 100);
      // Into storage (chatFiles.js) — the message only carries a link to it,
      // so the file doesn't sit in this server's memory for the whole meeting.
      let saved;
      try {
        saved = await saveChatFile(url, { name, type }, CHAT_FILE_MAX_BYTES);
      } catch (err) {
        console.error('[chat files] saving failed:', err.message);
        return ack?.({ ok: false, error: 'Couldn’t send that file. Please try again.' });
      }
      if (!saved) return ack?.({ ok: false, error: 'attachment too large' });
      // They may have left (or the room closed) while it was saving.
      if (!getRoom(roomId)?.participants[socket.id]) {
        deleteChatFile(saved.id);
        return ack?.({ ok: false, error: 'not in a room' });
      }
      message = {
        ...base,
        kind: 'file',
        file: { name, type, size: saved.size, url: `${PUBLIC_URL}/files/${saved.id}` },
      };
    } else {
      const isSticker = kind === 'sticker';
      const body = String(text ?? '').trim();
      if (isSticker) {
        if (!STICKERS.includes(body)) return ack?.({ ok: false, error: 'unknown sticker' });
      } else if (!body) {
        return ack?.({ ok: false, error: 'empty message' });
      }
      message = {
        ...base,
        kind: isSticker ? 'sticker' : 'text',
        text: isSticker ? body : body.slice(0, 2000),
      };
    }

    addChatMessage(getRoom(roomId), message);
    ack?.({ ok: true });
    io.to(roomId).emit(EVENTS.CHAT_MESSAGE, message);
  });

  // Edit your own text message. Works for everyone in the room in any mode —
  // chat isn't tied to the speaker floor. editChatMessage() refuses anything
  // that isn't the requester's own text message.
  on(EVENTS.CHAT_EDIT, ({ id, text } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return ack?.({ ok: false, error: 'not in a room' });
    const body = String(text ?? '').trim();
    if (!body) return ack?.({ ok: false, error: 'empty message' });
    const msg = editChatMessage(room, socket.id, String(id ?? ''), body.slice(0, 2000));
    if (!msg) return ack?.({ ok: false, error: 'you can only edit your own text messages' });
    ack?.({ ok: true });
    io.to(joinedRoomId).emit(EVENTS.CHAT_EDITED, {
      id: msg.id,
      text: msg.text,
      editedAt: msg.editedAt,
    });
  });

  // Unsend (delete for everyone) your own message — text, sticker or file.
  on(EVENTS.CHAT_UNSEND, ({ id } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return ack?.({ ok: false, error: 'not in a room' });
    const msgId = String(id ?? '');
    const fileId = chatFileIdOf(room.chat.find((m) => m.id === msgId)?.file?.url);
    if (!unsendChatMessage(room, socket.id, msgId)) {
      return ack?.({ ok: false, error: 'you can only unsend your own messages' });
    }
    if (fileId) deleteChatFile(fileId); // an unsent file is gone from storage too
    ack?.({ ok: true });
    io.to(joinedRoomId).emit(EVENTS.CHAT_UNSENT, { id: msgId });
  });

  // --- Chat moderation: a moderator (host or co-host) can delete ANYONE's
  // message, and mute one person's chat (they can still read it, not post).
  // Checked here on the server — the buttons in the app prove nothing.

  // Delete someone's message for everyone. Same broadcast as an unsend, so
  // every chat removes it the same way.
  on(EVENTS.CHAT_DELETE, ({ id } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    const removed = deleteChatMessage(room, String(id ?? ''));
    if (!removed) return ack?.({ ok: false, error: 'no such message' });
    const fileId = chatFileIdOf(removed.file?.url);
    if (fileId) deleteChatFile(fileId);
    ack?.({ ok: true });
    io.to(joinedRoomId).emit(EVENTS.CHAT_UNSENT, { id: removed.id });
  });

  // Mute / unmute one person's chat. Never the host (requireTarget) or the
  // co-host (setChatMuted refuses). Shows in room-state (`chatMuted`), so their
  // app can grey out the message box and say why.
  on(EVENTS.CHAT_MUTE, ({ targetId, muted } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    const target = requireTarget(room, targetId, ack);
    if (!target) return;
    if (!setChatMuted(room, target, muted === true)) {
      return ack?.({ ok: false, error: 'a co-host’s chat can’t be muted' });
    }
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Live captions (client/src/captions.js) ----------------------------
  // Switch captions on / off for myself. While anyone has them on, room-state
  // says `captionsOn`, and speakers' browsers start turning speech into text.
  on(EVENTS.CAPTIONS_WANT, ({ on: want } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room?.participants[socket.id]) return ack?.({ ok: false, error: 'not in a room' });
    setCaptionWatcher(room, socket.id, want === true);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // A line of what I'm saying, passed on to the whole room — never stored.
  // Only while captions are on, and only from someone who may speak.
  on(EVENTS.CAPTION, ({ text, final } = {}) => {
    const room = getRoom(joinedRoomId);
    const participant = room?.participants[socket.id];
    if (!participant || !mayCaption(room, socket.id)) return;
    const line = oneLine(text, 300);
    if (!line) return;
    io.to(joinedRoomId).emit(EVENTS.CAPTION, {
      id: socket.id,
      name: participant.name,
      text: line,
      final: final === true,
    });
  });

  // "Someone is typing" — pure relay to the rest of the room, never stored.
  // socket.to() excludes the sender, so nobody sees their own indicator.
  on(EVENTS.CHAT_TYPING, ({ typing } = {}) => {
    const room = getRoom(joinedRoomId);
    const participant = room?.participants[socket.id];
    if (!room || !participant) return;
    if (typing === true && isChatMuted(room, socket.id)) return; // can't post, so not "typing"
    socket.to(joinedRoomId).emit(EVENTS.CHAT_TYPING, {
      id: socket.id,
      name: participant.name,
      typing: typing === true,
    });
  });

  // --- Screen sharing (added after in-call chat) -----------------------
  // Google-Meet-style: only one presenter at a time. This only records WHO is
  // sharing and the id of their screen stream (so clients can pick the screen
  // track out of that peer's inbound media) — the media itself is renegotiated
  // peer-to-peer. Fire-and-forget.
  on(EVENTS.SCREEN_SHARE, ({ on, streamId } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return;
    const bumped = setSharing(room, socket.id, on === true, streamId);
    if (bumped) {
      io.to(bumped).emit(EVENTS.SCREEN_SHARE_STOPPED);
      console.log(`[room ${joinedRoomId}] ${bumped} bumped by ${socket.id}'s share`);
    }
    console.log(`[room ${joinedRoomId}] ${socket.id} screen-share ${on ? 'on' : 'off'}`);
    broadcastRoom(joinedRoomId);
  });

  // --- Mic on/off reports -------------------------------------------------
  // Each client tells us whenever its own mic turns on or off. We store it and
  // re-broadcast the room, so every other screen can show "X is muted".
  on(EVENTS.MIC_STATE, ({ on } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return;
    // Nothing changed? Skip the broadcast — no need to wake every client.
    if ((room.mics[socket.id] ?? true) === (on === true)) return;
    setMic(room, socket.id, on);
    broadcastRoom(joinedRoomId);
  });

  // Camera on/off reports — same as the mic.
  on(EVENTS.CAM_STATE, ({ on } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return;
    if ((room.cams[socket.id] ?? true) === (on === true)) return;
    setCam(room, socket.id, on);
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 6: active-speaker pings -------------------------------------
  // The client sends this only when its own mic level crosses the talk
  // threshold (rising) or has been quiet for a beat (falling). We record it
  // and re-broadcast so every client can move the "active speaker" glow.
  // Fire-and-forget — no ack.
  on(EVENTS.SPEAKING, ({ speaking } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room) return;

    const on = speaking === true;
    const changed = setSpeaking(room, socket.id, on);
    if (changed) broadcastRoom(joinedRoomId);
  });

  // --- Phase 2: WebRTC signaling relay -------------------------------------
  // A peer wants to send an offer / answer / ICE candidate to ONE other peer.
  // We don't inspect or store the payload; we just forward it to `targetId`,
  // stamped with `from` so the receiver knows who it came from.
  //
  // Safety checks:
  //  - the sender must already be in a room (can't relay before joining)
  //  - the target must be in the SAME room (can't poke sockets in other rooms)
  on(EVENTS.RTC_SIGNAL, ({ targetId, description, candidate } = {}) => {
    if (!joinedRoomId || !targetId) return;

    const room = getRoom(joinedRoomId);
    // Both ends must be full participants (a waiter can't relay media).
    if (!room || !room.participants[socket.id] || !room.participants[targetId]) return;

    io.to(targetId).emit(EVENTS.RTC_SIGNAL, {
      from: socket.id,
      description, // present for an SDP offer/answer, undefined for ICE
      candidate, // present for an ICE candidate, undefined for SDP
    });
  });

  // --- Reactions, questions, polls, the meeting report (activities.js) -----

  // The room + me, if I'm a full participant (not knocking).
  function myRoom(ack) {
    const room = getRoom(joinedRoomId);
    if (!room?.participants[socket.id]) {
      ack?.({ ok: false, error: 'not in a room' });
      return null;
    }
    return room;
  }

  // 👍 👏 🙏 … floats up for everyone. Not stored.
  on(EVENTS.REACT, ({ emoji } = {}) => {
    const room = myRoom();
    if (!room || !REACTIONS.includes(emoji)) return;
    io.to(joinedRoomId).emit(EVENTS.REACTION, {
      id: socket.id,
      name: room.participants[socket.id].name,
      emoji,
    });
  });

  on(EVENTS.Q_ASK, ({ text } = {}, ack) => {
    const room = myRoom(ack);
    if (!room) return;
    const q = askQuestion(room, socket.id, room.participants[socket.id].name, text);
    if (!q) return ack?.({ ok: false, error: 'Write a question first.' });
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
    // Everyone hears about it: a line in the chat (desktop also pops it up
    // in the corner), with "View" opening the questions.
    postNote(joinedRoomId, room, `${q.name} asked: “${q.text}”`, null, { question: q.id });
  });

  on(EVENTS.Q_VOTE, ({ id } = {}, ack) => {
    const room = myRoom(ack);
    if (!room) return;
    if (!voteQuestion(room, socket.id, id)) return ack?.({ ok: false, error: 'not found' });
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // A moderator closes any question (answered / dismissed); anyone may
  // withdraw their own.
  on(EVENTS.Q_CLOSE, ({ id } = {}, ack) => {
    const room = myRoom(ack);
    if (!room) return;
    if (!isModerator() && askerOf(room, id) !== socket.id) {
      return ack?.({ ok: false, error: 'only a moderator can do that' });
    }
    if (!closeQuestion(room, id)) return ack?.({ ok: false, error: 'not found' });
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.POLL_START, ({ question, options } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    const poll = startPoll(room, room.participants[socket.id].name, question, options);
    if (!poll)
      return ack?.({ ok: false, error: 'A poll needs a question and at least two answers.' });
    console.log(`[room ${joinedRoomId}] poll started by ${socket.id}`);
    // A line in the chat too, so everyone notices ("Ada started a poll: …").
    postNote(joinedRoomId, room, `${poll.by} started a poll: ${poll.question}`, null);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.POLL_VOTE, ({ id, option } = {}, ack) => {
    const room = myRoom(ack);
    if (!room) return;
    if (!votePoll(room, socket.id, id, option)) return ack?.({ ok: false, error: 'poll closed' });
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.POLL_END, ({ id } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (!endPoll(room, id)) return ack?.({ ok: false, error: 'not found' });
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.POLL_CLEAR, ({ id } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (!clearPoll(room, id)) return ack?.({ ok: false, error: 'not found' });
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // Moderators: who came, who spoke and for how long (see meetingReport).
  on(EVENTS.REPORT_GET, (_payload, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    ack?.({ ok: true, report: meetingReport(room) });
  });

  // --- Breakout rooms (see EVENTS.BREAKOUT_* and startBreakouts above) ------
  on(EVENTS.BREAKOUT_START, ({ rooms: count, minutes, assign } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (room.breakoutOf) return ack?.({ ok: false, error: 'Already in a breakout room.' });
    if (room.breakouts) return ack?.({ ok: false, error: 'Breakout rooms are already running.' });
    const n = Number(count);
    const mins = Number(minutes);
    const others = Object.keys(room.participants).filter(
      (id) => id !== room.hostId && id !== room.cohostId,
    );
    if (!Number.isInteger(n) || n < 1 || n > BREAKOUT_MAX_ROOMS) {
      return ack?.({ ok: false, error: 'Pick how many rooms.' });
    }
    if (!Number.isInteger(mins) || mins < 0 || mins > 180) {
      return ack?.({ ok: false, error: 'Pick how long.' });
    }
    // The host chose the rooms: keep only real people and real rooms.
    let chosen = null;
    if (assign && typeof assign === 'object') {
      chosen = {};
      for (const id of others) {
        const k = assign[id];
        if (Number.isInteger(k) && k >= 0 && k < n) chosen[id] = k;
      }
      if (!Object.keys(chosen).length) {
        return ack?.({ ok: false, error: 'Put at least one person in a room.' });
      }
    } else if (others.length < 2) {
      return ack?.({ ok: false, error: 'You need at least 2 other people.' });
    }
    startBreakouts(joinedRoomId, n, mins, chosen);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  on(EVENTS.BREAKOUT_END, (_payload, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (!room.breakouts) return ack?.({ ok: false, error: 'No breakout rooms running.' });
    endBreakouts(joinedRoomId);
    ack?.({ ok: true });
  });

  on(EVENTS.BREAKOUT_MOVE, ({ id, to } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (!room.breakouts) return ack?.({ ok: false, error: 'No breakout rooms running.' });
    const k = Number(to);
    if (typeof id !== 'string' || !Number.isInteger(k) || k < -1) {
      return ack?.({ ok: false, error: 'Pick a room.' });
    }
    const error = moveBreakoutPerson(joinedRoomId, id, k, room.participants[socket.id].name);
    ack?.(error ? { ok: false, error } : { ok: true });
  });

  on(EVENTS.BREAKOUT_MESSAGE, ({ text } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    const body = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!body || !room.breakouts) return ack?.({ ok: false, error: 'Nothing to send.' });
    const from = room.participants[socket.id].name;
    for (const id of room.breakouts.ids) {
      const r = getRoom(id);
      if (r) postNote(id, r, `📣 ${from}: ${body}`, null);
    }
    ack?.({ ok: true });
  });

  // --- Recording (see EVENTS.REC_* / DEVICE, and the helpers above) ---------

  // Laptop or phone, and whether this browser can record at all.
  on(EVENTS.DEVICE, ({ desktop, canRecord } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room?.participants[socket.id]) return;
    setDevice(room, socket.id, desktop);
    room.participants[socket.id].canRecord = canRecord !== false;
  });

  // Host / co-host: start recording. The recorder may be someone else (a
  // laptop beats a phone) — see pickRecorder.
  on(EVENTS.REC_START, async (_payload, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (room.recording) return ack?.({ ok: false, error: 'already recording' });
    const roomId = joinedRoomId;
    const name = room.participants[socket.id].name;
    // Claimed straight away, so a double click can't start two.
    room.recording = { id: null, startedAt: Date.now(), recorderId: null, part: null };
    let id;
    try {
      id = await recordings.startRecording({ title: room.title || roomId });
    } catch (err) {
      room.recording = null;
      console.error(`[room ${roomId}] couldn't start recording:`, err.message);
      return ack?.({ ok: false, error: 'Couldn’t start recording. Please try again.' });
    }
    // Stopped, or everyone left, while storage was answering.
    if (getRoom(roomId) !== room || !room.recording) {
      recordings.finishRecording(id).catch(() => {});
      return ack?.({ ok: false, error: 'not recording' });
    }
    room.recording.id = id;
    handOver(roomId, room, { prefer: socket.id });
    console.log(`[room ${roomId}] recording ${id} started by ${socket.id}`);
    postNote(roomId, room, `${name} started recording`, id);
    ack?.({ ok: true, id });
    broadcastRoom(roomId);
  });

  on(EVENTS.REC_STOP, (_payload, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    const id = room.recording?.id;
    if (!id) return ack?.({ ok: false, error: 'not recording' });
    endRecording(room);
    console.log(`[room ${joinedRoomId}] recording ${id} stopped by ${socket.id}`);
    postNote(joinedRoomId, room, `${room.participants[socket.id].name} stopped recording`, id);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // The next second of video from the recorder. recordings.addChunk checks
  // it's really from the person recording that part.
  on(EVENTS.REC_CHUNK, ({ id, part, type, data, final } = {}, ack) => {
    if (!getRoom(joinedRoomId)?.participants[socket.id]) return ack?.({ ok: false });
    const ok =
      Buffer.isBuffer(data) &&
      data.length <= 8 * 1024 * 1024 &&
      Number.isInteger(part) &&
      recordings.addChunk(id, part, type, data, final === true, socket.id);
    ack?.({ ok });
  });

  // --- Cloudflare SFU: the video desk (see EVENTS.SFU_* and sfu.js) --------
  // The browser does the WebRTC side; these make the matching Cloudflare API
  // calls (they need the app secret) after checking the request is allowed.

  // The room, if SFU calls are on and I'm a full participant (not knocking).
  function sfuRoom(ack) {
    const room = getRoom(joinedRoomId);
    if (!sfu.sfuEnabled() || !room?.participants[socket.id]) {
      ack?.({ ok: false, error: 'not in a room' });
      return null;
    }
    return room;
  }

  // My Cloudflare connection's bookkeeping, if I've started one.
  function mySession(room, ack) {
    const m = room.media[socket.id];
    if (!m?.sessionId) {
      ack?.({ ok: false, error: 'no session' });
      return null;
    }
    return m;
  }

  // Every SFU handler waits on Cloudflare, which can fail or time out: tell
  // the browser (it starts its connection over) instead of leaving it hanging.
  function sfuHandler(event, handler) {
    on(event, async (payload, ack) => {
      try {
        await handler(payload, ack);
      } catch (err) {
        console.error(`[sfu] ${event} failed for ${socket.id}:`, err.message);
        ack?.({ ok: false, error: 'video service error' });
      }
    });
  }

  // Short ids from a browser's SDP ("0", "1", …).
  const isMid = (mid) => typeof mid === 'string' && mid.length > 0 && mid.length <= 16;
  const KINDS = ['audio', 'video', 'screen', 'screenAudio'];

  sfuHandler(EVENTS.SFU_SESSION, async (_payload, ack) => {
    const room = sfuRoom(ack);
    if (!room) return;
    const sessionId = await sfu.newSession();
    if (!room.participants[socket.id]) return; // left while we waited
    // A fresh connection: whatever I was sending before is gone.
    const m = mediaOf(room, socket.id);
    for (const t of Object.values(m.tracks)) clearTimeout(t.cutTimer);
    m.sessionId = sessionId;
    m.tracks = {};
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  sfuHandler(EVENTS.SFU_PUBLISH, async ({ sdp, tracks } = {}, ack) => {
    const room = sfuRoom(ack);
    const m = room && mySession(room, ack);
    if (!m) return;
    if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 4) {
      return ack?.({ ok: false, error: 'bad tracks' });
    }
    const kinds = tracks.map((t) => t?.kind);
    if (
      !tracks.every((t) => isMid(t?.mid) && KINDS.includes(t.kind)) ||
      new Set(kinds).size !== kinds.length
    ) {
      return ack?.({ ok: false, error: 'bad tracks' });
    }
    // Allowed to send each of these, and not sending one of that kind already?
    for (const kind of kinds) {
      if (!maySend(room, socket.id, kind)) {
        return ack?.({ ok: false, error: `not allowed to send ${kind}` });
      }
      if (m.tracks[kind]) return ack?.({ ok: false, error: `already sending ${kind}` });
    }

    const named = tracks.map(({ mid, kind, simulcast }) => ({
      mid,
      kind,
      trackName: `${kind}-${randomUUID()}`,
      // The camera in three sizes (see sfu.LAYERS) — cameras only.
      simulcast: kind === 'video' && simulcast === true,
    }));
    const sessionId = m.sessionId;
    const res = await sfu.publish(sessionId, sdp, named);
    // Started over while we waited (or left)? This answer is useless now.
    if (room.media[socket.id] !== m || m.sessionId !== sessionId) {
      return ack?.({ ok: false, error: 'session replaced' });
    }
    const failed = [];
    for (const t of named) {
      const result = res.tracks.find((r) => r.trackName === t.trackName);
      if (result?.errorCode) failed.push(t.kind);
      else {
        m.tracks[t.kind] = {
          key: randomUUID(),
          trackName: t.trackName,
          mid: t.mid,
          simulcast: t.simulcast,
        };
      }
    }
    ack?.({ ok: true, sdp: res.sdp, failed });
    broadcastRoom(joinedRoomId); // everyone else pulls the new tracks
  });

  // A layer (size) a viewer may ask for, or the middle one by default.
  const layerOf = (rid) => (sfu.LAYERS.includes(rid) ? rid : 'b');

  sfuHandler(EVENTS.SFU_PULL, async ({ keys, rids } = {}, ack) => {
    const room = sfuRoom(ack);
    const m = room && mySession(room, ack);
    if (!m) return;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 64) {
      return ack?.({ ok: false, error: 'bad keys' });
    }
    // Only tracks the snapshot offers: someone else's, in this room, that
    // they may still send (never a listener's audio).
    const results = [];
    const sources = [];
    for (const key of new Set(keys)) {
      const t = findTrack(room, key);
      if (!t || t.ownerId === socket.id || !maySend(room, t.ownerId, t.kind)) {
        results.push({ key, error: 'unavailable' });
      } else {
        sources.push({
          key,
          sessionId: t.sessionId,
          trackName: t.trackName,
          // A simulcast camera: the size the viewer asked for.
          rid: t.simulcast ? layerOf(rids?.[key]) : undefined,
        });
      }
    }
    if (!sources.length) return ack?.({ ok: true, sdp: null, tracks: results });

    const res = await sfu.pull(m.sessionId, sources);
    for (const s of sources) {
      const r = res.tracks.find((x) => x.trackName === s.trackName && x.sessionId === s.sessionId);
      if (!r || r.errorCode || r.mid == null) {
        console.warn(
          `[sfu] couldn't hand ${socket.id} a track: ${r?.errorCode ?? 'no result'} ${r?.errorDescription ?? ''}`,
        );
      }
      results.push(
        r && !r.errorCode && r.mid != null
          ? { key: s.key, mid: String(r.mid) }
          : { key: s.key, error: r?.errorCode ?? 'failed' },
      );
    }
    ack?.({ ok: true, sdp: res.sdp, tracks: results });
  });

  // Switch cameras I'm receiving to another size (layer). `changes` is
  // [{ key, mid (where I receive it), rid }]. Only simulcast cameras that
  // are still on offer; anything else is skipped.
  sfuHandler(EVENTS.SFU_LAYERS, async ({ changes } = {}, ack) => {
    const room = sfuRoom(ack);
    const m = room && mySession(room, ack);
    if (!m) return;
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 64) {
      return ack?.({ ok: false, error: 'bad changes' });
    }
    const valid = [];
    for (const c of changes) {
      const t = findTrack(room, c?.key);
      if (
        t?.simulcast &&
        t.ownerId !== socket.id &&
        maySend(room, t.ownerId, t.kind) &&
        isMid(c.mid) &&
        sfu.LAYERS.includes(c.rid)
      ) {
        valid.push({ sessionId: t.sessionId, trackName: t.trackName, mid: c.mid, rid: c.rid });
      }
    }
    if (!valid.length) return ack?.({ ok: true, sdp: null });
    const res = await sfu.setLayers(m.sessionId, valid);
    ack?.({ ok: true, sdp: res.sdp });
  });

  sfuHandler(EVENTS.SFU_ANSWER, async ({ sdp } = {}, ack) => {
    const room = sfuRoom(ack);
    const m = room && mySession(room, ack);
    if (!m) return;
    await sfu.answer(m.sessionId, sdp);
    ack?.({ ok: true });
  });

  sfuHandler(EVENTS.SFU_CLOSE, async ({ mids, sdp } = {}, ack) => {
    const room = sfuRoom(ack);
    const m = room && mySession(room, ack);
    if (!m) return;
    if (!Array.isArray(mids) || mids.length < 1 || mids.length > 64 || !mids.every(isMid)) {
      return ack?.({ ok: false, error: 'bad mids' });
    }
    // Always negotiated (with the browser's offer). Forced closes are only
    // ever the server's own (enforceMedia).
    if (typeof sdp !== 'string') return ack?.({ ok: false, error: 'offer required' });
    const res = await sfu.close(m.sessionId, mids, sdp);
    // Any of mine that were being SENT: off the snapshot, so others drop them.
    let changed = false;
    for (const [kind, t] of Object.entries(m.tracks)) {
      if (mids.includes(t.mid)) {
        clearTimeout(t.cutTimer);
        delete m.tracks[kind];
        changed = true;
      }
    }
    ack?.({ ok: true, sdp: res.sdp });
    if (changed) broadcastRoom(joinedRoomId);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected ${socket.id} (${reason})`);
    // Their seat already moved to a newer connection (handleResume) — this is
    // just the old one being closed. Nothing to clean up.
    if (socket.data.replaced) return;

    if (joinedRoomId) {
      // Clear any lingering "typing" indicator for this socket right away.
      socket.to(joinedRoomId).emit(EVENTS.CHAT_TYPING, { id: socket.id, typing: false });
    }

    // Waiting for a fixed room's host to arrive? Just stop waiting.
    const early = awaitingHost.get(joinedRoomId);
    if (early?.delete(socket.id)) {
      if (!early.size) awaitingHost.delete(joinedRoomId);
      return;
    }

    // Was this socket only knocking? Drop it from the waiting list and refresh
    // the moderators' view.
    const waitingRoom = removeWaiting(socket.id);
    if (waitingRoom) {
      broadcastRoom(waitingRoom);
      return;
    }

    // A network drop (not Leave / closing the tab / being removed): hold the
    // seat. Everyone sees "Reconnecting…" on their tile; if they aren't back
    // within RECONNECT_GRACE_MS, they're taken out as if they'd left.
    const room = getRoom(joinedRoomId);
    if (!DELIBERATE.has(reason) && room?.participants[socket.id]) {
      markAway(room, socket.id);
      const id = socket.id;
      // They were recording: someone else takes over right away (no waiting
      // to see if they come back — the meeting would go unrecorded).
      if (room.recording?.recorderId === id) handOver(joinedRoomId, room);
      awayTimers.set(
        id,
        setTimeout(() => {
          console.log(`[room ${joinedRoomId}] ${id} didn't reconnect in time`);
          finishLeave(id);
        }, RECONNECT_GRACE_MS),
      );
      console.log(`[room ${joinedRoomId}] ${id} dropped — holding their seat`);
      broadcastRoom(joinedRoomId);
      return;
    }

    // They pressed Leave (or closed the tab): out of the room now, but with a
    // one-minute rejoin pass. Being removed or denied (the server closed the
    // connection) gets no pass.
    if (reason === 'client namespace disconnect' && room?.participants[socket.id]) {
      const pass = createPass(room, joinedRoomId, socket.id);
      finishLeave(socket.id);
      // Who took over as host — so a returning host knows whom to take it back from.
      if (pass) pass.heir = getRoom(pass.roomId)?.hostId ?? null;
      return;
    }

    finishLeave(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

// Recordings: check storage works (the log says where they're saved), and
// delete expired ones now and every hour.
checkStorage();
recordings.sweep();
setInterval(() => recordings.sweep(), 60 * 60 * 1000).unref();
// Chat files older than a day (also catches rooms that closed while the
// server was restarting).
sweepChatFiles();
setInterval(() => sweepChatFiles(), 60 * 60 * 1000).unref();
// …and one-off scheduled meetings, a day after they end.
sweepNames();
setInterval(() => sweepNames(), 60 * 60 * 1000).unref();
