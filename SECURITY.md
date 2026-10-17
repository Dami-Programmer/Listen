# Security notes

What protects Turnly beyond the code itself, and where it's set. Render's
settings live outside this repo — this file is the record of them.

## Website headers (Render → Listen-2 → Headers, path `/*`)

| Header                                | Value                                                                                          | Why                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `X-Frame-Options`                     | `SAMEORIGIN`                                                                                   | Other sites can't show Turnly in a hidden frame (clickjacking). Our own demo frames still work. |
| `Content-Security-Policy`             | `frame-ancestors 'self'`                                                                       | The same, for newer browsers.                                                                   |
| `Referrer-Policy`                     | `strict-origin-when-cross-origin`                                                              | Other sites only learn "came from Turnly", never the page address (which can hold a room name). |
| `Permissions-Policy`                  | `camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()` | Camera, mic and screen sharing for Turnly only; features it never uses are off.                 |
| `Content-Security-Policy-Report-Only` | the policy below                                                                               | Stage 1: nothing is blocked; anything that _would_ be is reported.                              |
| `Reporting-Endpoints`                 | `csp="https://listen-1-wj2o.onrender.com/csp-reports"`                                         | Where newer browsers send those reports.                                                        |

(`Strict-Transport-Security` and `X-Content-Type-Options: nosniff` come from
Render itself.)

## The content security policy

Where the website may load things from. Built from what the code actually
uses — if you add a service (a new script, font, image host, API), add it
here and to the header, or it will be blocked once the policy is enforced.

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval' https://cloud.umami.is;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: blob: https://listen-1-wj2o.onrender.com https://upload.wikimedia.org https://thumb.wikimedia.org https://cdn.myanimelist.net;
media-src 'self' blob: https://listen-1-wj2o.onrender.com;
connect-src 'self' https://listen-1-wj2o.onrender.com wss://listen-1-wj2o.onrender.com https://en.wikipedia.org https://api.jikan.moe https://cloud.umami.is data: blob:;
worker-src 'self' blob:;
frame-src 'self';
frame-ancestors 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
report-uri https://listen-1-wj2o.onrender.com/csp-reports;
report-to csp
```

Why the less obvious parts:

- `'wasm-unsafe-eval'` — strong noise reduction runs WebAssembly
  (`noiseReduction.js`).
- `style-src 'unsafe-inline'` — the floating mini-call window adds its own
  styles (`usePip.js`).
- `worker-src blob:` — recording keeps time in a small worker made in the page
  (`recorder.js`).
- `img-src` Wikimedia / MyAnimeList — character pictures (`AvatarPicker.jsx`).
- No inline scripts at all: the start-up script is `client/public/boot.js`, and
  pdf.js runs with `isEvalSupported: false` (`presenter.js`).

### Switching it on

1. **Now — report only.** Watch Render's logs for Listen-1 for lines starting
   `[csp] would block …` (they name what and on which kind of page, never a
   room).
2. **When the log has been quiet for a few days** of real use (meetings,
   recordings, captions, noise reduction, presenting a PDF): rename the header
   `Content-Security-Policy-Report-Only` → `Content-Security-Policy` in
   Render's settings. Undo is the same rename back.

Tested before going live: the built site served with this policy **enforced**
— landing page, live demo, start page with the character search, privacy page
— with nothing blocked.

## Server protections (code)

- Every moderator action is checked on the server (`server/src/index.js`,
  `requireModeratorRoom`); per-event rate limits.
- At most 150 connections per visitor address; a connection that never asks to
  join is closed after 60 s; messages up to 10 MB (`connLimits.js`).
- Secrets: rejoin tickets, recording / chat-file links, host keys and meeting
  codes are long random values; host keys are stored hashed and compared in
  constant time (`names.js`).
- `X-Powered-By` is off.
- Chat files are served as downloads (photos and PDFs inline) with
  `nosniff` and a sandboxing policy (`chatFiles.js`, `GET /files/:id`).

## Deploys

Both Render services deploy only **after the GitHub check passes** (lint,
tests, build — `.github/workflows/check.yml`). The server only redeploys when
`server/`, `shared/` or the package files change.
