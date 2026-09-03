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

**Phase 0 complete.** Next: Phase 1 (Socket.IO signaling + in-memory room registry).
