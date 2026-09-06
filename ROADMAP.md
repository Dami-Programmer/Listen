# Listen — Roadmap

A moderated group video-call app. Google Meet base layer + host-authoritative
moderation on top. Everything about who may speak lives on the server; the client
never decides its own permissions.

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

**Status: done.** Workspace wired up; the client placeholder fetches `/health`
and shows the shared enums.

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
event. Peer discovery reuses the `room-state` snapshot; the greater socket id in
each pair sends the offer. STUN only — TURN is Phase 8.

## Phase 3 — Roles foundation

**Goal:** the data model that moderation will sit on.

- Server participant shape: `{ id, name, role }` where role is `host | speaker | listener`.
- In open mode everyone behaves as a speaker; role is tracked but not enforced.
- Client renders from room-state: host badge, participant list, role labels.
- Host transfer logic when the host leaves.

**Deliverable:** UI clearly shows who's host; roles visible but nothing restricted yet.

**Status: done.** Roles were already in the participant shape from Phase 1; this
phase added `setRole` in `rooms.js` as the single choke point for role changes
(later phases all route through it), a host-first sorted participant list, and
coloured role pills in the list and on each video tile.

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
unless `socket.id === room.hostId`; `setMode` in `rooms.js` recomputes every
non-host role (moderated → listener, open → speaker) and someone joining a
moderated room now enters as a listener. Client: `useCall` watches my own role
and silences my outbound tracks (effect D) when it becomes `listener`. UI: host
gets an Open | Moderated switch, non-hosts get a locked banner, listeners get a
"listening only" note instead of mic/camera buttons.

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

**Status: done.** `raise-hand` / `lower-hand` (listener, moderated only) maintain
`room.queue` in `rooms.js`; the host-only `grant-floor`, `revoke-floor`, and
`clear-floor` all route through `setRole`. `lower-hand` accepts `{ targetId }`
so the host can dismiss a hand. Any mode flip empties the queue. Client:
listeners get a ✋ raise/lower toggle showing their place in line; the host gets
a "Raised hands" dashboard (Grant / Dismiss / Clear floor) plus a Revoke button
on each speaker row. `grant-floor` never touches other speakers, so it doubles
as "add co-speaker".

## Phase 6 — Active-speaker & automated silence detection

**Goal:** the room reacts on its own.

- Each client runs a Web Audio `AnalyserNode` on its own mic -> emits throttled
  `speaking: true/false`.
- Server highlights the active speaker for everyone (glow on the tile).
- Silence rule (moderated only): speaker quiet for 5s -> server revokes their
  floor and auto-promotes `queue[0]`.
- Host is exempt — the silence timer never arms for the host.

**Deliverable:** in moderated mode, idle speakers are automatically cycled out.

**Status: done.** Each client runs a Web Audio `AnalyserNode` on its own mic
(`webrtc.js` effect E), computes RMS loudness, and emits `speaking: true/false`
only on the transition (rising edge immediately, falling edge after a 600 ms
hangover). `rooms.js` keeps `room.speaking`; `snapshot` exposes
`activeSpeakerId` = the last entry, and the client draws a green glow on that
tile. Silence rule (`server/src/index.js`): a `speaking: false` from a non-host
speaker in a moderated room arms a 5 s timer; firing it calls `revokeFloor` +
`grantFloor(queue[0])`. The timer is cleared on speak / grant / revoke /
clear-floor / mode flip / disconnect / host-promotion. The host is exempt.

## Phase 7 — Full host moderation controls

**Goal:** host has complete authority.

- Force-mute a participant (cooperative: server tells that client to disable its track).
- Remove a participant from the call.
- Remove / reorder / replace people in the queue.
- Revoke floor mid-speech, hand off directly to a specific person.
- Confirmation prompts on destructive actions.

**Deliverable:** polished host dashboard; host can fully run the room.

**Status: done.** Three new host-only events in `server/src/index.js`, each
re-checked with `requireHostRoom` + a `requireTarget` guard (real member of my
room, never myself):

- `force-mute {targetId}` — media is peer-to-peer so the server can't mute
  anyone; it relays `FORCE_MUTE` to the target and `webrtc.js` effect F disables
  that client's own mic track. Cooperative — they can unmute. Works in open mode.
- `remove-participant {targetId}` — emits `REMOVED` to the target then
  `socket.disconnect(true)`; the existing `disconnect` handler does the cleanup,
  and a server-closed socket doesn't auto-reconnect, so the client lands on the
  join screen with "The host removed you".
- `reorder-queue {order}` — `reorderQueue` in `rooms.js` accepts only a
  permutation of the current queue (dropping someone is still `lower-hand`).

Client: the raised-hands dashboard gained ↑/↓ reorder arrows; the participants
list gained per-person **Grant** (hand the floor to one specific listener),
**Revoke** (take it back mid-speech), **Mute**, and **Remove**. `window.confirm`
gates Remove and Clear floor.

## In-call chat (added after Phase 7, out of sequence)

**Goal:** people can text the room during the call, with emoji and stickers.

- `chat-send {text, kind}` — anyone in the room (listeners included; chat is
  independent of the speaker floor). Server trims, caps text at 2000 chars,
  names + timestamps it, keeps the last 100 per room (`room.chat` in
  `rooms.js`), and fans it out on `chat-message` — never in room-state.
- `kind: 'sticker'` — `text` must be one of `STICKERS` in `shared/index.js`
  (plain emoji, so no image assets to host). The picker reads the same list.
- Recent history rides along in the `join-room` ack as `chat`.
- Client: `<ChatPanel>` — message log (own messages right-aligned), an emoji
  tray (curated ~48, inserts into the input) and a sticker tray (sends
  immediately, rendered large). Chat state lives in `<App/>`; React escapes all
  message text on render.

**Status: done.**

## Phase 8 — Resilience & deploy

**Goal:** works outside localhost.

- TURN server (coturn or hosted) — STUN-only will fail for many home networks;
  this is required, not optional.
- Reconnect handling, ICE-failure recovery, device-permission error states,
  device pickers.
- Deploy: client to static hosting, server to a Node host with WebSocket support,
  TURN alongside.
- Real-world test with friends on different networks.

**Deliverable:** shareable URL that actually works.

---

## Known constraints

- Mesh WebRTC scales to ~5-6 video participants. Fine for friends. Larger rooms
  would need an SFU — a post-v1 rewrite of the media layer, so the signaling/role
  code is designed to not care how media is routed.
- Everything host-authoritative lives on the server; the client never decides its
  own permissions.

## Decisions (answers to the doc's open questions)

1. **Monorepo** — one folder, `/client` + `/server` + `/shared`.
2. **Location / name** — `Desktop/Listen`.
3. **Media** — audio _and_ video from Phase 2.
