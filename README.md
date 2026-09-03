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

## Other scripts

| Command          | What it does                   |
| ---------------- | ------------------------------ |
| `npm run build`  | Production build of the client |
| `npm run lint`   | ESLint across the repo         |
| `npm run format` | Prettier-format the repo       |

## Current status

**Phase 1 complete.** The server owns room state via Socket.IO:

- `join-room {roomId, name}` adds a participant; the first joiner becomes host.
- Every change broadcasts a full `room-state` snapshot to the room.
- On `disconnect` the participant is removed; if the host left, the next
  participant is promoted; an empty room is closed.

Open two tabs at http://localhost:5173/?room=demo and watch the participant
list and server logs. Next: Phase 2 (getUserMedia + mesh WebRTC).
