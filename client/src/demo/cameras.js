// Drawn "cameras" and generated sound for the demo (see env.js / bots.js).
//
// Every person in the demo — the visitor and the pretend participants — sends
// real video through real WebRTC connections, but the picture is drawn here:
// a soft coloured backdrop with a head-and-shoulders figure that sways a
// little, and talks (an animated mouth + rings) while that person has the
// floor and is speaking. No real faces, no real camera.

const W = 640;
const H = 360;
const FPS = 15;

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
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const tick = () => drawPerson(ctx, performance.now(), color, talking.has(id));
  tick();
  setInterval(tick, 1000 / FPS);
  cam = { canvas };
  cams.set(id, cam);
  return cam;
}

/** A drawn camera for `id` (a fresh track each call; one drawing per person). */
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
