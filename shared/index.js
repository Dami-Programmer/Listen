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
  // { speaking: false } a beat after it stops. The server times the silence and
  // elects the active speaker itself.
  SPEAKING: 'speaking',

  // WebRTC signaling relay (Phase 2).
  // One event carries every kind of negotiation message between two peers:
  // an SDP offer, an SDP answer, or an ICE candidate. The server doesn't look
  // inside the payload — it just forwards it to the target socket.
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
