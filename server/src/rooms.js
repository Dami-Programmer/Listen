// Phase 1 + 3 + 4 + 5 + 6: in-memory room registry.
// Single source of truth for who is in a room and who may speak.
// No persistence — everything lives in this module's `rooms` map and is gone
// when the process restarts. The client never decides its own state; it only
// renders the snapshots this file produces.
//
// Roles (Phase 3): every participant has exactly one — host | speaker | listener.
//   - open mode      -> every non-host is a speaker
//   - moderated mode -> every non-host is a listener (Phase 4)
// Roles are DATA here; nothing on the server blocks media (it's peer-to-peer).
// Enforcement is cooperative: a client that sees its own role become 'listener'
// silences its outbound tracks. `setRole` below is the single place any role
// changes, so Phases 4-7 never poke `participant.role` directly.

import { MODES, ROLES } from '@listen/shared';

/**
 * roomId -> {
 *   hostId: string | null,
 *   mode: 'open' | 'moderated',
 *   participants: { [socketId]: { id, name, role } },
 *   queue: string[]      // socketIds of listeners with a raised hand (Phase 5)
 *   speaking: string[]   // socketIds currently talking, in the order they
 *                        // started — so the LAST entry is the active speaker
 *                        // (Phase 6)
 *   chat: object[]       // recent in-call chat messages, oldest first, capped
 *                        // at CHAT_HISTORY (added after Phase 7)
 *   sharing: object      // socketId -> the id of that peer's screen MediaStream,
 *                        // for everyone currently screen sharing
 * }
 */
const rooms = new Map();

// How many recent chat messages a room keeps so a late joiner has context.
const CHAT_HISTORY = 100;

function createRoom() {
  return {
    hostId: null,
    mode: MODES.OPEN,
    participants: {},
    queue: [],
    speaking: [],
    chat: [],
    sharing: {},
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

  // First joiner is host. Everyone else matches the room's current mode:
  // a speaker in an open room, a listener in one that's already moderated.
  let role = ROLES.SPEAKER;
  if (isFirst) role = ROLES.HOST;
  else if (room.mode === MODES.MODERATED) role = ROLES.LISTENER;

  room.participants[socketId] = {
    id: socketId,
    name: name?.trim() || 'Guest',
    role,
  };

  return room;
}

/**
 * Phase 3 — the ONE place a participant's role changes.
 * Validates the role and never touches the host (whose role tracks room.hostId).
 * Phases 4-7 (set-mode, grant-floor, revoke-floor, …) all go through here.
 */
export function setRole(room, socketId, role) {
  const participant = room?.participants[socketId];
  if (!participant) return;
  if (!Object.values(ROLES).includes(role)) return;
  if (socketId === room.hostId) return; // the host is always 'host'
  participant.role = role;

  // A demoted speaker can't be "the active speaker" any more — drop them from
  // the talking list so the glow moves on immediately (Phase 6). Covers
  // revoke-floor, clear-floor and the open -> moderated flip in one place.
  if (role === ROLES.LISTENER) {
    room.speaking = room.speaking.filter((id) => id !== socketId);
  }
}

/**
 * Phase 4 — flip the room between 'open' and 'moderated'.
 *
 *   open      -> every non-host becomes a speaker (free-for-all)
 *   moderated -> every non-host becomes a listener (host controls the mic)
 *
 * The host's role never changes. A "kept speakers across the flip" set is still
 * deferred; for now, moderated demotes everyone.
 *
 * Any flip also empties the queue — a raised hand from the previous mode is
 * stale, and after open -> moderated everyone is a listener again anyway.
 */
export function setMode(room, mode) {
  if (!room) return;
  if (mode !== MODES.OPEN && mode !== MODES.MODERATED) return;

  room.mode = mode;
  room.queue = [];
  const nonHostRole = mode === MODES.MODERATED ? ROLES.LISTENER : ROLES.SPEAKER;
  for (const id of Object.keys(room.participants)) {
    setRole(room, id, nonHostRole); // no-ops for the host
  }
}

/* --------------------------------------------------------------------------
 * Phase 5 — the speaker queue.
 *
 * `room.queue` is an ordered list of socketIds: listeners who have asked for
 * the floor, oldest first. Like roles, it is DATA the server owns — the client
 * only renders it. Every role change below still goes through `setRole`.
 * ---------------------------------------------------------------------- */

/**
 * A listener asks for the floor. Only valid in a moderated room, only for a
 * listener, and only once (no duplicate entries). Silently ignored otherwise —
 * the caller can't do anything useful with an error here.
 */
export function raiseHand(room, socketId) {
  if (!room || room.mode !== MODES.MODERATED) return;
  const participant = room.participants[socketId];
  if (!participant || participant.role !== ROLES.LISTENER) return;
  if (room.queue.includes(socketId)) return;
  room.queue.push(socketId);
}

/**
 * Withdraw a raised hand. Used both by a listener lowering their own hand and
 * by the host dismissing someone from the dashboard. No-op if not queued.
 */
export function lowerHand(room, socketId) {
  if (!room) return;
  room.queue = room.queue.filter((id) => id !== socketId);
}

/**
 * Host promotes one listener to speaker ("pass the mic", or "add a co-speaker"
 * — this never touches any other speaker). Removes them from the queue. Their
 * client re-enables its tracks when it sees the new role (webrtc.js effect D).
 */
export function grantFloor(room, socketId) {
  if (!room || room.mode !== MODES.MODERATED) return;
  const participant = room.participants[socketId];
  if (!participant || participant.role !== ROLES.LISTENER) return;
  setRole(room, socketId, ROLES.SPEAKER); // no-op for the host
  room.queue = room.queue.filter((id) => id !== socketId);
}

/**
 * Host sends one speaker back to listener. Their client silences its own tracks
 * on seeing the role change. The host is never a valid target (setRole guards
 * that too).
 */
export function revokeFloor(room, socketId) {
  if (!room || room.mode !== MODES.MODERATED) return;
  const participant = room.participants[socketId];
  if (!participant || participant.role !== ROLES.SPEAKER) return;
  setRole(room, socketId, ROLES.LISTENER);
  room.queue = room.queue.filter((id) => id !== socketId);
}

/**
 * Phase 7 — host re-orders the queue.
 *
 * `order` must be a permutation of the CURRENT queue: same ids, same count, no
 * duplicates. Anything else (a stale list, someone who just lowered their hand)
 * is rejected wholesale — the client will get a fresh snapshot and can retry.
 * Removing someone from the queue is `lowerHand`, not a short `order`.
 */
export function reorderQueue(room, order) {
  if (!room || !Array.isArray(order)) return;
  if (order.length !== room.queue.length) return;
  if (new Set(order).size !== order.length) return;
  const current = new Set(room.queue);
  if (!order.every((id) => current.has(id))) return;
  room.queue = [...order];
}

/**
 * Host clears the floor: every non-host speaker becomes a listener at once.
 * The queue is untouched — people waiting stay waiting.
 */
export function clearFloor(room) {
  if (!room || room.mode !== MODES.MODERATED) return;
  for (const [id, participant] of Object.entries(room.participants)) {
    if (id === room.hostId) continue;
    if (participant.role === ROLES.SPEAKER) {
      setRole(room, id, ROLES.LISTENER);
    }
  }
}

/**
 * Phase 6 — record whether a socket is currently talking.
 *
 * The client sends this only on a transition (see EVENTS.SPEAKING), so we only
 * ever add someone who isn't listed or remove someone who is. New talkers go on
 * the END of the list; `snapshot()` reads the last entry as the active speaker.
 *
 * Returns true if the list actually changed (so the caller can skip a
 * pointless broadcast when nothing moved).
 */
export function setSpeaking(room, socketId, on) {
  if (!room || !room.participants[socketId]) return false;
  const listed = room.speaking.includes(socketId);
  if (on && !listed) {
    room.speaking.push(socketId);
    return true;
  }
  if (!on && listed) {
    room.speaking = room.speaking.filter((id) => id !== socketId);
    return true;
  }
  return false;
}

/**
 * In-call chat (added after Phase 7). Append one message and keep only the most
 * recent CHAT_HISTORY, so a room's chat can't grow without bound. Messages are
 * plain data the server built; the client renders text with React's default
 * escaping.
 */
export function addChatMessage(room, message) {
  if (!room) return;
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY) {
    room.chat = room.chat.slice(-CHAT_HISTORY);
  }
}

/**
 * Screen sharing (added after in-call chat). Record that a socket is / isn't
 * sharing its screen, keyed by socketId -> its screen MediaStream id so every
 * client can pick the screen track out of that peer's inbound media. The media
 * itself is renegotiated peer-to-peer; this is just the room-wide "who".
 */
export function setSharing(room, socketId, on, streamId) {
  if (!room || !room.participants[socketId]) return;
  if (on && typeof streamId === 'string' && streamId) {
    room.sharing[socketId] = streamId;
  } else {
    delete room.sharing[socketId];
  }
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
    room.speaking = room.speaking.filter((id) => id !== socketId);
    delete room.sharing[socketId];

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
    speaking: [...room.speaking],
    // The elected active speaker: whoever started talking most recently and
    // hasn't stopped. null when the room is silent. (Phase 6)
    activeSpeakerId: room.speaking[room.speaking.length - 1] ?? null,
    // socketId -> screen MediaStream id, for everyone currently screen sharing.
    sharing: { ...room.sharing },
  };
}

// Test/debug helper — not used in the request path.
export function _reset() {
  rooms.clear();
}

export { rooms };
