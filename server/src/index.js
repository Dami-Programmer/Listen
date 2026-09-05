// Phase 1 + 2 + 3 + 4 + 5 + 6: signaling + moderation server.
//
// Phase 1 — the server owns all room state (see rooms.js). Every state change is
// broadcast as a full room-state snapshot so clients never reconstruct state
// incrementally.
//
// Phase 2 — the server also relays WebRTC negotiation messages between peers
// (the RTC_SIGNAL handler below). The media itself flows browser-to-browser and
// never touches this server.
//
// Phases 4-6 — host-authoritative moderation. Every host-only action is
// re-checked here (requireHostRoom) regardless of what the client shows. Since
// media is peer-to-peer, "listener" is cooperative: the server asks the
// target's client to disable its own tracks.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { EVENTS, MODES, ROLES } from '@listen/shared';
import {
  addParticipant,
  clearFloor,
  getRoom,
  grantFloor,
  lowerHand,
  raiseHand,
  removeParticipant,
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
  res.json({ ok: true, phase: 6, time: new Date().toISOString() });
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
// revoked, or the room re-opens. The host is exempt: armSilence bails on any
// non-speaker role.
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
  if (next) grantFloor(room, next);
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

    ack?.({ ok: true, selfId: socket.id, state: snapshot(id) });
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

    setMode(room, mode);
    clearRoomSilence(joinedRoomId);
    console.log(`[room ${joinedRoomId}] mode -> ${mode} (by host ${socket.id})`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 5: hand-raising & the speaker queue --------------------------
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
    raiseHand(room, socket.id);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

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
    grantFloor(room, targetId);
    clearSilence(joinedRoomId, targetId); // fresh start; timer waits for word one
    console.log(`[room ${joinedRoomId}] grant floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.REVOKE_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    revokeFloor(room, targetId);
    clearSilence(joinedRoomId, targetId);
    console.log(`[room ${joinedRoomId}] revoke floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.CLEAR_FLOOR, (_payload, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    clearFloor(room);
    clearRoomSilence(joinedRoomId);
    console.log(`[room ${joinedRoomId}] floor cleared by host ${socket.id}`);
    ack?.({ ok: true });
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
      clearSilence(joinedRoomId, socket.id);
    } else if (changed) {
      armSilence(joinedRoomId, socket.id);
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
      description,
      candidate,
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
