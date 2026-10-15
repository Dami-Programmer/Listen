// The recording page (?rec=<id>) — watch or download a meeting's recording.
//
// A recording can be in several PARTS: whenever the person recording left,
// someone else carried on (see EVENTS.REC_START). They play back to back here,
// one after another, with a list to jump between them and download each.
// While the meeting is still being recorded, the page says so and checks
// again every so often; finished parts can already be watched.
// It's all fetched from our server (it streams from R2 storage).

import { useEffect, useState } from 'react';
import Logo from './Logo.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { Download } from './icons.jsx';
import { SIGNALING_URL } from './socket.js';

// While still recording, look for new parts this often.
const POLL_MS = 15_000;
// The free server may be asleep: say so if it takes this long to answer.
const SLOW_MS = 4000;

const minutes = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const timeLeft = (ms) => {
  const h = Math.floor(ms / 3600000);
  return h >= 1
    ? `${h} hour${h === 1 ? '' : 's'}`
    : `${Math.max(1, Math.round(ms / 60000))} minutes`;
};

export default function RecordingPage({ id }) {
  const [info, setInfo] = useState(null); // the server's answer
  const [error, setError] = useState(null); // 'gone' | 'failed'
  const [slow, setSlow] = useState(false);
  const [current, setCurrent] = useState(0); // index into info.parts
  const [autoplay, setAutoplay] = useState(false);

  // Load it (and, while it's still being recorded, keep checking).
  useEffect(() => {
    let stop = false;
    let timer = null;
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    async function load() {
      try {
        const res = await fetch(`${SIGNALING_URL}/recordings/${encodeURIComponent(id)}`);
        if (stop) return;
        if (res.status === 404 || res.status === 410) {
          setError('gone');
          return;
        }
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        setInfo(data);
        setError(null);
        if (data.recording) timer = setTimeout(load, POLL_MS);
      } catch {
        if (stop) return;
        setError((e) => e ?? 'failed');
        timer = setTimeout(load, POLL_MS);
      } finally {
        clearTimeout(slowTimer);
        setSlow(false);
      }
    }
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
      clearTimeout(slowTimer);
    };
  }, [id]);

  useEffect(() => {
    document.title = info?.title ? `Recording · ${info.title} · Turnly` : 'Recording · Turnly';
  }, [info?.title]);

  const parts = info?.parts ?? [];
  const part = parts[current];
  const partUrl = (p, download = false) =>
    `${SIGNALING_URL}/recordings/${encodeURIComponent(id)}/parts/${p.n}${download ? '?download=1' : ''}`;

  // One part finished playing: on to the next.
  function onEnded() {
    if (current < parts.length - 1) {
      setAutoplay(true);
      setCurrent(current + 1);
    }
  }

  let body;
  if (error === 'gone') {
    body = (
      <div className="recp-msg">
        <h1>This recording isn’t available</h1>
        <p>
          Recordings are deleted a day after the meeting ends. This one is gone, or the link is
          wrong.
        </p>
      </div>
    );
  } else if (!info) {
    body = (
      <div className="recp-msg">
        <p>
          {slow ? 'Waking up the server. This can take up to a minute…' : 'Loading the recording…'}
        </p>
        {error === 'failed' && <p className="err">Couldn’t reach the server. Trying again…</p>}
      </div>
    );
  } else {
    const when = new Date(info.startedAt);
    body = (
      <>
        <header className="recp-head">
          <h1>{info.title || 'Meeting recording'}</h1>
          <p className="recp-sub">
            {when.toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })}{' '}
            at {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            {info.endedAt && ` · ${minutes(info.endedAt - info.startedAt)}`}
            {info.expiresAt && ` · deleted in ${timeLeft(info.expiresAt - Date.now())}`}
          </p>
          {info.recording && (
            <p className="recp-live">
              <span className="rec-dot" aria-hidden="true" /> Still recording. Parts appear here as
              they’re saved.
            </p>
          )}
        </header>

        {part ? (
          <video
            key={part.n}
            className="recp-video"
            src={partUrl(part)}
            controls
            playsInline
            autoPlay={autoplay}
            onEnded={onEnded}
          />
        ) : (
          <div className="recp-empty">
            {info.recording
              ? 'The first part will be ready when the person recording leaves, or when recording stops.'
              : 'Nothing was recorded.'}
          </div>
        )}

        {parts.length > 0 && (
          <ol className="recp-parts">
            {parts.map((p, i) => (
              <li key={p.n} className={i === current ? 'on' : ''}>
                <button
                  type="button"
                  className="recp-part"
                  onClick={() => {
                    setAutoplay(true);
                    setCurrent(i);
                  }}
                >
                  {parts.length > 1 ? `Part ${i + 1}` : 'Recording'}
                  <span>{minutes(p.endedAt - p.startedAt)}</span>
                </button>
                <a
                  className="recp-dl"
                  href={partUrl(p, true)}
                  aria-label={`Download part ${i + 1}`}
                >
                  <Download /> Download
                </a>
              </li>
            ))}
          </ol>
        )}
        {parts.length > 1 && (
          <p className="recp-note">
            The recording is in {parts.length} parts because the person recording changed during the
            meeting. They play one after another.
          </p>
        )}
      </>
    );
  }

  return (
    <main className="recp">
      <div className="recp-top">
        <a href={window.location.pathname} aria-label="Turnly home">
          <Logo />
        </a>
        <ThemeToggle />
      </div>
      <section className="recp-card">{body}</section>
    </main>
  );
}
