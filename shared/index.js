// Constants shared by client and server.
// Both sides import from here so event names and enums can never drift apart.

// Socket.IO event names.
export const EVENTS = {
  // client -> server
  JOIN_ROOM: 'join-room',
  SET_MODE: 'set-mode',

  // Phase 5 — the speaker queue.
  //   RAISE_HAND / LOWER_HAND : a listener asks for / withdraws from the floor.
  //     LOWER_HAND may also carry { targetId } when the HOST dismisses someone
  //     else's raised hand from the dashboard.
  //   GRANT_FLOOR / REVOKE_FLOOR : host promotes one listener to speaker /
  //     sends one speaker back to listener. Payload: { targetId }.
  //   CLEAR_FLOOR : host sends every non-host speaker back to listener at once.
  RAISE_HAND: 'raise-hand',
  LOWER_HAND: 'lower-hand',
  GRANT_FLOOR: 'grant-floor',
  REVOKE_FLOOR: 'revoke-floor',
  CLEAR_FLOOR: 'clear-floor',

  // Phase 6 — active-speaker detection.
  // Each client watches its OWN mic level (Web Audio) and sends this only when
  // the boolean flips: { speaking: true } when it starts talking, then
  // { speaking: false } a beat after it stops. No payload beyond that flag —
  // the server times the silence and elects the active speaker itself.
  SPEAKING: 'speaking',

  // Phase 7 — full host moderation controls.
  //   FORCE_MUTE : host -> server -> ONE target. The server can't mute anyone
  //     (media is peer-to-peer), so it just asks that client to disable its own
  //     mic track. Payload host->server: { targetId }. Server->target: no payload.
  //     The target may unmute themselves again afterwards.
  //   REMOVE_PARTICIPANT : host -> server. Kick { targetId } from the call — the
  //     server tells them (REMOVED) then drops their socket.
  //   REMOVED : server -> the kicked client, just before its socket is closed,
  //     so the UI can say why instead of showing a reconnect spinner.
  //   REORDER_QUEUE : host -> server: { order: [socketId, ...] } — a reordering
  //     of exactly the people already queued (used for move-up / move-down and,
  //     later, drag-and-drop). Dropping an id is done via LOWER_HAND instead.
  FORCE_MUTE: 'force-mute',
  REMOVE_PARTICIPANT: 'remove-participant',
  REMOVED: 'removed',
  REORDER_QUEUE: 'reorder-queue',

  // In-call text chat (added after Phase 7). Independent of the speaker floor —
  // everyone in the room can post, including listeners.
  //   CHAT_SEND    : client -> server { text, kind }. kind is 'text' (default)
  //     or 'sticker' (then text must be one of STICKERS). The server trims,
  //     length-caps, names and timestamps it.
  //   CHAT_MESSAGE : server -> everyone in the room, one stored message:
  //     { id, from, name, text, kind: 'text'|'sticker', ts }
  //   Recent history (last 100) rides along in the join-room ack as `chat`.
  //   CHAT_TYPING : the iMessage-style "someone is typing" ping. Client -> server
  //     { typing: bool } while the composer has focus + content; server relays
  //     { id, name, typing } to everyone else. Ephemeral — never stored, never in
  //     room-state. Receivers expire a typer after a few seconds in case the
  //     "false" is lost.
  CHAT_SEND: 'chat-send',
  CHAT_MESSAGE: 'chat-message',
  CHAT_TYPING: 'chat-typing',

  // WebRTC signaling relay (Phase 2).
  // One event carries every kind of negotiation message between two peers:
  // an SDP offer, an SDP answer, or an ICE candidate. The server doesn't look
  // inside the payload — it just forwards it to the target socket. Using a
  // single event (instead of separate offer/answer/ice events) keeps the relay
  // to one handler and matches the "perfect negotiation" pattern on the client,
  // which treats offers and answers almost identically.
  //
  // Payload shape (client <-> server):
  //   { targetId, description }  -> an RTCSessionDescription (offer or answer)
  //   { targetId, candidate }    -> an RTCIceCandidate
  // The server adds `from` (the sender's socket id) before relaying.
  RTC_SIGNAL: 'rtc-signal',

  // server -> client
  ROOM_STATE: 'room-state', // full snapshot on every change
  ERROR: 'room-error',
};

// A room is either a free-for-all or locked down by the host.
export const MODES = {
  OPEN: 'open',
  MODERATED: 'moderated',
};

// Every participant has exactly one role.
export const ROLES = {
  HOST: 'host',
  SPEAKER: 'speaker',
  LISTENER: 'listener',
};

// The sticker set for in-call chat. The server checks a 'sticker' message's
// text against this exact list, so the picker and the validation can never
// drift apart. Plain emoji so there are no image assets to host or licence.
export const STICKERS = [
  '🎉',
  '👍',
  '😂',
  '🔥',
  '💯',
  '🙌',
  '👀',
  '🤯',
  '❤️',
  '😴',
  '🤝',
  '🏆',
  '👏',
  '🚀',
  '🥳',
  '😎',
];
