// "Are you still there?" — Google-Meet style. Shown when you've been the only
// one in the meeting for a while (CallView decides when). Stay keeps you in;
// Leave, or no answer before the countdown runs out, takes you out of the
// call (to the usual "You left the meeting — Rejoin" screen), so a
// forgotten tab doesn't keep the camera and mic running for nobody.
//
// While it's up, the browser tab's title says so too, so it's noticed even
// from another tab.
//
// Looks like the in-app confirm dialog (same .confirm-* styles).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * @param {object}   props
 * @param {number}   props.seconds  countdown before leaving automatically
 * @param {Function} props.onStay
 * @param {Function} props.onLeave  also called when the countdown runs out
 */
export default function AloneReminder({ seconds, onStay, onLeave }) {
  const [left, setLeft] = useState(seconds);

  // Focus Stay once when it opens (not on every tick of the countdown).
  const stayRef = useRef(null);
  useEffect(() => stayRef.current?.focus(), []);

  // Count down from a fixed deadline, so a tab in the background (where
  // browsers slow timers down) still leaves on time.
  useEffect(() => {
    const deadline = Date.now() + seconds * 1000;
    const timer = setInterval(() => {
      setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(timer);
  }, [seconds]);

  // Nobody answered: leave.
  useEffect(() => {
    if (left === 0) onLeave();
  }, [left, onLeave]);

  // Say it in the tab title too; put the old title back afterwards.
  useEffect(() => {
    const before = document.title;
    document.title = 'Are you still there? · Listen';
    return () => {
      document.title = before;
    };
  }, []);

  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');

  return createPortal(
    <div className="confirm-backdrop">
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alone-title"
        aria-describedby="alone-msg"
      >
        <h2 id="alone-title" className="confirm-title">
          Are you still there?
        </h2>
        <p id="alone-msg" className="confirm-msg">
          You’ve been the only one here for a while. You’ll leave the call in{' '}
          <strong>
            {mm}:{ss}
          </strong>{' '}
          unless you choose to stay.
        </p>
        <div className="confirm-actions">
          <button type="button" className="confirm-btn cancel" onClick={onLeave}>
            Leave
          </button>
          {/* Stay is the safe choice — it gets the focus. */}
          <button type="button" className="confirm-btn primary" onClick={onStay} ref={stayRef}>
            Stay
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
