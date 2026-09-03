// Phase 1: signaling server skeleton.
// Express health route + Socket.IO. The server owns all room state (see
// rooms.js); there is no media yet. Every state change is broadcast as a full
// room-state snapshot so clients never have to reconstruct state incrementally.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { EVENTS } from '@listen/shared';
import { addParticipant, removeParticipant, snapshot } from './rooms.js';

// Load the single .env from the repo root (two levels up from server/src).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, phase: 1, time: new Date().toISOString() });
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
