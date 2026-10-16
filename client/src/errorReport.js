// Tells the server when something goes wrong in a visitor's browser, so it
// shows up in the server's logs on Render (look for "[client-error]").
// Without this, a crash or a call that fails on someone's phone is invisible.
//
// What gets reported:
//   - crashes the error screen caught (ErrorBoundary.jsx)       kind 'crash'
//   - any other uncaught error / rejected promise on the page   'error' / 'promise'
//   - a call going wrong: camera / mic couldn't open, a video
//     connection gave up, … (reportCallProblem, from webrtc.js)  'call'
//
// What's sent: the kind, a short message, the first lines of the stack, and
// which KIND of page it was (landing, demo, home, meeting, recording) — never
// the page's address, so room names stay private. The server adds the
// browser it came from.
//
// It never gets in the way: at most 10 reports per page load, the same
// message only once a minute, and sent with sendBeacon (fire-and-forget,
// works even while the page is closing). If it fails, nothing happens.

// The server's address (as in socket.js — repeated here so the landing page
// doesn't have to load socket.js just for this).
const SERVER = import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001';

const MAX_PER_PAGE = 10;
const SAME_AGAIN_MS = 60_000;
let sent = 0;
const lastSent = new Map(); // message -> when it was last sent

// Browser noise that isn't Turnly's problem: not worth a report.
const IGNORE = [
  /ResizeObserver loop/i, // harmless layout warning some browsers raise as an error
  /^Script error\.?$/i, // an error inside another site's script: no details
];

/** Which kind of page this is — never the address itself. */
function pageKind() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  if (path === '/demo') return 'demo';
  if (params.get('rec')) return 'recording';
  if (path === '/' && !params.get('room')) return 'landing';
  if (path === '/start' && !params.get('room')) return 'home';
  return 'meeting';
}

function send(kind, message, stack = '', extra = {}) {
  message = String(message || 'Unknown error').slice(0, 300);
  if (IGNORE.some((re) => re.test(message))) return;
  // Errors from browser extensions show up here too: skip those.
  if (/(chrome|moz|safari)-extension:\/\//.test(String(stack))) return;
  if (sent >= MAX_PER_PAGE) return;
  const now = Date.now();
  if (now - (lastSent.get(message) ?? -Infinity) < SAME_AGAIN_MS) return;
  lastSent.set(message, now);
  sent += 1;

  const body = JSON.stringify({
    kind,
    message,
    // the first few lines are enough to find the spot in the code
    stack: String(stack || '')
      .split('\n')
      .slice(0, 8)
      .join('\n')
      .slice(0, 1500),
    page: pageKind(),
    ...extra,
  });
  try {
    // text/plain: a "simple" request, so the browser sends it straight away
    // (no CORS pre-check) — the server reads it as text and parses it.
    navigator.sendBeacon?.(`${SERVER}/client-errors`, new Blob([body], { type: 'text/plain' }));
  } catch {
    // reporting must never cause an error of its own
  }
}

/** Report an error object (or a message) of a given kind. */
export function reportError(kind, error, extra) {
  send(kind, error?.message ?? error, error?.stack, extra);
}

/**
 * Report something going wrong with a call — not a code crash, but e.g. the
 * camera refusing to open or a video connection giving up. `what` is a short
 * fixed description ("camera/mic failed"); `detail` the browser's reason.
 */
export function reportCallProblem(what, detail) {
  const reason = detail?.name || detail?.message || (detail ? String(detail) : '');
  send('call', reason ? `${what}: ${reason}` : what, detail?.stack);
}

/** Catch every error nothing else caught. Called once, in main.jsx. */
export function installErrorReporting() {
  window.addEventListener('error', (e) => {
    // (a failed <img> or <script> also fires 'error', with no message: skip)
    if (!e.message) return;
    send('error', e.message, e.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send('promise', r?.message ?? r, r?.stack);
  });
}
