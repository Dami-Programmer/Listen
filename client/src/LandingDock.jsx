// The landing page's floating dock: a row of icons in a glass pill, centred
// at the bottom of the screen (like a phone's dock).
//
// It rests folded into four hopping dots. Mouse over it (or tap it on a
// phone, or Tab to it) and it spreads open into the full row; mouse away (or
// tap outside, or pick a link) and it folds back. The look and the motion are
// all CSS (.ld-dock in index.css); this file sets a few numbers per icon and
// handles the tap.
//
// It stays hidden while the visitor reads the top of the page, and slides up
// once they've scrolled down to the app demo picture (.ld-hero-show). Scroll
// back up above the picture and it slides away again — up there, the normal
// top bar has the same links.
//
// Each icon has a small label above it on hover / keyboard focus (CSS,
// .ld-dock-tip), and a proper aria-label for screen readers.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ThemeToggle from './ThemeToggle.jsx';
import { GridView, Hand, People } from './icons.jsx';
import { trackEvent } from './analytics.js';

// Two icons the app's icon set doesn't have; same line style as icons.jsx.
const line = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};
// "Back to top" is the Turnly mark itself (a 96px copy of the favicon:
// sharp even magnified on high-res screens, and only 5 KB)
const Mark = () => <img className="ld-dock-mark" src="/turnly-mark-96.png" alt="" />;
const Question = () => (
  <svg {...line}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01" />
  </svg>
);
const Play = () => (
  <svg {...line}>
    <path d="M8 5.5v13l10-6.5z" fill="currentColor" />
  </svg>
);

// [where it goes, label, icon] — the same sections as the top bar.
const LINKS = [
  ['#top', 'Back to top', Mark],
  ['#how', 'How it works', Hand],
  ['#features', 'Features', GridView],
  ['#who', 'Who it’s for', People],
  ['#faq', 'Questions', Question],
];

// The dock's icons and its divider (not the glass or the dots).
const ICONS = ':scope > .ld-dock-btn, :scope > .ld-dock-sep';

/** @param {string} props.start  where "Start a meeting" goes ('/start') */
export default function LandingDock({ start }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false); // tapped open (phones)
  const dockRef = useRef(null);

  // Show once the demo picture's top has come up past the middle of the
  // screen. A plain scroll check (at most once a frame) rather than an
  // IntersectionObserver, so it also works when the page loads already
  // scrolled down (back button, #features link).
  useEffect(() => {
    const picture = document.querySelector('.ld-hero-show');
    if (!picture) return undefined;
    let frame = 0;
    const check = () => {
      frame = 0;
      setShown(picture.getBoundingClientRect().top < window.innerHeight * 0.5);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  // Folded, every icon waits in the middle. For each one, work out how far
  // its spot is from the middle (--tc: where its fly-out starts) and a small
  // delay that grows with that distance (--d: nearest fly out first). Layout
  // sizes (offsetLeft / offsetWidth) ignore the animations, so these are
  // always the icons' real spots. Again on resize (phones are smaller).
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return undefined;
    const place = () => {
      const middle = dock.offsetWidth / 2;
      const icons = [...dock.querySelectorAll(ICONS)];
      const centre = (el) => el.offsetLeft + el.offsetWidth / 2;
      const far = Math.max(1, ...icons.map((el) => Math.abs(centre(el) - middle)));
      icons.forEach((el) => {
        const tc = middle - centre(el);
        el.style.setProperty('--tc', `${tc.toFixed(1)}px`);
        el.style.setProperty('--d', `${((Math.abs(tc) / far) * 0.12).toFixed(3)}s`);
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);

  // Tapped open: fold again on a tap anywhere else, or Esc. (Picking a link
  // folds it too — onClick on the nav.)
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !dockRef.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  // … and when the dock slides away (scrolled back up)
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);

  // The Mac-dock magnify (styles: "magnify" in index.css). On every mouse
  // move, each icon gets a size from how far its centre is from the mouse:
  // right under it = MAX_MAG, fading smoothly to normal at REACH px away.
  // Bigger icons need more room, so each one is also slid sideways (--shift)
  // away from the mouse by half of the extra width of everything between,
  // and the bar widens by the same total, half on each side (--spread).
  // Mouse/trackpad only, and not for people who ask for less motion.
  useEffect(() => {
    const dock = dockRef.current;
    const can = window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)');
    if (!dock || !can.matches) return undefined;
    const MAX_MAG = 1.45; // the icon under the mouse
    const REACH = 110; // px from the mouse where icons are back to normal
    const LIFT = 16; // px the biggest icon rises

    let items = []; // [element, its resting centre on screen, its width]
    let frame = 0;
    let mouseX = 0;

    // Where each icon sits at rest, measured when the mouse comes in. Uses
    // layout positions (offsetLeft), which ignore the slide/grow animation —
    // so it's right even if the icons are still settling from last time. The
    // bar's own left edge + padding move by equal and opposite amounts as it
    // widens, so these centres never change while the mouse is in.
    const measure = () => {
      const left = dock.getBoundingClientRect().left + dock.clientLeft;
      // (just the icons and the divider — not the glass or the dots)
      items = [...dock.querySelectorAll(ICONS)].map((el) => [
        el,
        left + el.offsetLeft + el.offsetWidth / 2,
        el.offsetWidth,
      ]);
    };

    const apply = () => {
      frame = 0;
      // 1. how big each one is (a smooth cosine bump around the mouse)
      const mags = items.map(([el, centre]) => {
        if (el.classList.contains('ld-dock-sep')) return 1;
        const d = Math.abs(mouseX - centre);
        return d >= REACH ? 1 : 1 + (MAX_MAG - 1) * (0.5 + 0.5 * Math.cos((Math.PI * d) / REACH));
      });
      const extra = items.map(([, , w], i) => (mags[i] - 1) * w); // extra width
      const total = extra.reduce((a, b) => a + b, 0);
      // 2. slide each one: everything to its left pushes it right, and the
      // whole row is re-centred (minus half the total)
      let before = 0;
      items.forEach(([el], i) => {
        const shift = before + extra[i] / 2 - total / 2;
        before += extra[i];
        el.style.setProperty('--shift', `${shift.toFixed(2)}px`);
        el.style.setProperty('--mag', mags[i].toFixed(3));
        el.style.setProperty('--lift', `${(-LIFT * (mags[i] - 1)) / (MAX_MAG - 1)}px`);
      });
      dock.style.setProperty('--spread', `${(total / 2).toFixed(2)}px`);
    };

    const onEnter = (e) => {
      measure();
      mouseX = e.clientX;
      dock.classList.add('magnify');
      apply();
    };
    const onMove = (e) => {
      mouseX = e.clientX;
      if (!frame) frame = requestAnimationFrame(apply); // at most once a frame
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      dock.classList.remove('magnify'); // switches to the soft settle
      items.forEach(([el]) => {
        el.style.removeProperty('--shift');
        el.style.removeProperty('--mag');
        el.style.removeProperty('--lift');
      });
      dock.style.removeProperty('--spread');
    };

    dock.addEventListener('pointerenter', onEnter);
    dock.addEventListener('pointermove', onMove);
    dock.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      dock.removeEventListener('pointerenter', onEnter);
      dock.removeEventListener('pointermove', onMove);
      dock.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    // `inert` while hidden: its buttons can't be tabbed to or clicked
    // ('' = on, undefined = off — React 18 only passes it through as text)
    <nav
      ref={dockRef}
      className={`ld-dock${shown ? ' shown' : ''}${open ? ' open' : ''}`}
      aria-label="Page sections"
      inert={shown ? undefined : ''}
      // picked a link: fold back (it's done its job)
      onClick={(e) => e.target.closest('a') && setOpen(false)}
    >
      {/* the glass (two layers — see .ld-dock-bg in index.css) */}
      <span className="ld-dock-bg" aria-hidden="true">
        <span className="ld-dock-glass" />
      </span>
      {/* folded: four hopping dots. A button, so a tap (phones) or the Tab
          key can open it; on a computer, just moving the mouse over it does */}
      <button
        type="button"
        className="ld-dock-dots"
        aria-label="Show page sections"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span />
        <span />
        <span />
        <span />
      </button>
      {LINKS.map(([href, label, Icon]) => (
        <a key={href} href={href} className="ld-dock-btn" aria-label={label}>
          <Icon />
          <span className="ld-dock-tip" aria-hidden="true">
            {label}
          </span>
        </a>
      ))}
      <span className="ld-dock-sep" aria-hidden="true" />
      <span className="ld-dock-btn ld-dock-theme">
        <ThemeToggle />
      </span>
      <a
        href={start}
        className="ld-dock-btn ld-dock-start"
        aria-label="Start a meeting"
        onClick={() => trackEvent('start clicked', { where: 'dock' })}
      >
        <Play />
        <span className="ld-dock-tip" aria-hidden="true">
          Start a meeting
        </span>
      </a>
    </nav>
  );
}
