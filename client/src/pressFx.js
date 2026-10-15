// A smooth "press" on every button, everywhere (app + landing page):
// pressing shrinks it a touch, letting go springs it back with a tiny bounce.
//
// One listener on the whole page (installed once from main.jsx), so every
// button gets it — including ones added later — with no change to them.
//
// It animates the CSS `scale` property (not `transform`), which stacks on top
// of whatever a button already does with transform (centring, hover lifts,
// the tab highlight…), so nothing jumps. It uses the browser's own animation
// engine (element.animate), so it never fights a button's CSS transitions.

const PRESSABLE = 'button, a.ld-btn, [role="button"], summary';
const PRESSED = '0.95'; // how small while held down
const DOWN_MS = 110; // quick in…
const UP_MS = 380; // …softer out, with a little overshoot
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// The button being held down, and its "pressed" animation.
let held = null;
let pressing = null;

function press(e) {
  if (e.button > 0 || reducedMotion()) return; // left click / touch / pen only
  const el = e.target.closest?.(PRESSABLE);
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  release();
  held = el;
  pressing = el.animate([{ scale: '1' }, { scale: PRESSED }], {
    duration: DOWN_MS,
    easing: 'ease-out',
    fill: 'forwards', // stay small while held
  });
}

function release() {
  if (!held) return;
  const el = held;
  // Spring back from wherever the press got to (a very quick tap may not
  // have reached full size), then hand the button back to its CSS.
  const from = getComputedStyle(el).scale;
  pressing?.cancel();
  held = null;
  pressing = null;
  const back = el.animate([{ scale: from === 'none' ? '1' : from }, { scale: '1' }], {
    duration: UP_MS,
    easing: SPRING,
  });
  back.onfinish = () => back.cancel();
}

let installed = false;
export function installPressFx() {
  if (installed || typeof window === 'undefined' || !Element.prototype.animate) return;
  installed = true;
  const opts = { capture: true, passive: true }; // capture: even if a button stops the event
  window.addEventListener('pointerdown', press, opts);
  for (const type of ['pointerup', 'pointercancel', 'dragstart', 'blur']) {
    window.addEventListener(type, release, opts);
  }
  // sliding the finger / mouse off the button lets it go too
  window.addEventListener(
    'pointerout',
    (e) => {
      if (held && !held.contains(e.relatedTarget)) release();
    },
    opts,
  );
}
