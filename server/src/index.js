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
// Phases 4-7 — host-authoritative moderation. Every host-only action is
// re-checked here (requireHostRoom) regardless of what the client shows. Since
// media is peer-to-peer, "mute" and "listener" are cooperative: the server asks
// the target's client to disable its own tracks.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { CHAT_FILE_MAX_BYTES, EVENTS, MODES, ROLES, STICKERS } from '@listen/shared';
import {
  addChatMessage,
  addParticipant,
  addWaiting,
  admitWaiting,
  clearFloor,
  demoteCohost,
  denyWaiting,
  editChatMessage,
  getRoom,
  grantFloor,
  lowerHand,
  passFloor,
  promoteCohost,
  raiseHand,
  removeParticipant,
  removeWaiting,
  reorderQueue,
  revokeFloor,
  setLock,
  setCam,
  setMic,
  setMode,
  setSharing,
  setSpeaking,
  snapshot,
  unsendChatMessage,
} from './rooms.js';

// Load the single .env from the repo root (two levels up from server/src).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

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

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, phase: 7, time: new Date().toISOString() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
  // Chat attachments travel as data: URLs — allow frames well over the 1 MB
  // default (a 5 MB file is ~6.7 MB base64, plus JSON overhead).
  maxHttpBufferSize: 12 * 1024 * 1024,
});

// Send the current snapshot of a room to everyone in it.
function broadcastRoom(roomId) {
  const state = snapshot(roomId);
  if (state) io.to(roomId).emit(EVENTS.ROOM_STATE, state);
}

// --- Phase 6: the silence rule ---------------------------------------------
// In a MODERATED room, a non-host speaker who goes quiet for SILENCE_MS loses
// the floor and queue[0] (if anyone is waiting) is promoted in their place.
//
// The timer is per (room, socket). It is armed the moment we hear
// "speaking: false" and cleared the instant they speak again — or leave, or are
// revoked, or the room re-opens. A freshly granted speaker has NO timer until
// their first word, because the client only ever sends "speaking: false" after
// a "speaking: true". The host is exempt: armSilence bails on any non-speaker
// role, and the host's role is 'host'.
const SILENCE_MS = 10000;
const silenceTimers = new Map(); // `${roomId}::${socketId}` -> Timeout

const silenceKey = (roomId, socketId) => `${roomId}::${socketId}`;

function clearSilence(roomId, socketId) {
  const key = silenceKey(roomId, socketId);
  const timer = silenceTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    silenceTimers.delete(key);
  }
}

// Drop every silence timer in a room (clear-floor, or the room going open).
function clearRoomSilence(roomId) {
  for (const key of [...silenceTimers.keys()]) {
    if (key.startsWith(`${roomId}::`)) {
      clearTimeout(silenceTimers.get(key));
      silenceTimers.delete(key);
    }
  }
}

function armSilence(roomId, socketId) {
  clearSilence(roomId, socketId);
  const room = getRoom(roomId);
  if (!room || room.mode !== MODES.MODERATED) return;
  const participant = room.participants[socketId];
  if (!participant || participant.role !== ROLES.SPEAKER) return; // host exempt
  silenceTimers.set(
    silenceKey(roomId, socketId),
    setTimeout(() => enforceSilence(roomId, socketId), SILENCE_MS),
  );
}

// The timer fired: this speaker has been quiet too long. Hand the floor on —
// same as the "pass the mic" button, just automatic.
function enforceSilence(roomId, socketId) {
  silenceTimers.delete(silenceKey(roomId, socketId));

  const room = getRoom(roomId);
  if (!room) return;
  const { passed, next } = passFloor(room, socketId);
  if (!passed) return;

  if (next) clearSilence(roomId, next); // fresh — timer waits for their first word
  console.log(
    `[room ${roomId}] silence timeout: ${socketId} lost the floor` +
      (next ? `, ${next} promoted` : ' (queue empty)'),
  );
  broadcastRoom(roomId);
}

io.on('connection', (socket) => {
  console.log(`[socket] connected ${socket.id}`);

  // Remember which room this socket joined so disconnect can clean up and,
  // when the host leaves, we can tell the room who was promoted.
  let joinedRoomId = null;

  // Wait for the TURN login (instant after the first few seconds of uptime).
  socket.on(EVENTS.JOIN_ROOM, (payload, ack) => {
    iceReady.then(() => handleJoin(payload, ack));
  });

  function handleJoin({ roomId, name, avatar, title } = {}, ack) {
    if (socket.disconnected) return; // left while we waited
    const id = String(roomId || '').trim();
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
    if (existing && existing.locked && Object.keys(existing.participants).length > 0) {
      joinedRoomId = id;
      addWaiting(existing, socket.id, name, avatar);
      console.log(`[room ${id}] ~ ${socket.id} knocking (${existing.waiting[socket.id].name})`);
      ack?.({ ok: true, waiting: true, selfId: socket.id, iceServers });
      broadcastRoom(id); // moderators' waiting list updates
      return;
    }

    joinedRoomId = id;
    socket.join(id);
    const room = addParticipant(id, socket.id, name, avatar, title);
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
    });
    broadcastRoom(id);
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
  socket.on(EVENTS.SET_MODE, ({ mode } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (mode !== MODES.OPEN && mode !== MODES.MODERATED) {
      ack?.({ ok: false, error: `unknown mode: ${mode}` });
      return;
    }

    setMode(room, mode); // recomputes every non-moderator role
    // Any flip retires every silence timer: open has no rule, and moderated
    // just made everyone a listener so there's nothing to time yet.
    clearRoomSilence(joinedRoomId);
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

  socket.on(EVENTS.RAISE_HAND, (_payload, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) return ack?.({ ok: false, error: 'not in a room' });
    raiseHand(room, socket.id); // no-op unless I'm a listener in a moderated room
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // A listener lowers their own hand; a moderator may lower anyone's ("Dismiss"
  // in the dashboard) by passing { targetId }.
  socket.on(EVENTS.LOWER_HAND, ({ targetId } = {}, ack) => {
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

  socket.on(EVENTS.GRANT_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    grantFloor(room, targetId); // listener -> speaker, off the queue
    clearSilence(joinedRoomId, targetId); // fresh start; timer waits for word one
    console.log(`[room ${joinedRoomId}] grant floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.REVOKE_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    revokeFloor(room, targetId); // speaker -> listener
    clearSilence(joinedRoomId, targetId);
    console.log(`[room ${joinedRoomId}] revoke floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.CLEAR_FLOOR, (_payload, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    clearFloor(room); // every non-moderator speaker -> listener
    clearRoomSilence(joinedRoomId);
    console.log(`[room ${joinedRoomId}] floor cleared by ${socket.id}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // A speaker gives up the floor themselves — the first raised hand takes it,
  // or the speaker just drops to listener if no hand is up.
  socket.on(EVENTS.PASS_MIC, (_payload, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) return ack?.({ ok: false, error: 'not in a room' });
    const { passed, next } = passFloor(room, socket.id);
    if (!passed) return ack?.({ ok: false, error: 'you are not a speaker' });
    clearSilence(joinedRoomId, socket.id);
    if (next) clearSilence(joinedRoomId, next);
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
  socket.on(EVENTS.FORCE_MUTE, ({ targetId } = {}, ack) => {
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
  socket.on(EVENTS.REMOVE_PARTICIPANT, ({ targetId } = {}, ack) => {
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
  });

  // Reorder the queue. `order` must be a permutation of the current queue —
  // reorderQueue rejects anything else, so a stale list is a safe no-op.
  socket.on(EVENTS.REORDER_QUEUE, ({ order } = {}, ack) => {
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

  socket.on(EVENTS.PROMOTE_COHOST, ({ targetId } = {}, ack) => {
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

  socket.on(EVENTS.DEMOTE_COHOST, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    const subject = targetId || room.cohostId;
    if (!subject || subject !== room.cohostId) {
      return ack?.({ ok: false, error: 'not the co-host' });
    }
    demoteCohost(room, subject);
    clearSilence(joinedRoomId, subject); // no silence timer for a fresh listener
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
    });
    return true;
  }

  socket.on(EVENTS.ADMIT, ({ socketId } = {}, ack) => {
    const room = requireModeratorRoom(ack);
    if (!room) return;
    if (!room.waiting[socketId]) return ack?.({ ok: false, error: 'not waiting' });
    letIn(room, socketId);
    console.log(`[room ${joinedRoomId}] ${socket.id} admitted ${socketId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.DENY, ({ socketId } = {}, ack) => {
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

  socket.on(EVENTS.SET_LOCK, ({ locked } = {}, ack) => {
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
  socket.on(EVENTS.CHAT_SEND, ({ text, kind, file } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    const participant = room?.participants[socket.id];
    if (!room || !participant) {
      ack?.({ ok: false, error: 'not in a room' });
      return;
    }

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
      message = {
        ...base,
        kind: 'file',
        file: {
          name,
          type: String(file?.type ?? 'application/octet-stream').slice(0, 100),
          size: Number.isFinite(file?.size) ? Math.max(0, Math.round(file.size)) : url.length,
          url,
        },
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

    addChatMessage(room, message);
    ack?.({ ok: true });
    io.to(joinedRoomId).emit(EVENTS.CHAT_MESSAGE, message);
  });

  // Edit your own text message. Works for everyone in the room in any mode —
  // chat isn't tied to the speaker floor. editChatMessage() refuses anything
  // that isn't the requester's own text message.
  socket.on(EVENTS.CHAT_EDIT, ({ id, text } = {}, ack) => {
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
  socket.on(EVENTS.CHAT_UNSEND, ({ id } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return ack?.({ ok: false, error: 'not in a room' });
    const msgId = String(id ?? '');
    if (!unsendChatMessage(room, socket.id, msgId)) {
      return ack?.({ ok: false, error: 'you can only unsend your own messages' });
    }
    ack?.({ ok: true });
    io.to(joinedRoomId).emit(EVENTS.CHAT_UNSENT, { id: msgId });
  });

  // "Someone is typing" — pure relay to the rest of the room, never stored.
  // socket.to() excludes the sender, so nobody sees their own indicator.
  socket.on(EVENTS.CHAT_TYPING, ({ typing } = {}) => {
    const room = getRoom(joinedRoomId);
    const participant = room?.participants[socket.id];
    if (!room || !participant) return;
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
  socket.on(EVENTS.SCREEN_SHARE, ({ on, streamId } = {}) => {
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
  socket.on(EVENTS.MIC_STATE, ({ on } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return;
    // Nothing changed? Skip the broadcast — no need to wake every client.
    if ((room.mics[socket.id] ?? true) === (on === true)) return;
    setMic(room, socket.id, on);
    broadcastRoom(joinedRoomId);
  });

  // Camera on/off reports — same as the mic.
  socket.on(EVENTS.CAM_STATE, ({ on } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[socket.id]) return;
    if ((room.cams[socket.id] ?? true) === (on === true)) return;
    setCam(room, socket.id, on);
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 6: active-speaker pings -------------------------------------
  // The client sends this only when its own mic level crosses the talk
  // threshold (rising) or has been quiet for a beat (falling). We record it,
  // start or cancel the silence timer, and re-broadcast so every client can
  // move the "active speaker" glow. Fire-and-forget — no ack.
  socket.on(EVENTS.SPEAKING, ({ speaking } = {}) => {
    const room = getRoom(joinedRoomId);
    if (!room) return;

    const on = speaking === true;
    const changed = setSpeaking(room, socket.id, on);

    if (on) {
      clearSilence(joinedRoomId, socket.id); // talking -> stop any quiet clock
    } else if (changed) {
      armSilence(joinedRoomId, socket.id); // just went quiet -> start it
    }

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
  socket.on(EVENTS.RTC_SIGNAL, ({ targetId, description, candidate } = {}) => {
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

  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected ${socket.id} (${reason})`);
    if (joinedRoomId) {
      clearSilence(joinedRoomId, socket.id);
      // Clear any lingering "typing" indicator for this socket right away.
      socket.to(joinedRoomId).emit(EVENTS.CHAT_TYPING, { id: socket.id, typing: false });
    }

    // Was this socket only knocking? Drop it from the waiting list and refresh
    // the moderators' view.
    const waitingRoom = removeWaiting(socket.id);
    if (waitingRoom) {
      broadcastRoom(waitingRoom);
      return;
    }

    const result = removeParticipant(socket.id);
    if (!result) return;

    const { roomId, room, admitted } = result;
    if (room === null) {
      console.log(`[room ${roomId}] closed (empty)`);
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
        });
      }
      console.log(`[room ${roomId}] host left; ${admitted} let in from the waiting room as host`);
    }

    // If the host just left, the promoted participant must be exempt from the
    // silence rule — retire any timer they were carrying as a speaker.
    clearSilence(roomId, room.hostId);
    console.log(
      `[room ${roomId}] - ${socket.id} — ${Object.keys(room.participants).length} left,` +
        ` host is ${room.hostId}`,
    );
    broadcastRoom(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
