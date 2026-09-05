// Phase 1 + 2 + 3 + 4 + 5: signaling server.
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

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { EVENTS, MODES } from '@listen/shared';
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
  res.json({ ok: true, phase: 5, time: new Date().toISOString() });
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

io.on('connection', (socket) => {
  console.log(`[socket] connected ${socket.id}`);

  // Remember which room this socket joined so disconnect can clean up and,
  // when the host leaves, we can tell the room who was promoted.
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
  // The host flips the whole room between 'open' (free-for-all) and 'moderated'
  // (every non-host becomes a listener; each listener's client then silences
  // its own mic/camera). HARD-rejected for anyone who isn't the current host —
  // this is the first place the server enforces "host-authoritative".
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

    setMode(room, mode); // recomputes every non-host role, empties the queue
    console.log(`[room ${joinedRoomId}] mode -> ${mode} (by host ${socket.id})`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  // --- Phase 5: hand-raising & the speaker queue --------------------------
  //
  // Two listener-driven events (raise / lower my own hand) and three host-only
  // events (grant, revoke, clear the floor). The host-only ones reuse the exact
  // "must be room.hostId" rejection from set-mode above.
  //
  // Every handler ends the same way: mutate room state via a rooms.js helper,
  // then broadcast a fresh snapshot. The helpers are all no-ops when the action
  // isn't valid (wrong mode, wrong role, not queued), so the handlers stay thin.

  // Shared guard for the host-only actions. Returns the room if `socket` is its
  // host, otherwise emits the error + acks false and returns null.
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
    console.log(`[room ${joinedRoomId}] grant floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.REVOKE_FLOOR, ({ targetId } = {}, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    revokeFloor(room, targetId); // speaker -> listener
    console.log(`[room ${joinedRoomId}] revoke floor -> ${targetId}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
  });

  socket.on(EVENTS.CLEAR_FLOOR, (_payload, ack) => {
    const room = requireHostRoom(ack);
    if (!room) return;
    clearFloor(room); // every non-host speaker -> listener
    console.log(`[room ${joinedRoomId}] floor cleared by host ${socket.id}`);
    ack?.({ ok: true });
    broadcastRoom(joinedRoomId);
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
    if (!room || !room.participants[targetId]) return; // target not a roommate

    io.to(targetId).emit(EVENTS.RTC_SIGNAL, {
      from: socket.id,
      description, // present for an SDP offer/answer, undefined for ICE
      candidate, // present for an ICE candidate, undefined for SDP
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected ${socket.id} (${reason})`);
    const result = removeParticipant(socket.id);
    if (!result) return;

    const { roomId, room } = result;
    if (room === null) {
      console.log(`[room ${roomId}] closed (empty)`);
      return;
    }
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
