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

  // PASS_MIC : a speaker (moderated mode) voluntarily gives up the floor — the
  //   first raised hand becomes the next speaker, or, if no hand is up, the
  //   passer simply drops to listener. Same effect as the silence rule, on
  //   demand. No payload.
  PASS_MIC: 'pass-mic',

  // MIC_STATE { on } : each client reports whether its own mic is live, so
  //   everyone else can show "is muted" on that person's tile. The server keeps
  //   `room.mics` (socketId -> bool) and includes it in every snapshot.
  //   (Needed because audio flows browser-to-browser: the server never hears
  //   the mic, so it only knows what each client tells it.)
  MIC_STATE: 'mic-state',

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

  // Co-host (added after screen sharing). HOST-ONLY events.
  //   PROMOTE_COHOST { targetId } : make one participant a co-host — they get
  //     every moderator power the host has (mode toggle, grant/revoke/clear,
  //     force-mute, remove, reorder), but can't touch the host and can't
  //     appoint/drop a co-host. At most one co-host per room; promoting a new
  //     one replaces the old.
  //   DEMOTE_COHOST { targetId } : drop the co-host back to a normal
  //     participant for the current mode (listener when moderated, speaker when
  //     open). The host can do this at any time.
  PROMOTE_COHOST: 'promote-cohost',
  DEMOTE_COHOST: 'demote-cohost',

  // Waiting room (added after co-host). A locked room holds newcomers until a
  // moderator lets them in. New rooms start locked; the first joiner bypasses.
  //   ADMIT / DENY { socketId } : moderator-only — let one waiter in / turn
  //     them away.
  //   SET_LOCK { locked } : moderator-only — unlocking also admits everyone
  //     currently waiting.
  //   ADMITTED : server -> a waiter, with the same payload as a join ack
  //     ({ selfId, state, chat }).
  //   DENIED : server -> a waiter who was turned away.
  ADMIT: 'admit',
  DENY: 'deny',
  SET_LOCK: 'set-lock',
  ADMITTED: 'admitted',
  DENIED: 'denied',

  // In-call text chat (added after Phase 7). Independent of the speaker floor —
  // everyone in the room can post, including listeners.
  //   CHAT_SEND    : client -> server { text, kind, file }.
  //     - kind 'text' (default): the server trims + length-caps `text`.
  //     - kind 'sticker': `text` must be one of STICKERS.
  //     - kind 'file': `file` is { name, type, size, url } where `url` is a
  //       data: URL. Images are downscaled client-side; the server caps the
  //       decoded size at CHAT_FILE_MAX_BYTES and keeps a per-room byte budget.
  //   CHAT_MESSAGE : server -> everyone in the room, one stored message:
  //     { id, from, name, ts, kind, text? , file? }
  //   Recent history (last 100, within the byte budget) rides along in the
  //   join-room ack as `chat`.
  //   CHAT_TYPING : the iMessage-style "someone is typing" ping. Client -> server
  //     { typing: bool } while the composer has focus + content; server relays
  //     { id, name, typing } to everyone else. Ephemeral — never stored, never in
  //     room-state. Receivers expire a typer after a few seconds in case the
  //     "false" is lost.
  CHAT_SEND: 'chat-send',
  CHAT_MESSAGE: 'chat-message',
  CHAT_TYPING: 'chat-typing',

  // Edit / unsend your OWN chat message (any mode, any role — listeners too).
  // The server checks the requester is the message's sender; nobody can edit
  // or unsend someone else's message.
  //   CHAT_EDIT     : client -> server { id, text }. Text messages only.
  //   CHAT_EDITED   : server -> everyone { id, text, editedAt }.
  //   CHAT_UNSEND   : client -> server { id }. Any kind (text/sticker/file).
  //   CHAT_UNSENT   : server -> everyone { id } — drop it from the chat.
  // Both also update the stored history, so late joiners only ever see the
  // current version (and never an unsent message).
  CHAT_EDIT: 'chat-edit',
  CHAT_EDITED: 'chat-edited',
  CHAT_UNSEND: 'chat-unsend',
  CHAT_UNSENT: 'chat-unsent',

  // Screen sharing (added after in-call chat). Google-Meet-style: only ONE
  // person presents at a time. The media itself is renegotiated peer-to-peer
  // (perfect negotiation in webrtc.js); this event only tells the room WHO is
  // sharing and WHICH inbound stream is the screen.
  //   SCREEN_SHARE : client -> server { on, streamId }. `on:true` carries the
  //     MediaStream id so every client can pick the screen track out of that
  //     peer's inbound media; `on:false` stops. The server keeps
  //     `room.sharing` (socketId -> streamId, at most one entry) and puts it
  //     in every snapshot. Starting while someone else is presenting bumps
  //     them — the server drops their entry and fires SCREEN_SHARE_STOPPED at
  //     that one socket so its client actually ends the capture.
  //   SCREEN_SHARE_STOPPED : server -> a bumped presenter, no payload.
  SCREEN_SHARE: 'screen-share',
  SCREEN_SHARE_STOPPED: 'screen-share-stopped',

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
//   host     — created the room / promoted on host leave. Full control. One only.
//   cohost   — appointed by the host; same moderator powers, but can't touch the
//              host or appoint/drop a co-host. Zero or one per room.
//   speaker  — cleared to talk (everyone in open mode; granted the floor in
//              moderated mode).
//   listener — moderated mode, not cleared to talk; client silences its tracks.
export const ROLES = {
  HOST: 'host',
  COHOST: 'cohost',
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

// Chat attachments (added after the waiting room). Files travel as data: URLs
// over Socket.IO — no file storage, matching the app's in-memory model. Images
// are downscaled client-side first, so this cap mostly bites non-image files.
export const CHAT_FILE_MAX_BYTES = 5 * 1024 * 1024;

// Per-room ceiling on the bytes held in the chat ring buffer for attachments.
// Once exceeded, the oldest file messages are dropped (text stays).
export const CHAT_ATTACHMENT_BUDGET_BYTES = 40 * 1024 * 1024;

// Profile pictures, picked in the pre-join lobby. An avatar is either an
// uploaded photo (downscaled client-side to a small JPEG data: URL) or a
// character image found by name search. It rides in every room-state snapshot,
// so uploads are kept tiny and search results may only point at the two image
// CDNs the lobby searches — no arbitrary third-party URLs on other screens.
export const AVATAR_SIZE_PX = 128;
export const AVATAR_MAX_CHARS = 40 * 1024;
export const AVATAR_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org', 'cdn.myanimelist.net'];

// Returns the avatar if it's acceptable, otherwise null.
export function cleanAvatar(avatar) {
  if (typeof avatar !== 'string' || !avatar || avatar.length > AVATAR_MAX_CHARS) return null;
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) return avatar;
  try {
    const url = new URL(avatar);
    return url.protocol === 'https:' && AVATAR_HOSTS.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}
