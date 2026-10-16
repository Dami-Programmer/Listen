// The demo's "cameras" and generated sound (see env.js / bots.js).
//
// Every person in the demo — the visitor and the pretend participants — has a
// "camera" whose picture is made here. No real camera is ever used.
//
//   - Each named person (Grace, Sam, Ada, Tunde, Mia, Ben, and "you") shows a
//     PHOTO from public/demo-people/. They're AI-generated — not real people —
//     made for the demo. A slow drift and zoom makes the still photo look
//     like a live camera.
//   - Anyone without a photo, or while it's still loading, gets the drawn
//     figure below instead: a coloured backdrop and a head-and-shoulders
//     shape that sways, and talks (mouth + rings) while speaking.
//
// The pictures reach the call screen through the stand-in connection in
// fakePeer.js (no video compression), so drawing them costs very little.

// The picture is laid out on a 640 x 360 sheet (all the numbers below) and
// drawn at SCALE of that: 960 x 540, the photos' own size, so a photo stays
// sharp even in the big "talking" tile. FPS: how often it's redrawn; 10 is
// plenty for a slow drift and a talking mouth.
const W = 640;
const H = 360;
const SCALE = 1.5;
const FPS = 10;

// The people who have a photo (public/demo-people/<name>.webp, 960 x 540).
const PHOTOS = new Set(['grace', 'sam', 'ada', 'tunde', 'mia', 'ben', 'you']);
const images = new Map(); // name -> <img>, loaded once and shared

/** The photo name for a camera id ('bot-grace', 'bot-grace~2', 'demo-you'). */
function photoName(id) {
  const base = id === 'demo-you' ? 'you' : id.replace(/^bot-/, '').replace(/~\d+$/, '');
  return PHOTOS.has(base) ? base : null;
}

function photo(name) {
  let img = images.get(name);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = `/demo-people/${name}.webp`;
    images.set(name, img);
  }
  return img;
}

// A photo, gently moving: a slow zoom in and out ("breathing") and a small
// drift, each person at their own rhythm (`seed`) so they don't move in step.
// It's always zoomed in a little (at least 2.8%), so the drift never shows
// the photo's edges.
function drawPhoto(ctx, img, t, seed) {
  const k = 1.04 + Math.sin(t / 2600 + seed) * 0.012;
  const dx = Math.sin(t / 3400 + seed * 2) * 6;
  const dy = Math.cos(t / 4100 + seed) * 3;
  const w = W * k;
  const h = H * k;
  ctx.drawImage(img, (W - w) / 2 + dx, (H - h) / 2 + dy, w, h);
}

// Who's talking right now (the demo server keeps this up to date).
const talking = new Set();
export function setTalking(ids) {
  talking.clear();
  for (const id of ids) talking.add(id);
}

const cams = new Map(); // id -> { canvas }

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

function drawPerson(ctx, t, color, isTalking) {
  // backdrop: a dim room in the person's colour
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, shade(color, 0.32));
  g.addColorStop(1, shade(color, 0.12));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // a soft lamp glow behind them
  const lamp = ctx.createRadialGradient(W * 0.7, H * 0.25, 10, W * 0.7, H * 0.25, 260);
  lamp.addColorStop(0, 'rgba(255,255,255,0.10)');
  lamp.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, W, H);

  const sway = Math.sin(t / 900) * 6;
  const cx = W / 2 + sway;
  // the figure a bit smaller and lower, so a wide crop still shows all of it
  ctx.save();
  ctx.translate(cx, H);
  ctx.scale(0.78, 0.78);
  ctx.translate(-cx, -H);
  // "speaking" rings
  if (isTalking) {
    for (let i = 0; i < 2; i += 1) {
      const p = (((t / 900 + i / 2) % 1) + 1) % 1;
      ctx.strokeStyle = `rgba(39,196,243,${0.45 * (1 - p)})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, 150, 70 + p * 70, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // shoulders
  ctx.fillStyle = shade(color, 0.85);
  ctx.beginPath();
  ctx.ellipse(cx, H + 40, 170, 150, 0, Math.PI, 0);
  ctx.fill();
  // neck + head
  ctx.fillStyle = shade(color, 1.15);
  ctx.fillRect(cx - 24, 190, 48, 50);
  ctx.beginPath();
  ctx.arc(cx, 150, 66, 0, Math.PI * 2);
  ctx.fill();
  // eyes (with a blink now and then)
  const blink = t % 4200 < 130;
  ctx.fillStyle = 'rgba(20,24,30,0.75)';
  for (const dx of [-22, 22]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx, 140, 6, blink ? 1 : 6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // mouth: a friendly smile, opening and closing while talking
  if (isTalking) {
    const open = 4 + Math.abs(Math.sin(t / 95)) * 9;
    ctx.beginPath();
    ctx.ellipse(cx, 178, 14, open, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = 'rgba(20,24,30,0.7)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, 166, 18, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }
  // a little blush
  ctx.fillStyle = 'rgba(255,120,140,0.18)';
  for (const dx of [-36, 36]) {
    ctx.beginPath();
    ctx.arc(cx + dx, 166, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function camera(id, color) {
  let cam = cams.get(id);
  if (cam) return cam;
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE); // draw in 640 x 360 numbers onto the real canvas size
  const name = photoName(id);
  const img = name ? photo(name) : null;
  const seed = [...id].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 7; // own rhythm
  const tick = () => {
    const t = performance.now();
    // the photo once it's loaded; the drawn figure until then (or without one)
    if (img?.complete && img.naturalWidth) drawPhoto(ctx, img, t, seed);
    else drawPerson(ctx, t, color, talking.has(id));
  };
  tick();
  setInterval(tick, 1000 / FPS);
  cam = { canvas };
  cams.set(id, cam);
  return cam;
}

/** A camera for `id`: a fresh track each call, one picture per person. */
export function drawnCamera(id, _name, color) {
  return camera(id, color).canvas.captureStream(FPS);
}

// --- sound -----------------------------------------------------------------
let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    // Browsers start sound only after a click; the visitor's first click in
    // the demo wakes it (so "your voice" can light up when you have the floor).
    // (after the click has finished: "you" starting to talk changes the stage,
    // which mustn't happen in the middle of that click)
    const wake = () => setTimeout(() => audioCtx.resume().catch(() => {}), 0);
    window.addEventListener('click', wake, { capture: true });
    window.addEventListener('keyup', wake, { capture: true });
  }
  return audioCtx;
}

/**
 * "Your microphone": a soft, voice-like hum that rises and falls in
 * syllables. Never played out loud — it only gives the app something to
 * measure, so the active-speaker glow works when you have the floor.
 */
export function voiceTrack() {
  const c = ctx();
  const out = c.createMediaStreamDestination();
  const voice = c.createOscillator();
  voice.type = 'sawtooth';
  voice.frequency.value = 160;
  const mouth = c.createBiquadFilter();
  mouth.type = 'bandpass';
  mouth.frequency.value = 900;
  const level = c.createGain();
  level.gain.value = 0.25;
  const syl = c.createOscillator();
  syl.frequency.value = 3;
  const depth = c.createGain();
  depth.gain.value = 0.25;
  syl.connect(depth).connect(level.gain);
  voice.connect(mouth).connect(level).connect(out);
  voice.start();
  syl.start();
  return out.stream.getAudioTracks()[0];
}

/** "Share screen" in the demo shares this drawn slide. */
export function drawnScreen() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const g = canvas.getContext('2d');
  const draw = () => {
    g.fillStyle = '#f5f7fa';
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#27c4f3';
    g.fillRect(0, 0, 1280, 14);
    g.fillStyle = '#16202a';
    g.font = 'bold 64px sans-serif';
    g.fillText('Week 4: Listening well', 90, 170);
    g.font = '38px sans-serif';
    g.fillStyle = '#3d4955';
    ['• Raise a hand to speak', '• One voice at a time', '• Questions at the end'].forEach((l, i) =>
      g.fillText(l, 110, 300 + i * 80),
    );
    g.font = '24px sans-serif';
    g.fillStyle = '#8d98a5';
    g.fillText('Turnly demo: a pretend shared screen', 90, 660);
  };
  draw();
  const stream = canvas.captureStream(5);
  setInterval(draw, 1000);
  return stream;
}
