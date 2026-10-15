// The red "● Recording 12:34" sign everyone in the call sees while the
// meeting is being recorded (desktop top bar, phone header). Tap it for the
// recording's link: open it, or copy it to send to someone.

import { useEffect, useRef, useState } from 'react';
import { recordingLink } from './meeting.js';

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/**
 * @param {object}  props.recording  the snapshot's `recording` ({ id, startedAt })
 * @param {boolean} [props.compact]  phones: just "● 12:34"
 * @param {boolean} [props.dotOnly]  phones with a full header: just the dot
 */
export default function RecBadge({ recording, compact = false, dotOnly = false }) {
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Tap anywhere else (or Esc) closes the little card.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const link = recordingLink(recording.id);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy the recording link:', link);
    }
  }

  const elapsed = clock(now - recording.startedAt);
  return (
    <span className="rec-badge-wrap" ref={rootRef}>
      <button
        type="button"
        className={`rec-badge${compact || dotOnly ? ' compact' : ''}${dotOnly ? ' dot-only' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`This meeting is being recorded, ${elapsed}. Show the recording link`}
        title="This meeting is being recorded"
      >
        <span className="rec-dot" aria-hidden="true" />
        {dotOnly ? null : compact ? elapsed : `Recording ${elapsed}`}
      </button>
      {open && (
        <div className="rec-card" role="dialog" aria-label="Recording">
          <p>
            This meeting is being recorded. Everyone in the call can watch it until a day after the
            meeting ends. After that it’s deleted.
          </p>
          <div className="rec-card-actions">
            <a className="rec-card-btn" href={link} target="_blank" rel="noreferrer">
              Open
            </a>
            <button type="button" className="rec-card-btn primary" onClick={copy}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
