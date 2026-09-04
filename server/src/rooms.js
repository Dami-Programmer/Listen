// Phase 1 + 3: in-memory room registry.
// Single source of truth for who is in a room and who may speak.
// No persistence — everything lives in this module's `rooms` map and is gone
// when the process restarts. The client never decides its own state; it only
// renders the snapshots this file produces.
//
// Roles (Phase 3): every participant has exactly one — host | speaker | listener.
// In open mode every non-host is a speaker; the role is tracked but nothing on
// the server enforces it yet. `setRole` below is the single place a role
// changes, so later phases never poke `participant.role` directly.

import { MODES, ROLES } from '@listen/shared';

/**
 * roomId -> {
 *   hostId: string | null,
 *   mode: 'open' | 'moderated',
 *   participants: { [socketId]: { id, name, role } },
 *   queue: string[]   // socketIds of listeners with a raised hand (Phase 5)
 * }
 */
const rooms = new Map();

function createRoom() {
  return {
    hostId: null,
    mode: MODES.OPEN,
    participants: {},
    queue: [],
  };
}

export function getRoom(roomId) {
  return rooms.get(roomId) ?? null;
}

/**
 * Add a participant to a room, creating the room if needed.
 * The first person to join becomes the host.
 * Returns the room.
 */
export function addParticipant(roomId, socketId, name) {
  let room = rooms.get(roomId);
  if (!room) {
    room = createRoom();
    rooms.set(roomId, room);
  }

  const isFirst = Object.keys(room.participants).length === 0;
  if (isFirst) {
    room.hostId = socketId;
  }

  room.participants[socketId] = {
    id: socketId,
    name: name?.trim() || 'Guest',
    role: isFirst ? ROLES.HOST : ROLES.SPEAKER,
  };

  return room;
}

/**
 * Phase 3 — the ONE place a participant's role changes.
 * Validates the role and never touches the host (whose role tracks room.hostId).
 * Later phases (set-mode, grant-floor, revoke-floor, …) all go through here.
 */
export function setRole(room, socketId, role) {
  const participant = room?.participants[socketId];
  if (!participant) return;
  if (!Object.values(ROLES).includes(role)) return;
  if (socketId === room.hostId) return; // the host is always 'host'
  participant.role = role;
}

/**
 * Remove a participant from whatever room they're in.
 * If the host left, promote the next participant (insertion order).
 * If the room is now empty, delete it.
 *
 * Returns { roomId, room } for the affected room, or null if the socket
 * wasn't in any room.
 */
export function removeParticipant(socketId) {
  for (const [roomId, room] of rooms) {
    if (!room.participants[socketId]) continue;

    delete room.participants[socketId];
    room.queue = room.queue.filter((id) => id !== socketId);

    const remaining = Object.keys(room.participants);
    if (remaining.length === 0) {
      rooms.delete(roomId);
      return { roomId, room: null };
    }

    if (room.hostId === socketId) {
      const nextHostId = remaining[0];
      room.hostId = nextHostId;
      room.participants[nextHostId].role = ROLES.HOST;
    }

    return { roomId, room };
  }

  return null;
}

/**
 * The full snapshot broadcast to every client on every change.
 * Plain data only — safe to JSON.stringify.
 */
export function snapshot(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    roomId,
    hostId: room.hostId,
    mode: room.mode,
    participants: Object.values(room.participants),
    queue: [...room.queue],
  };
}

// Test/debug helper — not used in the request path.
export function _reset() {
  rooms.clear();
}

export { rooms };
