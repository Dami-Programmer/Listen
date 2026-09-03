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

## Phase 2 — Basic multi-party call (the "Google Meet" base layer)

**Goal:** friends can see and hear each other. No moderation yet.

- Join screen: room ID + name -> in-call view.
- `getUserMedia({ audio, video })`, local preview tile.
- Mesh WebRTC: on user-joined, create an `RTCPeerConnection` per peer; exchange
  offer/answer/ICE over the Phase 1 signaling.
- Remote video tiles in a responsive grid.
- Local controls: mute mic, turn off camera, leave call.

**Deliverable:** 3-4 people in a working video/voice call. This alone is a usable app.

## Phase 3 — Roles foundation

**Goal:** the data model that moderation will sit on.

- Server participant shape: `{ id, name, role }` where role is `host | speaker | listener`.
- In open mode everyone behaves as a speaker; role is tracked but not enforced.
- Client renders from room-state: host badge, participant list, role labels.
- Host transfer logic when the host leaves.

**Deliverable:** UI clearly shows who's host; roles visible but nothing restricted yet.

## Phase 4 — Moderator mode toggle

**Goal:** the host-only on/off switch.

- `set-mode {mode}` event — server rejects it unless `socket.id === room.hostId`.
- Mode -> moderated: every non-host becomes listener (except anyone the host is
  actively keeping as speaker); each client, on seeing its role change to listener,
  disables its own outbound mic/camera tracks.
- Mode -> open: everyone back to speaker, tracks re-enabled.
- UI: big host-only toggle; everyone else sees a "Moderated" banner.

**Deliverable:** host flips the room between free-for-all and locked-down.

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

## Phase 6 — Active-speaker & automated silence detection

**Goal:** the room reacts on its own.

- Each client runs a Web Audio `AnalyserNode` on its own mic -> emits throttled
  `speaking: true/false`.
- Server highlights the active speaker for everyone (glow on the tile).
- Silence rule (moderated only): speaker quiet for 5s -> server revokes their
  floor and auto-promotes `queue[0]`.
- Host is exempt — the silence timer never arms for the host.

**Deliverable:** in moderated mode, idle speakers are automatically cycled out.

## Phase 7 — Full host moderation controls

**Goal:** host has complete authority.

- Force-mute a participant (cooperative: server tells that client to disable its track).
- Remove a participant from the call.
- Remove / reorder / replace people in the queue.
- Revoke floor mid-speech, hand off directly to a specific person.
- Confirmation prompts on destructive actions.

**Deliverable:** polished host dashboard; host can fully run the room.

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
