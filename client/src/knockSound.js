// The "someone's at the door" ding-dong, made with Web Audio — no sound file.
//
// Phones (iPhone especially) only let a page make sound after a tap, so the
// audio engine is created/resumed on the first tap anywhere; until then the
// chime is skipped (Android still buzzes).

let ctx = null;

function unlock() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    // no Web Audio — the buzz is all we have
  }
}
if (typeof document !== 'undefined') {
  ['pointerdown', 'touchend', 'keydown'].forEach((t) =>
    document.addEventListener(t, unlock, { capture: true, passive: true }),
  );
}

// One bell note: a soft sine with a little shimmer, quick attack, long fade.
function note(freq, start, length = 0.9) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, start);
  out.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
  out.gain.exponentialRampToValueAtTime(0.0001, start + length);
  out.connect(ctx.destination);
  for (const [mult, level] of [
    [1, 1],
    [2, 0.25],
    [3, 0.08],
  ]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    g.gain.value = level;
    osc.connect(g).connect(out);
    osc.start(start);
    osc.stop(start + length + 0.05);
  }
}

/** Ding-dong (and a short buzz on phones that can). */
export function playKnock() {
  navigator.vibrate?.([120, 80, 120]);
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime + 0.02;
  note(659.25, t); // E5 — "ding"
  note(523.25, t + 0.32, 1.1); // C5 — "dong"
}
