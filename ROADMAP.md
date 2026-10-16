# Turnly — Roadmap

A moderated group video-call app. Google Meet base layer + host-authoritative
moderation on top. Everything about who may speak lives on the server; the client
never decides its own permissions.

**Where it stands (17 October 2026):** Phases 0–8 are done — Phase 8
(resilience & deploy) mostly, see [its checklist](#phase-8--resilience--deploy).
Turnly is live on Render: the website at <https://listen-2-pyrg.onrender.com>,
the server at <https://listen-1-wj2o.onrender.com>. Many features were added
beyond the original plan — see
[Beyond Phase 7](#beyond-phase-7--features-added-out-of-sequence) and
[Since going live](#since-going-live). What's still open is under
[Next up](#next-up). Source: <https://github.com/Dami-Programmer/Listen>.

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
when it becomes `listener` (re-enables on the way back). **The moment the room
flips to moderated, `webrtc.js` effect G resets mics to "the host has the
floor": the host's mic is unmuted, everyone else's is muted (a one-shot on the
transition — anyone can toggle after).** UI: a moderator gets an Open |
Moderated switch, non-moderators get a locked banner, listeners get a "listening
only" note instead of mic/camera buttons. "Keep a specific speaker
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
speakers can hold the floor at once**.

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
green glow on that one tile. Active-speaker glow works in open and moderated
mode.

**Silence rule removed (later).** It used to auto-revoke a moderated-room
speaker after 10 s of quiet and promote `queue[0]`. It was dropped as no longer
needed: a speaker now keeps the floor until they pass the mic or a moderator
revokes it.

> **Closed gap:** the `speaking` event is now checked on the server —
> `setSpeaking` ignores a listener claiming to talk, and the event is
> rate-limited (covered by a test in `server/test/rooms.test.js`).

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
  attachment budget (`CHAT_ATTACHMENT_BUDGET_BYTES` — oldest _file_ messages are
  evicted first, text/stickers stay). `maxHttpBufferSize` is raised 1 MB → 12 MB.
  Client: a 📎 button and Ctrl+V paste; images render inline (click to open),
  other files as a download chip.
  **Later:** the server now saves each file to R2 and the message carries a
  `/files/<id>` link instead of the data — see
  [Since going live](#since-going-live).
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
  has a single deterministic "caller" per pair — it uses the MDN _perfect
  negotiation_ pattern: both peers add their tracks, both may fire
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
  co-host's role — `setRole` deliberately no-ops for `room.hostId` _and_
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

### Pass the mic

**Goal:** a speaker can hand the floor on themselves, not just wait for a
moderator.

- `pass-mic` (no payload) — for a plain **speaker** in a **moderated** room
  (host / co-host hold the room, not "the mic", so they don't get it, and it's a
  no-op in open mode). Drops the caller to listener and promotes `room.queue[0]`
  if a hand is up; otherwise they just step down.
- `passFloor(room, socketId)` in `rooms.js` is the implementation.
- Client: a **🎤 Pass the mic** button in a speaker's controls row.

### Open-call UI redesign

The in-call screen was rebuilt to a supplied design — **light theme** (Plus
Jakarta Sans), a floating white shell:

- Top bar: a "meeting name / hosted by" pill; when someone's knocking, a
  join-request notification pill on the right with round ✕ (deny) / ✓ (admit).
- Left: one big tile (your camera, or a screen when anyone presents) with a
  frosted mic / camera / leave bar overlaid and a **You** pill; below it a
  horizontal thumbnail strip of everyone else with a mic badge + name on each,
  and a `›` scroll button.
- Right: a **Room Chat / Participant** tabbed panel. `<ChatPanel>` lost its card
  wrapper (the panel provides the header); stickers + file attach moved behind
  the emoji tray so the composer is just `emoji · paperclip · input · send`.
- New `mic-state {on}` event + `room.mics` in the snapshot, so tiles can show a
  real per-person mute badge (it wasn't broadcast before).
- Moderator controls kept: the mode/lock strip sits under the top bar, the
  raised-hands dashboard above the stage, per-person actions in the Participant
  tab.

### Mobile view

**Goal:** a phone-first lobby and call screen, from the mobile designs.

- `useIsMobile` (≤560px) switches the lobby (`PreJoin`) and the call
  (`MobileCall.jsx`) to their phone layouts; desktop is unchanged.
- The room now has a **title** (`room.title`, set by whoever creates it, in
  every snapshot); the mobile host must name the meeting before joining.
- Call screen: spotlight / grid (columns by headcount), the chat feed, people
  sheet with every moderator action, invite pop-up, long-press device pickers,
  edit/delete your own messages, photos and files, leave confirmation.
- Presenting from a phone: photos or a PDF on a canvas
  (`canvas.captureStream`) sent through the screen-share path
  (`useCall.presentStream`), since phones have no `getDisplayMedia`.
- Floating video: `useVideoPip` (pop-out button, double-tap full screen,
  Chrome's auto action). iPhone Safari refuses PiP for live call video.
- iPhone layout: `viewport-fit=cover` and the visual viewport keep the bar
  clear of Safari's toolbar and the keyboard.

### Since going live

Built after the app went live, in order (each is a commit — `git log`):

- **Pre-join lobby & devices** — camera / mic preview and pickers, avatars,
  invite links and meeting codes, light / dark theme, in-app confirm dialog,
  creator profile card, floating mini-call.
- **Reconnect & rejoin** — a dropped connection keeps your seat for a while
  ("Reconnecting…"); leaving on purpose gives a minute to rejoin with your old
  role (`markAway` / `rekey` / `createPass` / `usePass` in `rooms.js`).
  Server hardened with per-event rate limits.
- **Phone extras** — control dial, step-by-step tour, "Are you still there?",
  floating video on iPhone.
- **Bigger calls** — Cloudflare's SFU when configured, with simulcast cameras.
- **Recording** — saved to Cloudflare R2, watchable for a day.
- **Turnly** — renamed from Listen, new logo (twice), landing page with live
  demos (a pretend server running the real meeting rules in the browser —
  `client/src/demo/`), AI-generated demo people.
- **Meeting tools** — breakout rooms, polls, Q&A, reactions, scheduled
  meetings, permanent room names (`names.js`), meeting report, strong noise
  reduction.
- **Chat moderation** — moderators delete any message and mute / unmute one
  person's chat (`CHAT_DELETE`, `CHAT_MUTE`); kept across reconnects, rejoins
  and breakouts.
- **Chat files in storage** — attachments go to R2 (`server/src/chatFiles.js`)
  behind a private link, deleted on unsend, when the room closes, and within a
  day — no longer held in the server's memory.
- **Live captions** — each speaker's own browser turns speech into text
  (Chrome / Edge / Safari speech recognition), shown to everyone who switched
  captions on; "Captions on" for all while anyone does. Phones show captions
  but don't transcribe. Never in the demo (it would use the visitor's real
  mic). `client/src/captions.js`, `CAPTION*` events.
- **Privacy & trust** — `/privacy` page (what's kept, for how long, services,
  rights under the Nigeria Data Protection Act, short terms of use).
- **Quality** — error screen (`ErrorBoundary.jsx`), browser errors and failed
  calls reported to the server log (`[client-error]`), 73 tests for the meeting
  rules and chat files (`npm test`), a GitHub check (lint + tests + build) on
  every push, Umami visitor counts (off until its website ID is set on Render).

### Deferred / not built

- A per-speaker "keep the floor" pin across the mode flip (only the co-host
  survives it today).

---

## Phase 8 — Resilience & deploy

**Goal:** works outside localhost. **Status: mostly done.**

- [x] TURN — Cloudflare's TURN relay (plus self-hosted TURN via env vars).
- [x] Reconnect handling — seats held on a drop, rejoin after leaving,
      self-healing video connections, device-permission errors, device pickers.
- [x] Deploy — website as a Render static site (with a `/* → /index.html`
      rewrite), server as a Render web service, HTTPS, R2 for storage. The
      server redeploys only when `server/`, `shared/` or the package files
      change (Render build filter).
- [x] Observability — `[client-error]` reports and server logs on Render;
      Umami for visits.
- [ ] Real-world test with friends on different networks — ongoing.
- [ ] **A server restart ends every live meeting** (all meetings live in its
      memory) — see [Next up](#next-up).

**Deliverable:** shareable URL that actually works. ✓

---

## Next up

1. **Survive server restarts.** Today any server deploy ends every meeting.
   First step: before pushing a server change, check a "live meetings" count
   on the server's health address and wait for zero. Then: the app rejoins
   its meeting by itself when the server comes back, instead of sending
   everyone out. The full fix is keeping meeting state outside the server's
   memory (e.g. Redis), only needed at a larger size.
2. **Move the server off Render's free plan** — it sleeps when idle, so the
   first person in waits about a minute.
3. **Keyboard shortcuts** — raise hand, mute, pass the mic.
4. **Captions on phones** — only once phones can transcribe without breaking
   the call's audio.

---

## Known constraints

- Mesh WebRTC scales to ~5-6 video participants. Larger rooms now go through
  Cloudflare's SFU when it's configured (one upload per track). Cameras are
  simulcast (full / half / quarter size): each viewer gets the size that fits
  how big that person is on their screen, one size smaller while their
  connection is losing packets.
- Everything host-authoritative lives on the server; the client never decides its
  own permissions.
- **Single process, all in memory.** One Node process holds every room in a
  `Map`; a restart drops every call. No horizontal scale (would need Redis + the
  Socket.IO adapter). Chat and chat history are in that memory too; chat
  attachments now live in R2 storage (`chatFiles.js`), not in memory.

## Decisions (answers to the doc's open questions)

1. **Monorepo** — one folder, `/client` + `/server` + `/shared`.
2. **Location / name** — `Desktop/Listen`.
3. **Media** — audio _and_ video from Phase 2.
