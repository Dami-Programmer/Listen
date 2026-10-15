// "Schedule a meeting" (from the home screen): plan a meeting for later.
//
// Step 1: name, date, time, length — and where: a new meeting link, or one of
//         your permanent links (roomNames.js).
// Step 2: done — copy the invite (for WhatsApp / text / email), add it to a
//         calendar (Google, or an .ics file for iPhone / Outlook — with a
//         reminder 10 minutes before), and, for a new link, the private host
//         link. Whoever schedules is the host: guests who arrive early wait.

import { useEffect, useState } from 'react';
import { SIGNALING_URL } from './socket.js';
import { Copy, Check, X } from './icons.jsx';
import { inviteLink } from './meeting.js';
import { hostKeyFor, ownedNames, saveHostKey } from './roomNames.js';
import { downloadIcs, googleCalendarUrl, inviteText, whenText } from './calendar.js';

const LENGTHS = [30, 45, 60, 90, 120, 180]; // minutes
const pad = (n) => String(n).padStart(2, '0');

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

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-card claim-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sched-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="report-head">
          <h2 id="sched-title" className="confirm-title">
            {done ? 'Meeting scheduled' : 'Schedule a meeting'}
          </h2>
          <button type="button" className="report-x" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>

        {!done ? (
          <form className="claim-form" onSubmit={schedule}>
            <label className="poll-label">
              Meeting name
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
              <label className="poll-label">
                Date
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className="poll-label">
                Time
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
              <label className="poll-label">
                Length
                <select value={length} onChange={(e) => setLength(Number(e.target.value))}>
                  {LENGTHS.map((m) => (
                    <option key={m} value={m}>
                      {m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ' 30' : ''}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {names.length > 0 && (
              <label className="poll-label">
                Where
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
            <button type="submit" className="qa-send claim-go" disabled={busy}>
              {busy ? 'Scheduling…' : 'Schedule'}
            </button>
          </form>
        ) : (
          <div className="claim-form">
            <p className="sched-summary">
              <b>{event.title}</b>
              <span>
                {whenText(event.startsAt)} · {event.durationMin} min
              </span>
              <a href={event.link}>{event.link}</a>
            </p>
            <div className="sched-actions">
              <CopyButton value={inviteText(event)} label="Copy invite" />
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
              Send the invite to everyone. Adding it to a calendar reminds them 10 minutes before.
              You’re the host. Guests who arrive early wait for you.
            </p>
            {done.hostKey && (
              <div className="claim-link">
                <span className="claim-link-label">Your private host link</span>
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
                  Saved on this device. To host from another device, open this link there once.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
