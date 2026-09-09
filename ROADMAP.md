# Listen — Roadmap

A moderated group video-call app. Google Meet base layer + host-authoritative
moderation on top. Everything about who may speak lives on the server; the client
never decides its own permissions.

**Where it stands:** Phases 0–7 are complete. A batch of features was then added
out of sequence — chat (with attachments, emoji, stickers, typing), screen
sharing, co-host, and a waiting room — all under
[Beyond Phase 7](#beyond-phase-7--features-added-out-of-sequence). **Phase 8
(resilience & deploy) is the only planned phase not started.** Source:
<https://github.com/Dami-Programmer/Listen>.

---

## Phase 0 — Foundation & decisions

**Goal:** clean repo, agreed scope, shared conventions.

- Monorepo: `/client` (React + Vite) and `/server` (Node + Express + Socket.IO),
  plus `/shared` for event-name constants and role/mode enums used by both sides.
- Tooling: ESLint + Prettier, a single `.env` for the signaling URL.
- v1 scope: rooms identified by an ID in the URL, no accounts, users just type a
  display name. No persistence, no database.
- This `ROADMAP.md` lives in the repo so we track progress.

**Deliverable:** `npm run dev` starts both; client shows a placeholder page.

## Phase 1 — Signaling server skeleton

**Goal:** server owns room state; no media yet.

- Express health route + Socket.IO.
- In-memory room registry: `rooms[roomId] = { hostId, mode: "open", participants: {}, queue: [] }`.
- Events: `join-room {roomId, name}` -> add participant, first joiner becomes host.
- Broadcast a full room-state snapshot on every change (single source of truth).
- `disconnect` -> remove participant; if host left, promote the next participant
  or close the room.

**Deliverable:** two browser tabs connect, server logs show both in the room, host assigned.

**Status: done.** `server/src/rooms.js` holds the registry; `server/src/index.js`
wires the Socket.IO handlers. Client has a join screen + live participant list.

## Phase 2 — Basic multi-party call (the "Google Meet" base layer)

**Goal:** friends can see and hear each other. No moderation yet.

- Join screen: room ID + name -> in-call view.
- `getUserMedia({ audio, video })`, local preview tile.
- Mesh WebRTC: on user-joined, create an `RTCPeerConnection` per peer; exchange
  offer/answer/ICE over the Phase 1 signaling.
- Remote video tiles in a responsive grid.
- Local controls: mute mic, turn off camera, leave call.

**Deliverable:** 3-4 people in a working video/voice call. This alone is a usable app.

**Status: done.** `client/src/webrtc.js` holds the `useCall` hook (getUserMedia,
one `RTCPeerConnection` per peer, offer/answer/ICE); `client/src/VideoTile.jsx`
binds a stream to a `<video>`; `App.jsx` splits into join screen + call view
with mic/camera/leave. Server relays peer negotiation via one `rtc-signal`
event (`server/src/index.js`). Peer discovery reuses the `room-state` snapshot;
the greater socket id in each pair sends the offer. STUN only — TURN is Phase 8.
(The one-offer-per-pair rule was later replaced by perfect negotiation — see
Screen sharing.)

## Phase 3 — Roles foundation

**Goal:** the data model that moderation will sit on.

- Server participant shape: `{ id, name, role }` where role is `host | speaker | listener`.
- In open mode everyone behaves as a speaker; role is tracked but not enforced.
- Client renders from room-state: host badge, participant list, role labels.
- Host transfer logic when the host leaves.

**Deliverable:** UI clearly shows who's host; roles visible but nothing restricted yet.

**Status: done.** Roles were already in the participant shape from Phase 1; this
phase added `setRole` in `rooms.js` as the single choke point for role changes
(everything routes through it), a host-first sorted participant list, and
coloured role pills in the list and on each video tile. A fourth role, `cohost`,
was added later (see Co-host).

## Phase 4 — Moderator mode toggle

**Goal:** the host-only on/off switch.

- `set-mode {mode}` event — server rejects it unless `socket.id === room.hostId`.
- Mode -> moderated: every non-host becomes listener (except anyone the host is
  actively keeping as speaker); each client, on seeing its role change to listener,
  disables its own outbound mic/camera tracks.
- Mode -> open: everyone back to speaker, tracks re-enabled.
- UI: big host-only toggle; everyone else sees a "Moderated" banner.

**Deliverable:** host flips the room between free-for-all and locked-down.

**Status: done.** `set-mode {mode}` in `server/src/index.js` is hard-rejected
unless the caller is a moderator (host or co-host — originally host-only);
`setMode` in `rooms.js` recomputes every non-moderator role (moderated →
listener, open → speaker) and someone joining a moderated room now enters as a
listener. Client: `useCall` watches my own role and silences my outbound tracks
when it becomes `listener` (re-enables on the way back). UI: a moderator gets an
Open | Moderated switch, non-moderators get a locked banner, listeners get a
"listening only" note instead of mic/camera buttons. "Keep a specific speaker
across the flip" is partly answered by the co-host (a co-host survives a mode
flip); a general per-speaker pin is still deferred.

## Phase 5 — Hand-raising & speaker queue

**Goal:** structured "pass the mic."

- `raise-hand` / `lower-hand` (listeners only, moderated only) -> server maintains
  `queue[]` in room-state.
- Host dashboard: list of raised hands with Grant / Dismiss.
- `grant-floor {target}` -> role becomes speaker, removed from queue, client
  re-enables tracks.
- `revoke-floor {target}` -> back to listener, tracks disabled.
- `clear-floor`, plus "add co-speaker" (host grants a second active speaker
  without revoking the first).

**Deliverable:** host runs a structured session — people request, host grants.

**Status: done.** `raise-hand` / `lower-hand` (listener, moderated only)
maintain `room.queue` in `rooms.js`; the moderator-only `grant-floor`,
`revoke-floor`, and `clear-floor` all route through `setRole`. `lower-hand`
accepts `{ targetId }` so a moderator can dismiss a hand. Any mode flip empties
the queue. Client: listeners get a ✋ raise/lower toggle showing their place in
line; a moderator gets a "Raised hands" dashboard (Grant / Dismiss per person,
Clear floor) plus a Revoke button on each speaker row. `webrtc.js` needed no
change — effect D already re-enables/silences tracks off the role. `grant-floor`
never touches other speakers, so it doubles as "add co-speaker" — **two or more
speakers can hold the floor at once** (in moderated mode the silence rule below
still cycles out whichever one goes quiet for 10 s).

## Phase 6 — Active-speaker & automated silence detection

**Goal:** the room reacts on its own.

- Each client runs a Web Audio `AnalyserNode` on its own mic -> emits throttled
  `speaking: true/false`.
- Server highlights the active speaker for everyone (glow on the tile).
- Silence rule (moderated only): speaker quiet for 10s -> server revokes their
  floor and auto-promotes `queue[0]`.
- Host is exempt — the silence timer never arms for the host.

**Deliverable:** in moderated mode, idle speakers are automatically cycled out.

**Status: done.** Each client runs a Web Audio `AnalyserNode` on its own mic
(`webrtc.js` effect E), computes RMS loudness, and emits `speaking: true/false`
only on the transition (rising edge immediately, falling edge after a 600 ms
hangover). `rooms.js` keeps `room.speaking` (socketIds in start order);
`snapshot` exposes `activeSpeakerId` = the last entry, and the client draws a
green glow on that one tile. Silence rule (`server/src/index.js`): a
`speaking: false` from a non-host speaker in a moderated room arms a 10 s timer
(`SILENCE_MS`); firing it calls `revokeFloor` + `grantFloor(queue[0])`. The timer is cleared on
`speaking: true`, grant, revoke, clear-floor, mode flip, disconnect, and
host-promotion. `armSilence` bails on any non-`speaker` role, so the host **and
the co-host** are exempt. Active-speaker glow works in open mode too; only the
silence enforcement is moderated-only.

> **Known gap:** the `speaking` event isn't role-checked server-side, so a
> hand-rolled client could fake the glow / dodge the silence timer. Cosmetic
> today; worth folding into Phase 8 hardening.

## Phase 7 — Full moderation controls

**Goal:** host has complete authority.

- Force-mute a participant (cooperative: server tells that client to disable its track).
- Remove a participant from the call.
- Remove / reorder / replace people in the queue.
- Revoke floor mid-speech, hand off directly to a specific person.
- Confirmation prompts on destructive actions.

**Deliverable:** polished host dashboard; host can fully run the room.

**Status: done.** Three new moderator-only events in `server/src/index.js`, each
re-checked with `requireModeratorRoom` + a `requireTarget` guard (a real member
of my room, never myself, **never the host**):

- `force-mute {targetId}` — media is peer-to-peer so the server can't mute
  anyone; it relays `FORCE_MUTE` to the target and `webrtc.js` effect F disables
  that client's own mic track (`micOn` -> false). Cooperative — they can unmute.
  Works in open mode too.
- `remove-participant {targetId}` — emits `REMOVED` to the target then
  `socket.disconnect(true)`; the existing `disconnect` handler does the room
  cleanup + broadcast, and a server-closed socket doesn't auto-reconnect, so the
  client lands back on the join screen with "The host removed you".
- `reorder-queue {order}` — `reorderQueue` in `rooms.js` accepts only a
  permutation of the current queue (dropping someone is still `lower-hand`).

Client (`App.jsx`): the raised-hands dashboard gained ↑/↓ reorder arrows; the
participants list gained per-person **Grant** (hand the floor to one specific
listener), **Revoke** (take it back mid-speech), **Mute**, and **Remove**.
`window.confirm` gates Remove and Clear floor. Revoke-floor already worked
regardless of speaking state, so "revoke mid-speech" needed no server change.

---

## Beyond Phase 7 — features added out of sequence

Everything below was built after Phase 7, in this order: chat → screen sharing →
co-host → waiting room → chat attachments. Each is done.

### In-call chat, emoji, stickers, attachments, typing

**Goal:** people can text the room during the call — with emoji, stickers,
photo/file attachments, and a typing indicator.

- `chat-send {text, kind, file}` — anyone in the room (listeners included; chat
  is independent of the speaker floor). Server trims, caps text at 2000 chars,
  names + timestamps it, keeps the last 100 per room (`room.chat` in
  `rooms.js`), and fans it out on `chat-message` — never in room-state, which
  would resend the whole log on every join.
- `kind: 'sticker'` — `text` must be one of `STICKERS` in `shared/index.js`
  (plain emoji, so no image assets to host). The picker reads the same list.
- `kind: 'file'` — `file: { name, type, size, url }` where `url` is a `data:`
  URL (no file storage, matching the in-memory model). Raster images
  (jpeg/png/webp) are downscaled client-side to ≤1600 px JPEG q0.82 before
  sending, so a phone photo doesn't blow the cap. The server requires a `data:`
  URL, caps the decoded size at `CHAT_FILE_MAX_BYTES` (5 MB), strips path
  separators / control chars from the filename, and keeps a per-room 40 MB
  attachment budget (`CHAT_ATTACHMENT_BUDGET_BYTES` — oldest *file* messages are
  evicted first, text/stickers stay). `maxHttpBufferSize` is raised 1 MB → 12 MB.
  Client: a 📎 button and Ctrl+V paste; images render inline (click to open),
  other files as a download chip.
- Recent history (within the byte budget) rides along in the `join-room` ack as
  `chat`, so a late joiner has context.
- `chat-typing {typing}` — the iMessage bouncing-dots indicator. The composer
  sends `true` on the first keystroke, re-sends at most every 3 s while typing
  continues, and `false` after 3.5 s idle / on send / on blur / on unmount. The
  server relays `{id, name, typing}` to everyone else (and a `false` when a
  typer disconnects); receivers expire a stale typer after 5 s. Never stored.
- Client: `<ChatPanel>` — message log (own messages right-aligned), an emoji
  tray (curated ~48, inserts into the input) and a sticker tray (sends
  immediately, rendered large). Chat state lives in `<App/>`; React escapes all
  message text on render.

### Screen sharing

**Goal:** in an open room anyone can share their screen; several at once. In a
moderated room only the host + speakers can.

- **The signaling layer became renegotiation-capable.** `webrtc.js` no longer
  has a single deterministic "caller" per pair — it uses the MDN *perfect
  negotiation* pattern: both peers add their tracks, both may fire
  `onnegotiationneeded`, and glare is resolved by a deterministic polite /
  impolite role (lower socket id is polite). This is what makes adding a screen
  track mid-call work.
- `getDisplayMedia()` → the screen tracks are `addTrack`ed to every peer
  connection (and to any connection opened later, while still sharing). Stopping
  removes them and renegotiates. The browser's own "Stop sharing" bar is wired
  up too.
- `screen-share {on, streamId}` — the server keeps `room.sharing`
  (socketId → the screen MediaStream's id) and puts it in every snapshot, so
  each client can pick the screen track out of a peer's inbound media and label
  the tile. Cleared on stop and on disconnect.
- **Role gating.** `setSharing` ignores a listener's start request, and
  `setRole` drops a demoted speaker from `room.sharing` (so flipping to
  moderated / a revoke / clear-floor also stops their share). Client mirror: no
  Share button for a listener, and `webrtc.js` stops the media cooperatively
  when my role becomes `listener`.
- Client: **one media stage, Google-Meet style.** No one presenting → the
  cameras are a responsive grid. Someone presenting → the screen(s) fill the
  main area (16:9, let-boxed, one full-width or two side by side) and every
  camera drops into a right-hand filmstrip (a horizontal scroller on narrow
  screens). A **Share screen / Stop sharing** button in the controls (and next
  to a listener's raise-hand). Needs HTTPS off localhost (Phase 8).

### Co-host

**Goal:** the host appoints one other participant who gets every moderator
power, and can drop them back to a listener at any time.

- New role `cohost` in `shared/index.js`, plus `promote-cohost` / `demote-cohost`
  events (**host-only** — a co-host can't appoint or drop a co-host).
- `rooms.js`: `promoteCohost` / `demoteCohost` are the only paths that touch a
  co-host's role — `setRole` deliberately no-ops for `room.hostId` *and*
  `room.cohostId`, so mode flips / grant / revoke / clear-floor / the silence
  rule can't disturb them. One co-host at a time; appointing a new one drops the
  old to normal-for-mode (`listener` when moderated, `speaker` when open).
- `server/src/index.js`: a `requireModeratorRoom` guard (host **or** co-host)
  replaces `requireHostRoom` on every Phase 4/5/7 control — set-mode, grant /
  revoke / clear-floor, dismiss-hand, force-mute, remove, reorder-queue.
  `requireTarget` also refuses `room.hostId`, so **nobody, not even a co-host,
  can mute or remove the host.**
- Host succession: when the host leaves, the co-host inherits the room
  (otherwise the next by insertion order), and `cohostId` clears.
- Client: a co-host sees the full moderator surface; the host's participant list
  gets **Make co-host** / **Remove co-host**; a distinct role pill.

### Waiting room

**Goal:** anyone joining needs a moderator to let them in.

- **Rooms start locked.** The first joiner (who creates the room) always
  bypasses. Everyone after that lands in `room.waiting` — NOT in
  `room.participants`, NOT in the Socket.IO room — so they get nothing (no
  room-state, no chat, no media signaling) until admitted.
- Server: `join-room` into a locked non-empty room acks `{ ok: true, waiting:
  true }`; `admit` / `deny` (moderator-only, `{ socketId }`) move a waiter in
  (server emits `admitted` with the full state) or turn them away (`denied`);
  `set-lock { locked }` toggles the lock — unlocking admits everyone currently
  waiting. Disconnecting from the lobby clears the entry. If a room empties
  while someone waits, the oldest waiter is admitted as the new host so the
  room survives. `rtc-signal` was also tightened to require the **sender** be a
  full participant.
- `snapshot` carries `locked` + `waiting` (`[{ id, name }]`).
- Client: a `<WaitingScreen>` ("waiting for the host to let you in…"); a
  moderator gets a **Door locked / Door open** toggle and a **Waiting to join**
  card with Admit / Deny per person.

### Deferred / not built

- **Per-speaker "pin"** — exempt a chosen speaker from the silence timer without
  giving them moderator powers (a lighter version of what the co-host does).
- **Chat moderation** — delete a message, mute someone's chat. Not built; would
  follow the Phase 7 pattern.
- Everything in Phase 8 below (reconnect handling especially).

---

## Phase 8 — Resilience & deploy

**Goal:** works outside localhost.

- TURN server (coturn or hosted) — STUN-only will fail for many home networks;
  this is required, not optional.
- Reconnect handling (a dropped socket currently bounces you to the join
  screen), ICE-failure recovery, device-permission error states, device pickers.
- Deploy: client to static hosting, server to a Node host with WebSocket support,
  TURN alongside, HTTPS (required for `getUserMedia` / `getDisplayMedia` off
  localhost).
- Observability: structured logs, error tracking, basic metrics.
- Real-world test with friends on different networks.

**Deliverable:** shareable URL that actually works.

---

## Known constraints

- Mesh WebRTC scales to ~5-6 video participants. Fine for friends. Larger rooms
  would need an SFU — a post-v1 rewrite of the media layer, so the signaling/role
  code is designed to not care how media is routed.
- Everything host-authoritative lives on the server; the client never decides its
  own permissions.
- **Single process, all in memory.** One Node process holds every room in a
  `Map`; a restart drops every call. No horizontal scale (would need Redis + the
  Socket.IO adapter). Chat, chat history, and attachments (bounded at 40 MB of
  file bytes per room) are all in that memory too.

## Decisions (answers to the doc's open questions)

1. **Monorepo** — one folder, `/client` + `/server` + `/shared`.
2. **Location / name** — `Desktop/Listen`.
3. **Media** — audio _and_ video from Phase 2.
