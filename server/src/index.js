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
import { EVENTS, MODES, ROLES, STICKERS } from '@listen/shared';
import {
  addChatMessage,
  addParticipant,
  clearFloor,
  getRoom,
  grantFloor,
  lowerHand,
  raiseHand,
  removeParticipant,
  reorderQueue,
  revokeFloor,
  setMode,
  setSpeaking,
  snapshot,
} from './rooms.js';

// Load the single .env from the repo root (two levels up from server/src).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, phase: 7, time: new Date().toISOString() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
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
// their first word. The host is exempt: armSilence bails on any non-speaker role.
const SILENCE_MS = 5000;
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

// The timer fired: this speaker has been quiet too long. Take their floor and
// hand it to whoever is first in the queue.
function enforceSilence(roomId, socketId) {
  silenceTimers.delete(silenceKey(roomId, socketId));

  const room = getRoom(roomId);
  if (!room || room.mode !== MODES.MODERATED) return;
  const participant = room.participants[socketId];
  if (!participant || participant.role !== ROLES.SPEAKER) return;

  revokeFloor(room, socketId);
  const next = room.queue[0];
  if (next) grantFloor(room, next); // promoted; their timer waits for word one
  console.log(
    `[room ${roomId}] silence timeout: ${socketId} lost the floor` +
      (next ? `, ${next} promoted` : ' (queue empty)'),
  );
  broadcastRoom(roomId);
}

io.on('connection', (socket) => {
  console.log(`[socket] connected ${socket.id}`);

  // Remember which room this socket joined so disconnect can clean up.
  let joinedRoomId = null;

  socket.on(EVENTS.JOIN_ROOM, ({ roomId, name } = {}, ack) => {
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

    joinedRoomId = id;
    socket.join(id);
    const room = addParticipant(id, socket.id, name);
    console.log(
      `[room ${id}] + ${socket.id} (${room.participants[socket.id].name})` +
        `${room.hostId === socket.id ? ' [host]' : ''} — ${Object.keys(room.participants).length} in room`,
    );

    ack?.({ ok: true, selfId: socket.id, state: snapshot(id), chat: [...room.chat] });
    broadcastRoom(id);
  });

  // --- Phase 4: host-only moderator toggle --------------------------------
  socket.on(EVENTS.SET_MODE, ({ mode } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) {
      ack?.({ ok: false, error: 'not in a room' });
      return;
    }
    if (socket.id !== room.hostId) {
      socket.emit(EVENTS.ERROR, { message: 'only the host can change the mode' });
      ack?.({ ok: false, error: 'only the host can change the mode' });
      return;
    }
    if (mode !== MODES.OPEN && mode !== MODES.MODERATED) {
      ack?.({ ok: false, error: `unknown mode: ${mode}` });
      return;
    }

    setMode(room, mode); // recomputes every non-host role
    clearRoomSilence(joinedRoomId);
    console.log(`[room ${joinedRoomId}] mode -> ${mode} (by host ${socket.id})`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 5: hand-raising & the speaker queue --------------------------
  //
  // Two listener-driven events (raise / lower my own hand) and the host-only
  // grant / revoke / clear. The host-only ones reuse the "must be room.hostId"
  // rejection from set-mode above.

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

  socket.on(EVENTS.RAISE_HAND, (_payload, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) return ack?.({ ok: false, error: 'not in a room' });
    raiseHand(room, socket.id); // no-op unless I'm a listener in a moderated room
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // A listener lowers their own hand; the host may lower anyone's ("Dismiss"
  // in the dashboard) by passing { targetId }.
  socket.on(EVENTS.LOWER_HAND, ({ targetId } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    if (!room) return ack?.({ ok: false, error: 'not in a room' });

    let subject = socket.id;
    if (targetId && targetId !== socket.id) {
      if (socket.id !== room.hostId) {
        return ack?.({ ok: false, error: 'only the host can lower another hand' });
      }
      subject = targetId;
    }

    lowerHand(room, subject);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.GRANT_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    grantFloor(room, targetId); // listener -> speaker, off the queue
    clearSilence(joinedRoomId, targetId); // fresh start; timer waits for word one
    console.log(`[room ${joinedRoomId}] grant floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.REVOKE_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    revokeFloor(room, targetId); // speaker -> listener
    clearSilence(joinedRoomId, targetId);
    console.log(`[room ${joinedRoomId}] revoke floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.CLEAR_FLOOR, (_payload, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    clearFloor(room); // every non-host speaker -> listener
    clearRoomSilence(joinedRoomId);
    console.log(`[room ${joinedRoomId}] floor cleared by host ${socket.id}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 7: full host moderation controls ---------------------------
  //
  // Host-only actions on a specific participant. All reuse requireHostRoom and,
  // like the Phase 5 handlers, target a socketId that must be a real member of
  // the host's own room (and never the host themselves).

  function requireTarget(room, targetId, ack) {
    if (!targetId || !room.participants[targetId]) {
      ack?.({ ok: false, error: 'unknown participant' });
      return null;
    }
    if (targetId === socket.id) {
      ack?.({ ok: false, error: 'that action cannot target yourself' });
      return null;
    }
    return targetId;
  }

  // Force-mute: the server can't touch peer-to-peer media, so it just asks the
  // target's client to disable its own mic track. Cooperative — they can unmute
  // themselves again. No room state changes, so no broadcast.
  socket.on(EVENTS.FORCE_MUTE, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    const target = requireTarget(room, targetId, ack);
    if (!target) return;
    io.to(target).emit(EVENTS.FORCE_MUTE);
    console.log(`[room ${joinedRoomId}] host ${socket.id} muted ${target}`);
    ack?.({ ok: true });
  });

  // Remove from call: tell the target why, then drop their socket. The normal
  // 'disconnect' handler below does the room cleanup + broadcast. A client that
  // is disconnected by the server does not auto-reconnect, so they land back on
  // the join screen and can rejoin if they want.
  socket.on(EVENTS.REMOVE_PARTICIPANT, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    const target = requireTarget(room, targetId, ack);
    if (!target) return;
    const targetSocket = io.sockets.sockets.get(target);
    console.log(`[room ${joinedRoomId}] host ${socket.id} removed ${target}`);
    ack?.({ ok: true });
    if (targetSocket) {
      targetSocket.emit(EVENTS.REMOVED);
      targetSocket.disconnect(true);
    }
  });

  // Reorder the queue. `order` must be a permutation of the current queue —
  // reorderQueue rejects anything else, so a stale list is a safe no-op.
  socket.on(EVENTS.REORDER_QUEUE, ({ order } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    reorderQueue(room, order);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- In-call chat (added after Phase 7) --------------------------------
  // Anyone in the room may post — chat is independent of the speaker floor, so
  // listeners get to talk too. The server names, trims, length-caps and
  // timestamps every message, keeps a bounded history, and fans it out on its
  // own event (never in room-state, which would resend the whole log on every
  // join/role change). Text is escaped by React on render.
  socket.on(EVENTS.CHAT_SEND, ({ text, kind } = {}, ack) => {
    const room = getRoom(joinedRoomId);
    const participant = room?.participants[socket.id];
    if (!room || !participant) {
      ack?.({ ok: false, error: 'not in a room' });
      return;
    }

    const isSticker = kind === 'sticker';
    const body = String(text ?? '').trim();
    if (isSticker) {
      if (!STICKERS.includes(body)) {
        ack?.({ ok: false, error: 'unknown sticker' });
        return;
      }
    } else if (!body) {
      ack?.({ ok: false, error: 'empty message' });
      return;
    }

    const message = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from: socket.id,
      name: participant.name,
      text: isSticker ? body : body.slice(0, 2000),
      kind: isSticker ? 'sticker' : 'text',
      ts: Date.now(),
    };
    addChatMessage(room, message);
    ack?.({ ok: true });
    io.to(joinedRoomId).emit(EVENTS.CHAT_MESSAGE, message);
  });

  // --- Phase 6: active-speaker pings -------------------------------------
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
  socket.on(EVENTS.RTC_SIGNAL, ({ targetId, description, candidate } = {}) => {
    if (!joinedRoomId || !targetId) return;

    const room = getRoom(joinedRoomId);
    if (!room || !room.participants[targetId]) return; // target not a roommate

    io.to(targetId).emit(EVENTS.RTC_SIGNAL, {
      from: socket.id,
      description, // present for an SDP offer/answer, undefined for ICE
      candidate, // present for an ICE candidate, undefined for SDP
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected ${socket.id} (${reason})`);
    if (joinedRoomId) clearSilence(joinedRoomId, socket.id);
    const result = removeParticipant(socket.id);
    if (!result) return;

    const { roomId, room } = result;
    if (room === null) {
      console.log(`[room ${roomId}] closed (empty)`);
      return;
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
