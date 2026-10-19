// Breakout rooms (see EVENTS.BREAKOUT_*):
//
//   <BreakoutPanel />   the host / co-host's pop-up. Before: how many rooms,
//                       how long, and who goes where — "Shuffle for me" or
//                       "I'll choose" (a Room drop-down per person). While
//                       they run: who's in each room with "Move to…" for
//                       each person, the people still in the main room (late
//                       joiners, or left out) with the same drop-down,
//                       "Message all rooms", "End now".
//   <BreakoutBanner />  the line at the top: in a breakout room, "Room 2 · back
//                       to the main room in 4:12"; in the main room, "Breakout
//                       rooms running · 4:12 left" (+ Manage for moderators,
//                       with a dot when someone in the main room has no room).

import { useEffect, useState } from 'react';
import { EVENTS } from '@listen/shared';
import { socket } from './socket.js';
import { People, X } from './icons.jsx';
import TabSwap from './TabSwap.jsx';

const LENGTHS = [5, 10, 15, 20, 30, 45, 60, 0]; // minutes; 0 = until ended
const MAX_ROOMS = 20; // the server's BREAKOUT_MAX_ROOMS
const MAIN = -1; // "the main room" in a Room drop-down

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// A ticking "4:12 left", or null without an end time.
function useLeft(endsAt) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!endsAt) return undefined;
    setNow(Date.now()); // fresh right away, not from when the page opened
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endsAt]);
  return endsAt ? clock(endsAt - now) : null;
}

// People in the main room who'd go to (or could be sent to) a room:
// everyone but the host and co-host.
function roomless(state) {
  return (state?.participants ?? []).filter(
    (p) => p.id !== state?.hostId && p.id !== state?.cohostId,
  );
}

// "Room 1 … Room N" + "Main room" as <option>s (values: index, or MAIN).
function RoomOptions({ count }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <option key={i} value={i}>
          Room {i + 1}
        </option>
      ))}
      <option value={MAIN}>Main room</option>
    </>
  );
}

// One person with a Room drop-down.
function PersonRow({ name, value, count, onChange, label }) {
  return (
    <li className="bo-person">
      <span className="bo-name">{name}</span>
      <select
        value={value ?? ''} // "" = the "Move to…" prompt (no room yet)
        aria-label={label ?? `Room for ${name}`}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {value === null && (
          <option value="" disabled>
            Move to…
          </option>
        )}
        <RoomOptions count={count} />
      </select>
    </li>
  );
}

/**
 * @param {object}   props.state     room snapshot (main room)
 * @param {Function} props.onClose
 */
export function BreakoutPanel({ state, onClose }) {
  const running = state?.breakouts;
  const people = roomless(state);
  const others = people.length;
  const [rooms, setRooms] = useState(() =>
    Math.min(MAX_ROOMS, Math.max(2, Math.round(others / 4))),
  );
  const [minutes, setMinutes] = useState(10);
  const [choose, setChoose] = useState(false); // "I'll choose" vs shuffle
  // The host's picks: { personId: room index or MAIN }. Anyone not picked
  // yet is shown spread across the rooms in turn (pickOf).
  const [picks, setPicks] = useState({});
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const left = useLeft(running?.endsAt);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const emit = (event, payload, then) =>
    socket.emit(event, payload, (ack) => {
      if (!ack?.ok) setError(ack?.error || 'Something went wrong. Try again.');
      else {
        setError(null);
        then?.();
      }
    });

  // Someone's room: what the host picked (if that room still exists), else
  // the next room in turn.
  const pickOf = (id, i) => {
    const k = picks[id];
    if (k === MAIN || (Number.isInteger(k) && k < rooms)) return k;
    return i % rooms;
  };

  const start = (e) => {
    e.preventDefault();
    setError(null);
    const payload = { rooms, minutes };
    if (choose) {
      payload.assign = {};
      people.forEach((p, i) => {
        const k = pickOf(p.id, i);
        if (k !== MAIN) payload.assign[p.id] = k;
      });
    }
    emit(EVENTS.BREAKOUT_START, payload, onClose);
  };

  const move = (id, to) => emit(EVENTS.BREAKOUT_MOVE, { id, to });

  // Shuffle needs 2 people to make it worth it; choosing needs just 1.
  const enough = choose ? others >= 1 : others >= 2;
  const roomChoices = choose ? MAX_ROOMS : Math.max(1, Math.min(MAX_ROOMS, others));
  const perRoom = others / rooms;

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-card claim-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bo-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* icon tile · title + one grey line · round ✕ */}
        <div className="report-head dlg-head">
          <span className="dlg-icon" aria-hidden="true">
            <People />
          </span>
          <div className="dlg-head-text">
            <h2 id="bo-title" className="confirm-title">
              Breakout rooms
            </h2>
            <p className="dlg-sub">
              {running ? 'Rooms are running.' : 'Split the meeting into small groups.'}
            </p>
          </div>
          <button type="button" className="report-x" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>

        {!running ? (
          <form className="claim-form" onSubmit={start}>
            {/* Shuffle for me / I'll choose */}
            <div
              className="cp-tabs bo-mode"
              role="tablist"
              // the sliding highlight (see .cp-tabs::before)
              style={{ '--n': 2, '--i': choose ? 1 : 0 }}
            >
              {[
                [false, 'Shuffle for me'],
                [true, 'I’ll choose'],
              ].map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  role="tab"
                  aria-selected={choose === value}
                  className={`cp-tab${choose === value ? ' on' : ''}`}
                  onClick={() => {
                    setChoose(value);
                    if (!value) setRooms((r) => Math.min(r, Math.max(1, others)));
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="confirm-msg">
              {choose
                ? 'Pick a room for each person. Anyone you leave in the main room stays with you.'
                : `Everyone except you${state?.cohostId ? ' and your cohost' : ''} is shuffled at random into small rooms, then brought back automatically.`}
            </p>
            {!enough ? (
              <p className="qa-error">
                {choose
                  ? 'There’s no one else in the meeting yet.'
                  : 'You need at least 2 other people in the meeting.'}
              </p>
            ) : (
              <>
                <div className="sched-row bo-row">
                  <label className="poll-label field">
                    <span>Rooms</span>
                    <select value={rooms} onChange={(e) => setRooms(Number(e.target.value))}>
                      {Array.from({ length: roomChoices }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="poll-label field">
                    <span>For</span>
                    <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                      {LENGTHS.map((m) => (
                        <option key={m} value={m}>
                          {m ? `${m} minutes` : 'Until I end them'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {/* the list / the hint slide in when switching (TabSwap) */}
                <TabSwap tab={choose ? 'choose' : 'shuffle'} order={['shuffle', 'choose']}>
                  {choose ? (
                    <ul className="bo-people">
                      {people.map((p, i) => (
                        <PersonRow
                          key={p.id}
                          name={p.name}
                          value={pickOf(p.id, i)}
                          count={rooms}
                          onChange={(k) => setPicks((all) => ({ ...all, [p.id]: k }))}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="claim-link-hint">
                      {others} people → about {Math.floor(perRoom)}
                      {perRoom % 1 ? ` to ${Math.ceil(perRoom)}` : ''} per room.
                    </p>
                  )}
                </TabSwap>
                {error && <p className="qa-error">{error}</p>}
                <div className="dlg-foot">
                  <button type="button" className="confirm-btn cancel" onClick={onClose}>
                    Cancel
                  </button>
                  <button type="submit" className="qa-send claim-go">
                    Start breakout rooms
                  </button>
                </div>
              </>
            )}
          </form>
        ) : (
          <div className="claim-form">
            <p className="confirm-msg">
              {left ? `Everyone comes back in ${left}.` : 'Running until you end them.'}
            </p>
            <div className="bo-rooms">
              {/* In the main room without a room: late joiners, or left out */}
              {people.length > 0 && (
                <section className="bo-room bo-waiting">
                  <b>Main room: not in a room yet</b>
                  <ul className="bo-people">
                    {people.map((p) => (
                      <PersonRow
                        key={p.id}
                        name={p.name}
                        value={null}
                        count={running.rooms.length}
                        label={`Move ${p.name} to a room`}
                        onChange={(k) => move(p.id, k)}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {running.rooms.map((r, i) => (
                <section key={r.id} className="bo-room">
                  <b>{r.name}</b>
                  {r.people.length ? (
                    <ul className="bo-people">
                      {r.people.map((p) => (
                        <PersonRow
                          key={p.id}
                          name={p.name}
                          value={i}
                          count={running.rooms.length}
                          label={`Move ${p.name}`}
                          onChange={(k) => k !== i && move(p.id, k)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <span className="bo-empty">empty</span>
                  )}
                </section>
              ))}
            </div>
            <form
              className="qa-ask"
              onSubmit={(e) => {
                e.preventDefault();
                if (!message.trim()) return;
                emit(EVENTS.BREAKOUT_MESSAGE, { text: message.trim() }, () => {
                  setMessage('');
                  setSent(true);
                  setTimeout(() => setSent(false), 2000);
                });
              }}
            >
              <textarea
                rows={1}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Message all rooms…"
                aria-label="Message all rooms"
                maxLength={300}
              />
              <button type="submit" className="qa-send">
                {sent ? 'Sent' : 'Send'}
              </button>
            </form>
            {error && <p className="qa-error">{error}</p>}
            <button
              type="button"
              className="qa-act bo-end"
              onClick={() => emit(EVENTS.BREAKOUT_END, {}, onClose)}
            >
              End now and bring everyone back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * @param {object}   props.state        room snapshot
 * @param {Function} [props.onManage]   moderators: open the panel
 */
export function BreakoutBanner({ state, onManage }) {
  const here = state?.breakout; // in a breakout room
  const main = state?.breakouts; // in the main room while they run
  const left = useLeft(here?.endsAt ?? main?.endsAt);
  if (here) {
    return (
      <div className="bo-banner" role="status">
        🧩 <b>{here.name}</b>
        {left ? ` · back to the main room in ${left}` : ' · the host will bring you back'}
      </div>
    );
  }
  if (main) {
    // Someone joined late (or was left out) and has no room yet.
    const waiting = roomless(state).length;
    return (
      <div className="bo-banner" role="status">
        🧩 Breakout rooms running · {main.rooms.length} rooms{left ? ` · ${left} left` : ''}
        {onManage && (
          <button type="button" className="bo-manage" onClick={onManage}>
            Manage
            {waiting > 0 && (
              <span className="bo-dot" title={`${waiting} not in a room`}>
                {waiting}
              </span>
            )}
          </button>
        )}
      </div>
    );
  }
  return null;
}
