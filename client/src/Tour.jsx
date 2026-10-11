// The step-by-step tour of the call screen ("how Listen works").
//
// It dims the screen, cuts a glowing spotlight around ONE button at a time,
// and shows a small card next to it: what the button does, "3 of 10", and
// Back / Next / Skip (arrow keys and Esc work too). Clicks on the call itself
// are blocked while the tour runs, so nothing gets pressed by accident.
//
// Steps are plain data (see the phone and desktop lists in MobileCall.jsx and
// App.jsx):
//   { target: '<CSS selector>', title, text, before?: () => {} }
// `before` runs when the step opens — e.g. the phone tour opens the ⋮ dial to
// show the controls inside it. A step whose button isn't on screen (a
// listener has no Share button, only moderators have the door lock…) is
// skipped automatically, in whichever direction you were going.
//
// WHEN it plays (once per device, then from the "?" button) is useTour.js.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const PAD = 6; // spotlight padding around the button
const GAP = 12; // space between the spotlight and the card
const EDGE = 12; // keep the card this far from the screen edges
const SETTLE_MS = 450; // after `before()`, let things animate into place

// Where the button is on screen right now, or null if it isn't showing.
function rectOf(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
  return r;
}

/**
 * @param {object[]} props.steps    see the top of this file
 * @param {Function} props.onClose  finished or skipped
 */
export default function Tour({ steps, onClose }) {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1); // which way we're going, for skipping
  const [rect, setRect] = useState(null); // the current button's position
  const [card, setCard] = useState({ w: 300, h: 160 }); // the card's own size
  const cardRef = useRef(null);
  const nextRef = useRef(null);
  const step = steps[index];

  // Open a step: run its `before`, give the screen a moment to settle, then
  // find the button. Not there → skip on in the same direction (or finish).
  useEffect(() => {
    if (!step) return undefined;
    step.before?.();
    setRect(null);
    const t = setTimeout(() => {
      if (rectOf(step.target)) return;
      const next = index + dir;
      if (next >= 0 && next < steps.length) setIndex(next);
      else if (dir > 0) onClose();
      else setDir(1); // nothing before this one — stay and go forward
    }, SETTLE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, dir]);

  // Follow the button while the step is open (animations, resizing, the
  // phone's keyboard / toolbar moving things) — a light poll is simplest.
  // Keyed on the step's SELECTOR, not the step object: the call screen
  // rebuilds its step list on every render (several times a second), and a
  // new object each time would restart this before it ever found the button.
  const target = step?.target;
  useEffect(() => {
    if (!target) return undefined;
    const update = () => {
      const r = rectOf(target);
      setRect((old) =>
        r &&
        old &&
        Math.abs(old.left - r.left) < 1 &&
        Math.abs(old.top - r.top) < 1 &&
        Math.abs(old.width - r.width) < 1 &&
        Math.abs(old.height - r.height) < 1
          ? old
          : r,
      );
    };
    const first = setTimeout(update, SETTLE_MS);
    const timer = setInterval(update, 200);
    window.addEventListener('resize', update);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('resize', update);
    };
  }, [target]);

  // Measure the card (its height changes with each step's text), so it can
  // be placed where it fits on screen.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setCard({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Next gets the focus on each step, for keyboard users.
  useEffect(() => {
    if (rect) nextRef.current?.focus({ preventScroll: true });
  }, [index, rect]);

  const go = (d) => {
    const next = index + d;
    if (next >= steps.length) return onClose();
    if (next < 0) return;
    setDir(d);
    setIndex(next);
  };

  // Keyboard: → / Enter next, ← back, Esc skip.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Where the card goes: below the button if it fits, otherwise above it;
  // centred on it sideways, but never off the screen.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let pos = { left: (vw - card.w) / 2, top: (vh - card.h) / 2 };
  if (rect) {
    const below = rect.bottom + PAD + GAP;
    const above = rect.top - PAD - GAP - card.h;
    const top = below + card.h <= vh - EDGE || above < EDGE ? below : above;
    const left = rect.left + rect.width / 2 - card.w / 2;
    pos = {
      left: Math.min(Math.max(EDGE, left), vw - card.w - EDGE),
      top: Math.min(Math.max(EDGE, top), vh - card.h - EDGE),
    };
  }

  // "3 of 10". The callers only pass the steps that apply to this person
  // (host vs listener, phone features…), so the count is right; skipping a
  // missing button above is just a safety net.
  const total = steps.length;

  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {/* Blocks clicks on the call while the tour runs. */}
      <div className="tour-block" />
      {/* The spotlight: a see-through box over the button whose huge shadow
          dims everything else. Before the button is found, it's a dot in the
          middle of the screen (so the dimming fades in smoothly). */}
      <div
        className="tour-spot"
        style={
          rect
            ? {
                left: rect.left - PAD,
                top: rect.top - PAD,
                width: rect.width + PAD * 2,
                height: rect.height + PAD * 2,
              }
            : { left: vw / 2, top: vh / 2, width: 0, height: 0 }
        }
      />
      {step && (
        <div
          ref={cardRef}
          className={`tour-card${rect ? '' : ' waiting'}`}
          style={{ left: pos.left, top: pos.top }}
          aria-live="polite"
        >
          <span className="tour-count">
            {index + 1} of {total}
          </span>
          <h2 id="tour-title" className="tour-title">
            {step.title}
          </h2>
          <p className="tour-text">{step.text}</p>
          <div className="tour-actions">
            <button type="button" className="tour-skip" onClick={onClose}>
              Skip
            </button>
            <span className="tour-nav">
              {index > 0 && (
                <button type="button" className="tour-back" onClick={() => go(-1)}>
                  Back
                </button>
              )}
              <button type="button" className="tour-next" onClick={() => go(1)} ref={nextRef}>
                {index === total - 1 ? 'Got it' : 'Next'}
              </button>
            </span>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
