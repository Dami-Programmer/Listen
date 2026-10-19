// "Schedule a meeting" (from the home screen): plan a meeting for later.
//
// Step 1: name, date, time, length — and where: a new meeting link, or one of
//         your permanent links (roomNames.js).
// Step 2: done — copy the invite (for WhatsApp / text / email), add it to a
//         calendar (Google, or an .ics file for iPhone / Outlook — with a
//         reminder 10 minutes before), and, for a new link, the private host
//         link. Whoever schedules is the host: guests who arrive early wait.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SIGNALING_URL } from './socket.js';
import { Calendar, Copy, Check, Lock, X } from './icons.jsx';
import { inviteLink } from './meeting.js';
import { hostKeyFor, ownedNames, saveHostKey } from './roomNames.js';
import { downloadIcs, googleCalendarUrl, inviteText, whenText } from './calendar.js';

const LENGTHS = [30, 45, 60, 90, 120, 180]; // minutes
const pad = (n) => String(n).padStart(2, '0');
// 30 → "30 min", 60 → "1 h", 90 → "1 h 30", 180 → "3 h"
const lengthLabel = (m) =>
  m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}`;

// The private host link: the room's link + its host key.
function hostLinkOf(room, key) {
  const url = new URL(inviteLink(room));
  url.searchParams.set('key', key);
  return url.href;
}

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy:', value);
    }
  }
  return (
    <button type="button" className="claim-copy" onClick={copy}>
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * @param {Function} props.onClose
 * @param {string}  [props.defaultTitle]
 */
export default function ScheduleMeeting({ onClose, defaultTitle = '' }) {
  // Default: tomorrow, at the next full hour.
  const [date, setDate] = useState(() => {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const [time, setTime] = useState(() => `${pad((new Date().getHours() + 1) % 24)}:00`);
  const [title, setTitle] = useState(defaultTitle);
  const [length, setLength] = useState(60);
  const names = ownedNames();
  const [where, setWhere] = useState(''); // '' = a new meeting link
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // { room, hostKey, startsAt, durationMin, title }

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function schedule(e) {
    e.preventDefault();
    if (!title.trim()) return setError('Give the meeting a name.');
    const startsAt = new Date(`${date}T${time}`).getTime();
    if (!Number.isFinite(startsAt)) return setError('Pick a date and time.');
    if (startsAt < Date.now() - 5 * 60000) return setError('That time has already passed.');
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${SIGNALING_URL}/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          startsAt,
          durationMin: length,
          ...(where ? { name: where, hostKey: hostKeyFor(where) } : {}),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || 'Couldn’t schedule it. Try again.');
      if (data.hostKey) saveHostKey(data.room, data.hostKey); // you're the host
      setDone({
        room: data.room,
        hostKey: data.hostKey,
        startsAt,
        durationMin: length,
        title: title.trim(),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  const event = done && { ...done, link: inviteLink(done.room) };

  // Drawn straight onto the page (a portal), not inside the lobby: the
  // lobby's rise-in animation would otherwise shrink the full-screen dark
  // backdrop to the lobby's own box.
  return createPortal(
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-card claim-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sched-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* icon tile · title + one grey line · round ✕ */}
        <div className="report-head dlg-head">
          <span className={`dlg-icon${done ? ' ok' : ''}`} aria-hidden="true">
            {done ? <Check /> : <Calendar />}
          </span>
          <div className="dlg-head-text">
            <h2 id="sched-title" className="confirm-title">
              {done ? 'Meeting scheduled' : 'Schedule a meeting'}
            </h2>
            <p className="dlg-sub">
              {done
                ? 'Send the invite to everyone coming.'
                : 'Pick a time. You’ll get an invite to share.'}
            </p>
          </div>
          <button type="button" className="report-x" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>

        {!done ? (
          <form className="claim-form" onSubmit={schedule}>
            <label className="poll-label field">
              <span>Meeting name</span>
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setError(null);
                }}
                placeholder="Sunday service"
                maxLength={80}
                autoFocus
              />
            </label>
            <div className="sched-row">
              <label className="poll-label field">
                <span>Date</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="poll-label field">
                <span>Time</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            </div>
            {/* Length: one tap on a segmented row instead of a dropdown */}
            <div className="field-group">
              <span className="field-group-label" id="sched-length">
                Length
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="sched-length">
                {LENGTHS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={length === m}
                    className={length === m ? 'on' : ''}
                    onClick={() => setLength(m)}
                  >
                    {lengthLabel(m)}
                  </button>
                ))}
              </div>
            </div>
            {names.length > 0 && (
              <label className="poll-label field">
                <span>Where</span>
                <select value={where} onChange={(e) => setWhere(e.target.value)}>
                  <option value="">A new meeting link</option>
                  {names.map((n) => (
                    <option key={n} value={n}>
                      Your link: {window.location.host}/{n}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && <p className="qa-error">{error}</p>}
            {/* Cancel + Schedule, right-aligned under a thin line */}
            <div className="dlg-foot">
              <button type="button" className="confirm-btn cancel" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="qa-send claim-go" disabled={busy}>
                {busy ? 'Scheduling…' : 'Schedule'}
              </button>
            </div>
          </form>
        ) : (
          <div className="claim-form">
            {/* the meeting at a glance: a little calendar tile, the name and
                time, then the link with "Copy invite" beside it */}
            <div className="sched-summary">
              <div className="sched-sum-top">
                <span className="sched-date" aria-hidden="true">
                  <small>
                    {new Date(event.startsAt).toLocaleString(undefined, { month: 'short' })}
                  </small>
                  <b>{new Date(event.startsAt).getDate()}</b>
                </span>
                <span className="sched-sum-text">
                  <b>{event.title}</b>
                  <span>
                    {whenText(event.startsAt)} · {lengthLabel(event.durationMin)}
                  </span>
                </span>
              </div>
              <div className="sched-sum-link">
                <a href={event.link}>{event.link.replace(/^https?:\/\//, '')}</a>
                <CopyButton value={inviteText(event)} label="Copy invite" />
              </div>
            </div>
            <div className="sched-actions">
              <a
                className="claim-copy"
                href={googleCalendarUrl(event)}
                target="_blank"
                rel="noreferrer"
              >
                Google Calendar
              </a>
              <button type="button" className="claim-copy" onClick={() => downloadIcs(event)}>
                Calendar file (.ics)
              </button>
            </div>
            <p className="claim-link-hint">
              Adding it to a calendar reminds people 10 minutes before. You’re the host. Guests who
              arrive early wait for you.
            </p>
            {done.hostKey && (
              <div className="claim-link private">
                <span className="claim-link-label">
                  <Lock /> Your private host link
                </span>
                <div className="claim-link-row">
                  <input
                    value={hostLinkOf(done.room, done.hostKey)}
                    readOnly
                    onFocus={(e) => e.target.select()}
                    aria-label="Your private host link"
                  />
                  <CopyButton value={hostLinkOf(done.room, done.hostKey)} label="Copy" />
                </div>
                <span className="claim-link-hint">
                  Keep it to yourself: whoever opens it is the host. Saved on this device. To host
                  from another device, open this link there once.
                </span>
              </div>
            )}
            <div className="dlg-foot">
              <button type="button" className="qa-send" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
