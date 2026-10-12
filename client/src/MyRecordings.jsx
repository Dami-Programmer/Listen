// "Your recordings" on the home screen: recent meetings recorded while you
// were in them (remembered in this browser — see myRecordings.js). Nothing
// shows when there are none.

import { useState } from 'react';
import { RecordIcon } from './icons.jsx';
import { recordingLink } from './meeting.js';
import { listRecordings } from './myRecordings.js';

export default function MyRecordings() {
  const [list] = useState(listRecordings);
  if (!list.length) return null;
  return (
    <section className="my-recs" aria-label="Your recordings">
      <h2>Your recordings</h2>
      <ul>
        {list.map((r) => (
          <li key={r.id}>
            <a href={recordingLink(r.id)} target="_blank" rel="noreferrer">
              <RecordIcon className="my-recs-icon" aria-hidden="true" />
              <span className="my-recs-title">{r.title || 'Meeting'}</span>
              <span className="my-recs-when">
                {new Date(r.at).toLocaleString(undefined, {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="my-recs-note">Recordings are deleted a day after the meeting ends.</p>
    </section>
  );
}
