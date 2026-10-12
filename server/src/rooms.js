// Phase 1 + 3 + 4 + 5 + 6: in-memory room registry.
// Single source of truth for who is in a room and who may speak.
// No persistence — everything lives in this module's `rooms` map and is gone
// when the process restarts. The client never decides its own state; it only
// renders the snapshots this file produces.
//
// Roles (Phase 3): every participant has exactly one — host | speaker | listener.
//   - open mode      -> every non-host is a speaker
//   - moderated mode -> every non-host is a listener (Phase 4)
// Roles are DATA here. A client that sees its own role become 'listener'
// silences its outbound tracks; in a peer-to-peer (mesh) call that's all there
// is. Through Cloudflare's SFU the server also enforces it (see maySend, and
// enforceMedia in index.js). `setRole` below is the single place any role
// changes, so Phases 4-7 never poke `participant.role` directly.

import { randomUUID } from 'node:crypto';
import {
  CHAT_ATTACHMENT_BUDGET_BYTES,
  MODES,
  REJOIN_WINDOW_MS,
  ROLES,
  cleanAvatar,
} from '@listen/shared';
import { sfuEnabled } from './sfu.js';

/**
 * roomId -> {
 *   hostId: string | null,
 *   cohostId: string | null,   // one appointed co-host, or null
 *   locked: boolean,           // true => newcomers must be admitted by a moderator
 *   waiting: { [socketId]: { id, name, since } },  // people knocking to get in
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
 *   mics: object         // socketId -> bool, whether that person's mic is live
 *                        // (each client reports its own; see setMic)
 *   cams: object         // socketId -> bool, whether that person's camera is on
 *   tickets: object      // socketId -> secret rejoin ticket (see EVENTS.RESUME).
 *                        // NEVER put in a snapshot — it's what lets a dropped
 *                        // person take their seat back.
 *   away: object         // socketId -> when their connection dropped, for
 *                        // people whose seat is being held while they
 *                        // reconnect
 *   media: object        // Cloudflare SFU only (see sfu.js): socketId ->
 *                        //   { sessionId, tracks: { [kind]: { key, trackName, mid } } }
 *                        // — their Cloudflare connection and what they're
 *                        // sending on it. Snapshots show only each track's
 *                        // `key`; the rest stays on the server.
 * }
 */
const rooms = new Map();

// How many recent chat messages a room keeps so a late joiner has context.
const CHAT_HISTORY = 100;

// Display names come straight from the client: make sure it's a string and
// keep it short — it rides along in every room-state snapshot to everyone.
const NAME_MAX = 60;
function cleanName(name) {
  return (typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : '') || 'Guest';
}

function createRoom() {
  return {
    title: '', // meeting name typed by whoever created the room
    hostId: null,
    cohostId: null,
    locked: true, // a moderator admits newcomers (the first joiner bypasses)
    waiting: {},
    mode: MODES.OPEN,
    participants: {},
    queue: [],
    speaking: [],
    chat: [],
    sharing: {},
    mics: {},
    cams: {},
    tickets: {},
    away: {},
    media: {},
    recording: null, // { id, startedAt, recorderId, part } while recording
  };
}

export function getRoom(roomId) {
  return rooms.get(roomId) ?? null;
}

// Put a participant into a room. First joiner is host; everyone else matches
// the room's current mode (speaker when open, listener when moderated).
function attach(room, socketId, name, avatar) {
  const isFirst = Object.keys(room.participants).length === 0;
  if (isFirst) room.hostId = socketId;

  let role = ROLES.SPEAKER;
  if (isFirst) role = ROLES.HOST;
  else if (room.mode === MODES.MODERATED) role = ROLES.LISTENER;

  room.participants[socketId] = {
    id: socketId,
    name: cleanName(name),
    role,
    avatar: cleanAvatar(avatar),
  };
  // Assume the mic is live until the client tells us otherwise (it reports its
  // real state as soon as its microphone opens).
  room.mics[socketId] = true;
  room.cams[socketId] = true; // same for the camera
  // Their secret rejoin ticket, handed only to them (in the join / admit
  // payload) so they can get this seat back after a network drop.
  room.tickets[socketId] = randomUUID();
  return room.participants[socketId];
}

// The rejoin ticket for one participant (for the join / admit payload).
export function ticketOf(room, socketId) {
  return room?.tickets[socketId] ?? null;
}

/* --------------------------------------------------------------------------
 * Reconnecting after a network drop (see EVENTS.RESUME in @listen/shared).
 *
 * A dropped participant stays in `room.participants` — same role, same place
 * in the queue — but is listed in `room.away` so everyone's screen can show
 * "Reconnecting…". index.js gives them RECONNECT_GRACE_MS to come back; if
 * they don't, it removes them with removeParticipant as if they had left.
 * ---------------------------------------------------------------------- */

// Mark a participant as dropped. They can't be "the active speaker" while
// gone, so they leave the talking list (the glow moves on).
export function markAway(room, socketId) {
  if (!room?.participants[socketId]) return;
  room.away[socketId] = Date.now();
  room.speaking = room.speaking.filter((id) => id !== socketId);
}

export function isAway(room, socketId) {
  return Boolean(room?.away[socketId]);
}

// Which room + seat a rejoin ticket belongs to, or null if it's unknown
// (seat already given up, or the server restarted and forgot everything).
export function findTicket(ticket) {
  if (typeof ticket !== 'string' || !ticket) return null;
  for (const [roomId, room] of rooms) {
    for (const [socketId, t] of Object.entries(room.tickets)) {
      if (t === ticket && room.participants[socketId]) return { roomId, room, oldId: socketId };
    }
  }
  return null;
}

/**
 * Move a seat from the old (dropped) connection to the new one.
 *
 * Everything in the room is keyed by socket id, and a reconnect always gets a
 * NEW socket id — so every place the old id appears is rewritten to the new
 * one: the participant itself, host / co-host, the queue, who's presenting,
 * mic / camera state, the ticket, and the `from` on their chat messages (so
 * they can still edit / unsend them, and their bubbles stay on "their" side).
 */
export function rekey(room, oldId, newId) {
  const p = room?.participants[oldId];
  if (!p || oldId === newId) return;

  // Rebuild `participants` in the same order, so the list doesn't reshuffle
  // (insertion order also decides who inherits the host role).
  const next = {};
  for (const [id, value] of Object.entries(room.participants)) {
    if (id === oldId) next[newId] = { ...value, id: newId };
    else next[id] = value;
  }
  room.participants = next;

  if (room.hostId === oldId) room.hostId = newId;
  if (room.cohostId === oldId) room.cohostId = newId;
  if (room.recording?.recorderId === oldId) room.recording.recorderId = newId;
  room.queue = room.queue.map((id) => (id === oldId ? newId : id));
  room.speaking = room.speaking.filter((id) => id !== oldId);

  // Plain socketId -> value maps: move the value across.
  // (`media` too: their Cloudflare connection can outlive a Socket.IO drop,
  // so after a quick reconnect their video just carries on.)
  for (const map of [room.sharing, room.mics, room.cams, room.tickets, room.media]) {
    if (oldId in map) {
      map[newId] = map[oldId];
      delete map[oldId];
    }
  }
  delete room.away[oldId]; // they're back

  for (const m of room.chat) if (m.from === oldId) m.from = newId;
}

/* --------------------------------------------------------------------------
 * Rejoining after leaving on purpose (Google-Meet style "You left the
 * meeting — Rejoin").
 *
 * Pressing Leave takes you out of the room at once — everyone sees you go —
 * but for REJOIN_WINDOW_MS your ticket stays good as a "rejoin pass". Showing
 * it (EVENTS.RESUME) puts you straight back in: no knocking, even if the door
 * is locked, and with your old role back (see restoreRole).
 *
 * Passes live here, outside the rooms, so a pass still works if you were the
 * last one out and the room closed — rejoining reopens it with you as host.
 * ---------------------------------------------------------------------- */

const passes = new Map(); // ticket -> pass (see createPass)

/**
 * Write a rejoin pass for someone who is about to leave on purpose. Call it
 * BEFORE removeParticipant (which forgets their ticket and role), then set
 * `pass.heir` afterwards to whoever became host (see index.js).
 * Returns the pass, or null if they have no seat.
 */
export function createPass(room, roomId, socketId) {
  const p = room?.participants[socketId];
  const ticket = room?.tickets[socketId];
  if (!p || !ticket) return null;
  const pass = {
    roomId,
    title: room.title, // to reopen the room under the same name if it closed
    name: p.name,
    avatar: p.avatar,
    role: p.role, // what they had — restoreRole gives it back
    oldId: socketId, // to hand their chat messages back to them
    cohostBefore: room.cohostId, // was the co-host the one who takes over?
    heir: null, // filled in after they're removed: the new host
    timer: setTimeout(() => passes.delete(ticket), REJOIN_WINDOW_MS),
  };
  pass.timer.unref?.(); // never keep the server alive just for this
  passes.set(ticket, pass);
  return pass;
}

/**
 * Use a rejoin pass: put `socketId` back into the room with their old role.
 * One use only. Returns { roomId, room }, or null if there's no such pass
 * (never left, more than a minute ago, or the server restarted).
 */
export function usePass(ticket, socketId) {
  const pass = typeof ticket === 'string' ? passes.get(ticket) : null;
  if (!pass) return null;
  passes.delete(ticket);
  clearTimeout(pass.timer);

  let room = rooms.get(pass.roomId);
  if (!room) {
    // They were the last one out and the room closed — reopen it.
    room = createRoom();
    room.title = pass.title;
    rooms.set(pass.roomId, room);
  }
  // Straight into the room — no waiting-room knock, they were already in.
  attach(room, socketId, pass.name, pass.avatar);
  restoreRole(room, socketId, pass);
  for (const m of room.chat) if (m.from === pass.oldId) m.from = socketId;
  return { roomId: pass.roomId, room };
}

// Give a rejoiner back the role they had when they left.
function restoreRole(room, socketId, pass) {
  const me = room.participants[socketId];
  if (room.hostId === socketId) return; // the room was empty: they're host anyway

  if (pass.role === ROLES.HOST) {
    // Take the room back from whoever inherited it.
    const stand = room.hostId;
    room.hostId = socketId;
    me.role = ROLES.HOST;
    if (stand && room.participants[stand]) {
      if (stand === pass.heir && stand === pass.cohostBefore && !room.cohostId) {
        // They were the co-host before taking over — co-host again.
        room.cohostId = stand;
        room.participants[stand].role = ROLES.COHOST;
      } else {
        setRole(room, stand, normalRole(room)); // hostId moved, so this applies
      }
    }
  } else if (pass.role === ROLES.COHOST) {
    // Only one co-host at a time: if the host picked a new one meanwhile,
    // they keep it and the rejoiner comes back as a normal participant.
    if (!room.cohostId) {
      room.cohostId = socketId;
      me.role = ROLES.COHOST;
    }
  } else if (pass.role === ROLES.SPEAKER && room.mode === MODES.MODERATED) {
    setRole(room, socketId, ROLES.SPEAKER); // had the floor — gets it back
  }
}

/**
 * A client reports whether its own mic is currently live. The server can't
 * hear the audio itself (media is peer-to-peer), so this is the only way the
 * rest of the room learns someone muted.
 */
export function setMic(room, socketId, on) {
  if (room?.participants[socketId]) room.mics[socketId] = on === true;
}

// Same for the camera: whether that person's camera is on.
export function setCam(room, socketId, on) {
  if (room?.participants[socketId]) room.cams[socketId] = on === true;
}

/**
 * Add a participant to a room, creating the room if needed. Used for the first
 * joiner and for joins into an unlocked room; a locked room routes newcomers
 * through `addWaiting` / `admitWaiting` instead.
 * Returns the room.
 */
export function addParticipant(roomId, socketId, name, avatar, title) {
  let room = rooms.get(roomId);
  if (!room) {
    room = createRoom();
    // Only the creator names the meeting; later joiners can't rename it.
    room.title = String(title ?? '')
      .trim()
      .slice(0, 80);
    rooms.set(roomId, room);
  }
  attach(room, socketId, name, avatar);
  return room;
}

/* --------------------------------------------------------------------------
 * Waiting room (added after co-host).
 *
 * A locked room holds newcomers in `room.waiting` until a moderator admits or
 * denies them. Waiters are NOT in `room.participants` and NOT in the Socket.IO
 * room, so they see nothing — no room-state, no chat, no media. New rooms start
 * locked; the first joiner (who creates the room) always bypasses.
 * ---------------------------------------------------------------------- */

export function addWaiting(room, socketId, name, avatar) {
  if (!room || room.participants[socketId]) return;
  room.waiting[socketId] = {
    id: socketId,
    name: cleanName(name),
    avatar: cleanAvatar(avatar),
    since: Date.now(),
  };
}

// Move a waiter into the room. Returns the new participant, or null if they
// weren't actually waiting.
export function admitWaiting(room, socketId) {
  const w = room?.waiting?.[socketId];
  if (!w) return null;
  delete room.waiting[socketId];
  return attach(room, socketId, w.name, w.avatar);
}

export function denyWaiting(room, socketId) {
  if (room?.waiting) delete room.waiting[socketId];
}

export function setLock(room, locked) {
  if (room) room.locked = Boolean(locked);
}

// Drop a socket from whatever room's waiting list it's in. Returns that roomId
// (so the caller can re-broadcast) or null.
export function removeWaiting(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.waiting[socketId]) {
      delete room.waiting[socketId];
      return roomId;
    }
  }
  return null;
}

/**
 * Phase 3 — the ONE place a participant's role changes.
 * Validates the role and never touches the host or the co-host (whose roles
 * track room.hostId / room.cohostId). Phases 4-7 (set-mode, grant-floor,
 * revoke-floor, …) all go through here, so none of them can disturb a co-host —
 * only the dedicated promote/demote helpers below can.
 */
export function setRole(room, socketId, role) {
  const participant = room?.participants[socketId];
  if (!participant) return;
  if (!Object.values(ROLES).includes(role)) return;
  if (socketId === room.hostId || socketId === room.cohostId) return;
  participant.role = role;

  // A demoted speaker can't be "the active speaker" any more — drop them from
  // the talking list so the glow moves on immediately (Phase 6). And in a
  // moderated room only the host + speakers may screen share, so drop them from
  // `sharing` too (their client stops the media cooperatively). Covers
  // revoke-floor, clear-floor and the open -> moderated flip in one place.
  if (role === ROLES.LISTENER) {
    room.speaking = room.speaking.filter((id) => id !== socketId);
    delete room.sharing[socketId];
  }
}

/**
 * Phase 4 — flip the room between 'open' and 'moderated'.
 *
 *   open      -> every non-host becomes a speaker (free-for-all)
 *   moderated -> every non-host becomes a listener (host controls the mic)
 *
 * The host's and the co-host's roles never change (setRole no-ops for both).
 * A "kept speakers across the flip" set is still deferred; for now, moderated
 * demotes everyone else.
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
    setRole(room, id, nonHostRole); // no-ops for the host and the co-host
  }
}

// The role a former host/co-host settles into for the current mode.
function normalRole(room) {
  return room.mode === MODES.MODERATED ? ROLES.LISTENER : ROLES.SPEAKER;
}

/**
 * Co-host — the host hands full moderator power to one other participant.
 * At most one at a time: appointing a new one drops the old back to normal.
 * The role is assigned directly here (setRole deliberately refuses to touch a
 * co-host), same as host promotion in removeParticipant.
 */
export function promoteCohost(room, socketId) {
  const participant = room?.participants[socketId];
  if (!participant || socketId === room.hostId || socketId === room.cohostId) return;

  if (room.cohostId && room.participants[room.cohostId]) {
    const prev = room.cohostId;
    room.cohostId = null;
    setRole(room, prev, normalRole(room));
  }

  room.cohostId = socketId;
  participant.role = ROLES.COHOST;
  room.queue = room.queue.filter((id) => id !== socketId); // not waiting in line
}

/**
 * Drop the co-host back to a normal participant for the current mode (listener
 * when moderated, speaker when open). Host-only; usable any time.
 */
export function demoteCohost(room, socketId) {
  if (!room || room.cohostId !== socketId) return;
  room.cohostId = null;
  setRole(room, socketId, normalRole(room)); // cohostId is null now, so it applies
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
 * Hand the floor on: `socketId` (a speaker in a moderated room) drops to
 * listener, and the first raised hand — if any — is promoted in their place.
 * Used by the "pass the mic" button.
 *
 * Returns { passed, next } — `passed` is false when the caller wasn't a
 * speaker; `next` is the promoted socketId, or null when no hand was up.
 */
export function passFloor(room, socketId) {
  const participant = room?.participants?.[socketId];
  if (!room || room.mode !== MODES.MODERATED || participant?.role !== ROLES.SPEAKER) {
    return { passed: false, next: null };
  }
  revokeFloor(room, socketId);
  const next = room.queue[0] ?? null;
  if (next) grantFloor(room, next);
  return { passed: true, next };
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
  // A listener has no floor, so it can't be the active speaker — ignore a
  // hand-rolled client claiming otherwise (it may still say it stopped).
  if (on && room.participants[socketId].role === ROLES.LISTENER) return false;
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
 * Edit one of your own text messages in the stored history. Returns the
 * updated message, or null if it doesn't exist, isn't yours, or isn't text —
 * the caller turns null into an error. (Ownership is checked HERE, on the
 * server, because the client's "Edit" button alone proves nothing.)
 */
export function editChatMessage(room, socketId, id, text) {
  const msg = room?.chat.find((m) => m.id === id);
  if (!msg || msg.from !== socketId || msg.kind !== 'text') return null;
  msg.text = text;
  msg.editedAt = Date.now();
  return msg;
}

/**
 * Unsend (delete) one of your own messages from the stored history, so it's
 * gone for late joiners too. Returns true if something was removed.
 */
export function unsendChatMessage(room, socketId, id) {
  const msg = room?.chat.find((m) => m.id === id);
  if (!msg || msg.from !== socketId) return false;
  room.chat = room.chat.filter((m) => m.id !== id);
  return true;
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
  // Keep the bytes held for attachments bounded — drop the oldest file messages
  // (leaving text/stickers alone) until we're back under the budget.
  const bytes = (m) => m.file?.url?.length ?? 0;
  let total = room.chat.reduce((n, m) => n + bytes(m), 0);
  if (total <= CHAT_ATTACHMENT_BUDGET_BYTES) return;
  room.chat = room.chat.filter((m) => {
    if (total <= CHAT_ATTACHMENT_BUDGET_BYTES || !m.file) return true;
    total -= bytes(m);
    return false;
  });
}

/**
 * Screen sharing (added after in-call chat). Record that a socket is / isn't
 * sharing its screen, keyed by socketId -> its screen MediaStream id so every
 * client can pick the screen track out of that peer's inbound media. The media
 * itself is renegotiated peer-to-peer; this is just the room-wide "who".
 *
 * Google-Meet-style: at most one presenter. Starting a share while someone
 * else already has the floor bumps them — their entry is dropped here and the
 * caller (server/src/index.js) tells that one socket to actually stop
 * capturing.
 *
 * In a MODERATED room only the host + speakers may share — a listener's request
 * to start is ignored (they can always stop). Turning off is always allowed so
 * cleanup can't get stuck.
 *
 * Returns the bumped socketId, or null if no one was bumped.
 */
export function setSharing(room, socketId, on, streamId) {
  const participant = room?.participants[socketId];
  if (!participant) return null;
  if (on && typeof streamId === 'string' && streamId) {
    if (room.mode === MODES.MODERATED && participant.role === ROLES.LISTENER) return null;
    const bumped = Object.keys(room.sharing).find((id) => id !== socketId) ?? null;
    if (bumped) delete room.sharing[bumped];
    room.sharing[socketId] = streamId;
    return bumped;
  }
  delete room.sharing[socketId];
  return null;
}

/**
 * Remove a participant from whatever room they're in.
 * If the host left, promote the next participant (co-host first).
 * If the room is now empty but someone is waiting, admit the oldest waiter as
 * the new host so the room survives; otherwise delete it.
 *
 * Returns { roomId, room, admitted } — `room` is null when the room was
 * deleted, `admitted` is the socketId promoted from the waiting room (or null).
 * Returns null if the socket wasn't a participant anywhere.
 */
export function removeParticipant(socketId) {
  for (const [roomId, room] of rooms) {
    if (!room.participants[socketId]) continue;

    delete room.participants[socketId];
    room.queue = room.queue.filter((id) => id !== socketId);
    room.speaking = room.speaking.filter((id) => id !== socketId);
    delete room.sharing[socketId];
    delete room.mics[socketId]; // they've left — forget their mic state
    delete room.cams[socketId];
    delete room.tickets[socketId]; // their seat is gone — the ticket is useless now
    delete room.away[socketId];
    delete room.media[socketId]; // their tracks: everyone stops receiving them
    if (room.cohostId === socketId) room.cohostId = null;

    const remaining = Object.keys(room.participants);
    if (remaining.length === 0) {
      const waiters = Object.keys(room.waiting);
      if (waiters.length === 0) {
        rooms.delete(roomId);
        return { roomId, room: null, admitted: null };
      }
      // Keep the room alive: the oldest waiter comes in as the new host.
      const heir = waiters.sort((x, y) => room.waiting[x].since - room.waiting[y].since)[0];
      admitWaiting(room, heir); // participants is empty -> attach() makes them host
      return { roomId, room, admitted: heir };
    }

    if (room.hostId === socketId) {
      // The co-host is the natural successor; otherwise the next by insertion.
      const heir = room.cohostId && room.participants[room.cohostId] ? room.cohostId : remaining[0];
      if (room.cohostId === heir) room.cohostId = null;
      room.hostId = heir;
      room.participants[heir].role = ROLES.HOST;
    }

    return { roomId, room, admitted: null };
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
    title: room.title,
    hostId: room.hostId,
    cohostId: room.cohostId,
    locked: room.locked,
    // People knocking to get in — only moderators render the admit/deny UI.
    waiting: Object.values(room.waiting).map(({ id, name, avatar }) => ({ id, name, avatar })),
    mode: room.mode,
    participants: Object.values(room.participants),
    queue: [...room.queue],
    speaking: [...room.speaking],
    // The elected active speaker: whoever started talking most recently and
    // hasn't stopped. null when the room is silent. (Phase 6)
    activeSpeakerId: room.speaking[room.speaking.length - 1] ?? null,
    // socketId -> screen MediaStream id, for everyone currently screen sharing.
    sharing: { ...room.sharing },
    // socketId -> bool, whether that person's mic is live. Clients use this to
    // show "is muted" on anyone's tile, not just their own.
    mics: { ...room.mics },
    // socketId -> bool, whether that person's camera is on.
    cams: { ...room.cams },
    // socketIds of people whose connection dropped and who are reconnecting
    // (their tiles say "Reconnecting…"). The tickets themselves stay secret.
    away: Object.keys(room.away),
    // Cloudflare SFU: whether calls go through it, and socketId -> { kind:
    // key } for the tracks each person is sending (see EVENTS.SFU_PULL).
    // Only tracks they may still send (see maySend): never a listener's audio.
    // Recording: { id, startedAt, recorderId, part } while it's on, else null.
    // Everyone shows "● Recording"; `recorderId` is the browser recording it.
    recording: room.recording
      ? {
          id: room.recording.id,
          startedAt: room.recording.startedAt,
          recorderId: room.recording.recorderId,
          part: room.recording.part,
        }
      : null,
    sfu: sfuEnabled(),
    media: Object.fromEntries(
      Object.entries(room.media)
        .filter(([id]) => room.participants[id])
        .map(([id, { tracks }]) => [
          id,
          Object.fromEntries(
            Object.entries(tracks)
              .filter(([kind]) => maySend(room, id, kind))
              .map(([kind, t]) => [kind, t.key]),
          ),
        ]),
    ),
  };
}

/* --------------------------------------------------------------------------
 * Cloudflare SFU bookkeeping (see sfu.js and the SFU_* handlers in index.js).
 * ------------------------------------------------------------------------ */

/**
 * May this person send this kind of track right now? Listeners can't send
 * audio; only the room's current presenter can send a screen (and its sound).
 * Anyone may send their camera. Tracks that fail this are left out of
 * snapshots and cut off by the server (enforceMedia in index.js).
 */
export function maySend(room, socketId, kind) {
  const p = room?.participants[socketId];
  if (!p) return false;
  if (kind === 'audio') return p.role !== ROLES.LISTENER;
  if (kind === 'screen' || kind === 'screenAudio') return socketId in room.sharing;
  return kind === 'video';
}

/** The room a participant is in: { roomId, room }, or null. */
export function roomOf(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.participants[socketId]) return { roomId, room };
  }
  return null;
}

/** Whether someone is on a laptop / desktop (better at recording than a phone). */
export function setDevice(room, socketId, desktop) {
  const p = room?.participants[socketId];
  if (p) p.desktop = desktop === true;
}

/** Someone's Cloudflare connection + tracks, created on first use. */
export function mediaOf(room, socketId) {
  room.media[socketId] ??= { sessionId: null, tracks: {} };
  return room.media[socketId];
}

/** The track with this snapshot key: { ownerId, kind, sessionId, trackName }, or null. */
export function findTrack(room, key) {
  if (typeof key !== 'string') return null;
  for (const [ownerId, m] of Object.entries(room.media)) {
    for (const [kind, t] of Object.entries(m.tracks)) {
      if (t.key === key) return { ownerId, kind, sessionId: m.sessionId, trackName: t.trackName };
    }
  }
  return null;
}
