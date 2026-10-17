// The "Start a meeting" splash: the Turnly mark filling up like water in a
// cup, shown on top of the start page (/start) right after someone clicks
// "Start a meeting" on the landing page. When it's full it fades away and
// the start page is there underneath (it was loading the whole time).
//
// How it's triggered: startClick.js (the landing page notes the click; main.jsx
// checks for it on /start).
//
// The SPLASH_MS clock starts at the CLICK, not when this page appears — so
// the water keeps rising smoothly across the page change, and the total wait
// is SPLASH_MS however long the page took to load.
//
// The look is in index.css ("start splash").

import { useEffect, useState } from 'react';
import { SPLASH_MS } from './startClick.js';

// How far through, 0–1 (never below 0, even if the clock was changed
// between the click and now)
const progress = (since) => Math.min(1, Math.max(0, (Date.now() - since) / SPLASH_MS));

// The water pours in steps, like a cup being filled — each pour rises over
// 0.7s (index.css, .ss-water). [from this far through, water level %, words]
// Full at 3/4 of the way; the last quarter it sits full (with a little
// settle), then it fades into the start page. Level goes a little past 100%
// so the wave clears the top of the mark.
const POURS = [
  [0, 12, 'Getting things ready…'],
  [0.25, 40, 'Getting things ready…'],
  [0.5, 70, 'Setting up your meeting…'],
  [0.75, 108, 'Almost there…'],
];

/** @param {number} props.since  when "Start a meeting" was clicked (ms) */
export default function StartSplash({ since }) {
  // how far through (0–1), checked every frame (it picks the pour)
  const [done, setDone] = useState(() => progress(since));
  const [gone, setGone] = useState(false); // fully faded out: remove it

  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      const t = progress(since);
      setDone(t);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    // The fade-out (0.45s in CSS) runs from SPLASH_MS; then it's removed. A
    // timer too, not only the frames above — a background tab pauses frames.
    const end = setTimeout(() => setGone(true), Math.max(0, since + SPLASH_MS - Date.now()) + 450);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(end);
    };
  }, [since]);

  if (gone) return null;
  const [, level, words] = [...POURS].reverse().find(([from]) => done >= from);
  const full = level > 100;

  return (
    <div className={`start-splash${done >= 1 ? ' done' : ''}`} role="status" aria-live="polite">
      <div className={`ss-cup${full ? ' full' : ''}`} style={{ '--level': `${level}%` }}>
        <div className="ss-empty" />
        <div className="ss-water">
          <div className="ss-wave back" />
          <div className="ss-wave" />
        </div>
      </div>
      <p className="ss-words">{words}</p>
    </div>
  );
}
