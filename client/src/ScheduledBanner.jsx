// On the lobby of a scheduled meeting's link: "📅 Scheduled · Sun 19 Oct,
// 4:00 PM · starts in 2 days", with buttons to add it to a calendar. Shows
// nothing for an ordinary room.

import { useEffect, useState } from 'react';
import { SIGNALING_URL } from './socket.js';
import { inviteLink } from './meeting.js';
import { downloadIcs, googleCalendarUrl, startsIn, whenText } from './calendar.js';

export default function ScheduledBanner({ roomId }) {
  const [info, setInfo] = useState(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!roomId) return undefined;
    let stop = false;
    fetch(`${SIGNALING_URL}/names/${encodeURIComponent(roomId.toLowerCase())}/info`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => !stop && data?.startsAt && setInfo(data))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [roomId]);

  // Keep "starts in …" fresh.
  useEffect(() => {
    if (!info) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [info]);

  if (!info) return null;
  const ends = info.startsAt + info.durationMin * 60000;
  if (Date.now() > ends) return null; // over
  const soon = startsIn(info.startsAt);
  const event = { ...info, room: roomId, link: inviteLink(roomId) };
  return (
    <div className="sched-banner" role="status">
      <span className="sched-when">
        📅 {info.title ? <b>{info.title}</b> : 'Scheduled'} · {whenText(info.startsAt)}
        <em>{soon ? ` · starts ${soon}` : ' · happening now'}</em>
      </span>
      {soon && (
        <span className="sched-banner-actions">
          <a href={googleCalendarUrl(event)} target="_blank" rel="noreferrer">
            Google Calendar
          </a>
          <button type="button" onClick={() => downloadIcs(event)}>
            Calendar file
          </button>
        </span>
      )}
    </div>
  );
}
