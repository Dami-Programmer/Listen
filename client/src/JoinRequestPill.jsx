// "Request to join": the host's (and co-host's) alert when someone knocks at
// a locked meeting — on computers and phones alike.
//
//   [photo]  Request to join        (✕) (✓)
//            Andrew Nelson
//
// A dark pill at the top centre of the screen. It SLIDES DOWN from above the
// top edge when someone knocks, and SLIDES BACK UP once you let them in (✓)
// or turn them away (✕) — or another moderator does, or they give up. If
// someone else is waiting too, their pill slides down after.
//
// It's drawn straight into <body> (a portal), not inside the call screen, so
// nothing in the call screen's layout can clip it or shift where "the top
// centre of the screen" is. The look and the motion are in index.css
// ("join request pill").

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar.jsx';
import { Check, X } from './icons.jsx';

/**
 * @param {object|null} props.knocker  the first person waiting ({ id, name, avatar }), or null
 * @param {number}      props.extra    how many more are waiting behind them
 * @param {Function}    props.onAdmit  (socketId) => void
 * @param {Function}    props.onDeny   (socketId) => void
 */
export default function JoinRequestPill({ knocker: incoming, extra, onAdmit, onDeny }) {
  const [shown, setShown] = useState(incoming); // who's on screen right now
  const [leaving, setLeaving] = useState(false); // sliding back up
  // Whoever we just let in / turned away: ignored until the server's update
  // arrives, so the pill doesn't slide back down for them in between.
  const [handled, setHandled] = useState(null);
  const knocker = incoming?.id === handled ? null : incoming;

  // The door changed under us (someone else answered, they gave up, or a
  // first knock): slide the current one up, or slide the new one down.
  if (!leaving && knocker?.id !== shown?.id) {
    if (shown) setLeaving(true);
    else setShown(knocker);
  }

  // Safety net: browsers PAUSE animations in a background tab, so the
  // slide-up might never report that it finished — and the next person's
  // pill would never come. A timer a little longer than the slide (0.6s,
  // index.css) finishes the swap anyway. Normally the animation wins.
  const finishRef = useRef(null);
  finishRef.current = finishLeaving;
  useEffect(() => {
    if (!leaving) return undefined;
    const t = setTimeout(() => finishRef.current(), 900);
    return () => clearTimeout(t);
  }, [leaving]);

  if (!shown) return null;

  // ✓ / ✕: answer, and slide up at once rather than waiting for the server.
  function answer(fn) {
    fn(shown.id);
    setHandled(shown.id);
    setLeaving(true);
  }

  // The slide-up finished: show whoever's next (or nothing). (Leaving runs two
  // animations — the slide up and a shorter fade out; wait for the slide.)
  function onAnimationEnd(e) {
    if (!leaving || e.target !== e.currentTarget || e.animationName !== 'jr-slide-up') return;
    finishLeaving();
  }
  function finishLeaving() {
    setLeaving(false);
    setShown(knocker);
  }

  return createPortal(
    <div
      key={shown.id /* a new person = a fresh slide-down */}
      className={`jr-pill${leaving ? ' leaving' : ''}`}
      role="status"
      aria-live="polite"
      onAnimationEnd={onAnimationEnd}
    >
      <Avatar name={shown.name} src={shown.avatar} size={38} className="jr-avatar" />
      <span className="jr-text">
        <small>
          Request to join
          {extra > 0 && !leaving && <em> · +{extra} waiting</em>}
        </small>
        <b>{shown.name}</b>
      </span>
      <button
        type="button"
        className="jr-btn jr-deny"
        aria-label={`Turn ${shown.name} away`}
        title="Turn away"
        disabled={leaving}
        onClick={() => answer(onDeny)}
      >
        <X />
      </button>
      <button
        type="button"
        className="jr-btn jr-admit"
        aria-label={`Let ${shown.name} in`}
        title="Let in"
        disabled={leaving}
        onClick={() => answer(onAdmit)}
      >
        <Check />
      </button>
    </div>,
    document.body,
  );
}
