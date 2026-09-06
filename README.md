# Listen

Moderated group video-call app. See [ROADMAP.md](./ROADMAP.md) for the plan.

## Layout

```
Listen/
├── client/    React + Vite frontend
├── server/    Node + Express + Socket.IO backend
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

## Run in development

```bash
npm run dev
```

- Client: http://localhost:5173
- Server health check: http://localhost:3001/health

## Other scripts

| Command          | What it does                   |
| ---------------- | ------------------------------ |
| `npm run build`  | Production build of the client |
| `npm run lint`   | ESLint across the repo         |
| `npm run format` | Prettier-format the repo       |

## Current status

**Phase 7 complete.** Full host moderation controls, on top of Phases 2-6.

- Join screen → in-call view. `getUserMedia({ audio, video })`, local preview.
- One `RTCPeerConnection` per other participant; offer/answer/ICE relayed by the
  server over a single `rtc-signal` event. The greater socket id in each pair
  sends the offer, so there's exactly one per pair.
- Remote tiles in a responsive grid; mute mic / stop camera / leave.

Every participant is `host | speaker | listener`; `setRole` in `rooms.js` is the
single place a role changes. Participant list is sorted host-first with coloured
role pills; each video tile shows its role. Nothing is enforced yet. Next: Phase
4 (the Moderated switch).
