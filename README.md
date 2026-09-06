# Listen

Moderated group video-call app. See [ROADMAP.md](./ROADMAP.md) for the plan.

## Layout

```
Listen/
├── client/    React + Vite frontend
├── server/    Node + Express (+ Socket.IO from Phase 1) backend
├── shared/    constants imported by both sides (event names, role/mode enums)
├── .env       single config file (port + signaling URL)
└── package.json   npm workspaces + the "dev" script that runs both
```

## Requirements

- Node.js 20+ (tested on 22)
- npm 10+

## Setup

```bash
npm install
```

Run once from the `Listen/` folder. npm workspaces installs `client`, `server`,
and `shared` together and links `shared` into the other two.

## Run in development

```bash
npm run dev
```

- Client: http://localhost:5173
- Server health check: http://localhost:3001/health

The placeholder page fetches the health check, so if both are running you'll see
"server ok (phase 0)".

## Other scripts

| Command          | What it does                   |
| ---------------- | ------------------------------ |
| `npm run build`  | Production build of the client |
| `npm run lint`   | ESLint across the repo         |
| `npm run format` | Prettier-format the repo       |

## Current status

**Phase 7 complete.** Host-authoritative moderation on top of the Phase 2 call:

- **Phase 1–2:** server owns room state (`join-room` / `room-state` / host
  promotion); WebRTC negotiation relayed via one `rtc-signal` event; mesh
  video/voice with `getUserMedia`, one `RTCPeerConnection` per peer, responsive
  tile grid, mic / camera / leave controls.
- **Phase 3 (roles):** every participant is `host | speaker | listener`.
  `setRole` in `rooms.js` is the single place roles change. Participant list is
  sorted host-first with coloured role pills; each video tile shows its role.
- **Phase 4 (moderator toggle):** `set-mode {mode}` is rejected unless you're
  the host. Moderated → every non-host becomes a listener and their client
  silences its own mic/camera; open → everyone back to speaker, tracks
  re-enabled. Host sees an Open | Moderated switch; others see a locked banner;
  listeners see a "listening only" note instead of the mic/camera buttons.
- **Phase 5 (hand-raising & speaker queue):** listeners get a ✋ raise/lower
  toggle that adds them to `room.queue` (server-owned, oldest first) and shows
  their place in line. The host gets a "Raised hands" dashboard — **Grant**
  (listener → speaker, off the queue), **Dismiss** (drop from the queue),
  **Clear floor** (every speaker → listener), and a **Revoke** button on each
  speaker row. `grant-floor` never touches other speakers, so granting a second
  person is just "add a co-speaker". All floor changes route through `setRole`,
  and the client re-enables/silences its tracks purely off the new role.
- **Phase 6 (active speaker & silence rule):** every client watches its own mic
  with a Web Audio `AnalyserNode` and sends `speaking: true/false` only when it
  flips. The server elects `activeSpeakerId` (most recent talker) and the room
  draws a green glow on that tile. In a moderated room, a non-host speaker who
  goes quiet for 5 s is auto-revoked and `queue[0]` takes the floor. The host is
  never on that timer.

- **Phase 7 (full host controls):** the participants list gives the host, for
  every other person, **Grant** (hand the floor to one specific listener),
  **Revoke** (take it back, even mid-speech), **Mute** (relayed `force-mute` —
  the target's client disables its own mic; they can unmute again), and
  **Remove** (kick from the call — they get "the host removed you" and land on
  the join screen). The raised-hands dashboard adds ↑/↓ to reorder the queue.
  `window.confirm` gates Remove and Clear floor. Every action is re-checked
  server-side against `room.hostId`.
- **In-call chat:** everyone in the room (listeners too) can text the room while
  the call runs — `chat-send` → the server names/timestamps it, keeps the last
  100 per room, and broadcasts `chat-message`. There's an emoji tray and a
  sticker tray (large emoji stickers, no image assets). Recent history arrives
  in the join ack so late joiners catch up. A `chat-typing` relay drives the
  iMessage-style bouncing-dots "X is typing" row.

Test: open 3–4 tabs at http://localhost:5173/?room=demo, allow camera in each.
Talking in one tab glows that tile everywhere. As the host, flip to Moderated,
**Grant** a raised hand, then have that speaker stay silent — after ~5 s the
floor auto-passes to the next raised hand. **Mute** or **Remove** anyone from
the participants list. Type in the chat, drop an emoji or a sticker, and open a
fresh tab to confirm the last 100 messages replay on join. STUN only (localhost
/ same Wi-Fi); TURN is Phase 8.

Next: Phase 8 (TURN server, reconnect handling, deploy).
