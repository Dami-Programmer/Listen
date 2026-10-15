// The demo page's sandbox (/demo — see main.jsx and DemoApp.jsx).
//
// The demo runs the REAL Turnly app, so anything the app would normally do
// to the outside world is redirected here, before the app starts:
//
//   storage      localStorage reads/writes go to an in-memory copy, so the
//                demo never marks the real app's tours as seen, saves host
//                keys, or changes settings for the visitor's real meetings.
//   camera/mic   getUserMedia returns a drawn "camera" (cameras.js) and a
//                generated sound — the visitor's real camera and microphone
//                are never asked for. Screen sharing shares a drawn slide.
//   video links  the app's video connections (RTCPeerConnection) are the
//                lightweight stand-in from fakePeer.js: the pretend people's
//                drawn cameras go straight to the app, with no real video
//                compressing / decompressing (that's what made the demo heavy).
//   server       the app's Socket.IO connection is the in-page DemoSocket
//                (demoSocket.js) and its plain HTTP calls (claim a name,
//                schedule…) get pretend answers from demoFetch below.
//
// Nothing here runs outside /demo.

import { drawnCamera, drawnScreen, voiceTrack } from './cameras.js';
import { DemoPeerConnection } from './fakePeer.js';

let installed = false;

export function installDemoEnv({ theme } = {}) {
  if (installed) return;
  installed = true;

  // --- storage: an in-memory copy ----------------------------------------
  const real = window.localStorage;
  const mem = new Map();
  // Start from what the app needs: the visitor's theme, and every "first
  // time" helper already seen (no tours or pop-ups over the demo).
  const seed = {
    'listen.theme': theme || safeGet(real, 'listen.theme') || 'dark',
    'listen.tour.desktop.seen': '1',
    'listen.tour.phone.seen': '1',
    'listen.tour.mobile.seen': '1',
    'listen.creatorCardSeen': '1',
  };
  for (const [k, v] of Object.entries(seed)) mem.set(k, v);
  const proto = Storage.prototype;
  const orig = {
    getItem: proto.getItem,
    setItem: proto.setItem,
    removeItem: proto.removeItem,
    key: proto.key,
    clear: proto.clear,
  };
  proto.getItem = function getItem(k) {
    return this === real
      ? mem.has(String(k))
        ? mem.get(String(k))
        : null
      : orig.getItem.call(this, k);
  };
  proto.setItem = function setItem(k, v) {
    if (this === real) mem.set(String(k), String(v));
    else orig.setItem.call(this, k, v);
  };
  proto.removeItem = function removeItem(k) {
    if (this === real) mem.delete(String(k));
    else orig.removeItem.call(this, k);
  };
  proto.key = function key(i) {
    return this === real ? ([...mem.keys()][i] ?? null) : orig.key.call(this, i);
  };
  proto.clear = function clear() {
    if (this === real) mem.clear();
    else orig.clear.call(this);
  };
  document.documentElement.dataset.theme = mem.get('listen.theme') === 'light' ? 'light' : 'dark';

  // --- camera / microphone / screen: drawn and generated -------------------
  const md = navigator.mediaDevices ?? (navigator.mediaDevices = {});
  md.getUserMedia = async (constraints = {}) => {
    const stream = new MediaStream();
    if (constraints.video) {
      for (const t of drawnCamera('demo-you', 'You', '#27c4f3').getVideoTracks())
        stream.addTrack(t);
    }
    if (constraints.audio) stream.addTrack(voiceTrack());
    return stream;
  };
  md.getDisplayMedia = async () => drawnScreen();
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'demo-mic', groupId: 'demo', label: 'Demo microphone' },
    { kind: 'videoinput', deviceId: 'demo-cam', groupId: 'demo', label: 'Demo camera' },
    { kind: 'audiooutput', deviceId: 'default', groupId: 'demo', label: 'Speakers' },
  ];
  md.addEventListener ??= () => {};
  md.removeEventListener ??= () => {};

  // --- video connections: the lightweight stand-in (fakePeer.js) ---------
  window.RTCPeerConnection = DemoPeerConnection;

  // --- the app's HTTP calls: pretend answers -------------------------------
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const answer = demoFetch(url, init);
    return answer ?? realFetch(input, init); // (fonts, pictures and other plain files)
  };

  // Videos start straight away. Browsers hold back an unmuted video until
  // the visitor's first click; the pretend participants send no sound at
  // all, so muting their videos changes nothing you'd hear — and lets them
  // play before you've clicked anything.
  const startSilent = () => {
    for (const v of document.querySelectorAll('video')) {
      const s = v.srcObject;
      if (v.paused && s && !s.getAudioTracks().length) {
        v.muted = true;
        v.play().catch(() => {});
      }
    }
  };
  document.addEventListener('loadedmetadata', startSilent, true);
  setInterval(startSilent, 1000);

  // The landing page changes theme -> follow it.
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === 'turnly-demo-theme') {
      const t = e.data.theme === 'light' ? 'light' : 'dark';
      mem.set('listen.theme', t);
      document.documentElement.dataset.theme = t;
    }
  });
}

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

const json = (body, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );

// Same rules as the server (names.js): 3-30 lowercase letters / numbers /
// hyphens, not a meeting code, not a reserved word.
// The real server's address (as in socket.js) — the demo never calls it.
const SERVER_ORIGIN = new URL(import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001').origin;

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
const TAKEN = new Set(['turnly', 'admin', 'demo', 'start', 'help', 'gracechurch']);

/** A pretend answer for one of the app's server calls, or null (not ours). */
function demoFetch(url, init = {}) {
  let path;
  let toServer;
  try {
    const u = new URL(url, window.location.href);
    path = u.pathname;
    toServer = u.origin === SERVER_ORIGIN;
  } catch {
    return null;
  }
  const method = (init.method || 'GET').toUpperCase();
  const body = (() => {
    try {
      return JSON.parse(init.body || '{}');
    } catch {
      return {};
    }
  })();
  // Is a link name free? (ClaimRoom)
  let m = path.match(/^\/names\/([^/]+)$/);
  if (m && method === 'GET') {
    const name = decodeURIComponent(m[1]);
    const valid = NAME_RE.test(name);
    return json({ valid, available: valid && !TAKEN.has(name) });
  }
  if (path === '/names' && method === 'POST') {
    // Pretend claim — nothing is stored anywhere.
    return json({ ok: true, name: String(body.name || ''), hostKey: 'demo-host-key' });
  }
  if (path === '/schedules' && method === 'POST') {
    return json({ ok: true, room: body.name || 'demo-meet-ing', hostKey: 'demo-host-key' });
  }
  m = path.match(/^\/names\/[^/]+\/info$/);
  if (m) return json({ ok: false }, 404);
  if (path === '/health') return json({ ok: true });
  if (path === '/feedback') return json({ ok: true });
  if (path.startsWith('/recordings')) return json({ ok: false }, 404);
  // anything else meant for the real server: never sent
  return toServer ? json({ ok: false, error: 'not available in the demo' }, 503) : null;
}
