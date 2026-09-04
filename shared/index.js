// Constants shared by client and server.
// Both sides import from here so event names and enums can never drift apart.

// Socket.IO event names.
export const EVENTS = {
  // client -> server
  JOIN_ROOM: 'join-room',
  SET_MODE: 'set-mode',
  RAISE_HAND: 'raise-hand',
  LOWER_HAND: 'lower-hand',
  GRANT_FLOOR: 'grant-floor',
  REVOKE_FLOOR: 'revoke-floor',

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
