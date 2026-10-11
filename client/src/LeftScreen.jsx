// "You left the meeting" — shown right after pressing Leave, Google-Meet
// style. For one minute there's a Rejoin button that puts you straight back
// in (no knocking, old role back — the server keeps a rejoin pass for that
// long, see EVENTS.RESUME). A ring counts the minute down; when it runs out,
// or on "Return to home screen", you go back to the lobby.
//
// Below it, a short review form: "How was your call?" — a written comment
// that's emailed to the app's owner (POST /feedback on the server), so they
// know what to improve in the look and feel. Typing a review holds the page:
// the countdown won't whisk you home halfway through a sentence (Rejoin
// still runs out on time, though).
//
// Your camera and mic are already off here: the call screen (and with it the
// camera) closed when you left.

import { useEffect, useState } from 'react';
import Logo from './Logo.jsx';
import { SIGNALING_URL } from './socket.js';
import useIsMobile from './useIsMobile.js';

const REVIEW_MAX = 2000; // same cap as the server

/**
 * @param {object}   props
 * @param {number}   props.seconds  how long Rejoin is offered
 * @param {boolean}  props.busy     the Rejoin request is on its way
 * @param {Function} props.onRejoin
 * @param {Function} props.onHome   called on "Return to home screen" AND when
 *                                  the countdown runs out (unless a review is
 *                                  being written)
 * @param {string}  [props.name]    who's writing — sent with the review
 * @param {string}  [props.meeting] the meeting they left — sent with it too
 */
export default function LeftScreen({ seconds, busy, onRejoin, onHome, name, meeting }) {
  const isMobile = useIsMobile();
  const [left, setLeft] = useState(seconds);

  // --- the review form ---------------------------------------------------
  const [review, setReview] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState(null);
  const writing = review.trim().length > 0 && status !== 'sent';

  // Tick once a second. The deadline is fixed when the screen opens, so a
  // tab that was in the background (where browsers slow timers down) still
  // shows the right number when you come back to it.
  useEffect(() => {
    const deadline = Date.now() + seconds * 1000;
    const timer = setInterval(() => {
      setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(timer);
  }, [seconds]);

  // Time's up: the rejoin pass is gone, so head home — unless they're in the
  // middle of a review (then they stay until they send it or leave).
  const timeUp = left === 0;
  useEffect(() => {
    if (timeUp && !busy && !writing && status !== 'sending' && status !== 'sent') onHome();
  }, [timeUp, busy, writing, status, onHome]);

  // Sent after the minute ran out: show the thank-you for a moment, then home.
  useEffect(() => {
    if (!(timeUp && status === 'sent')) return undefined;
    const t = setTimeout(onHome, 2500);
    return () => clearTimeout(t);
  }, [timeUp, status, onHome]);

  async function sendReview(e) {
    e.preventDefault();
    const comment = review.trim();
    if (!comment || status === 'sending') return;
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch(`${SIGNALING_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment,
          name,
          meeting,
          device: isMobile ? 'phone' : 'computer',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Couldn’t send — please try again.');
      setStatus('sent');
    } catch (err) {
      setStatus('error');
      setError(err.message || 'Couldn’t send — please try again.');
    }
  }

  // The ring empties as the minute runs out (SVG circle, 2πr ≈ 125.7).
  const CIRC = 2 * Math.PI * 20;
  const progress = left / seconds;

  return (
    <main className="left-screen">
      <Logo />
      <div className="left-card" aria-live="polite">
        <div className="left-ring" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="56" height="56">
            <circle cx="24" cy="24" r="20" className="left-ring-track" />
            <circle
              cx="24"
              cy="24"
              r="20"
              className="left-ring-bar"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - progress)}
            />
          </svg>
          <span>{left}</span>
        </div>
        <h1>You left the meeting</h1>
        <p>
          {timeUp
            ? 'The time to rejoin has passed.'
            : `Changed your mind? You can rejoin for the next ${left} second${left === 1 ? '' : 's'}.`}
        </p>
        <div className="left-actions">
          {!timeUp && (
            <button type="button" className="left-rejoin" onClick={onRejoin} disabled={busy}>
              {busy ? 'Rejoining…' : 'Rejoin'}
            </button>
          )}
          <button type="button" className="left-home" onClick={onHome} disabled={busy}>
            Return to home screen
          </button>
        </div>

        {/* The review. Once sent, the box turns into a thank-you. */}
        {status === 'sent' ? (
          <p className="left-thanks" role="status">
            Thanks for the feedback! 💙
          </p>
        ) : (
          <form className="left-review" onSubmit={sendReview}>
            <label htmlFor="left-review-text">How was your call?</label>
            <span className="left-review-hint">
              Tell us what to improve — anything about how it looks or how it works.
            </span>
            <textarea
              id="left-review-text"
              value={review}
              onChange={(e) => setReview(e.target.value)}
              placeholder="e.g. The buttons were hard to find on my phone…"
              maxLength={REVIEW_MAX}
              rows={4}
              disabled={status === 'sending'}
            />
            {error && <span className="left-review-err">{error}</span>}
            <button
              type="submit"
              className="left-review-send"
              disabled={!review.trim() || status === 'sending'}
            >
              {status === 'sending' ? 'Sending…' : 'Send feedback'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
