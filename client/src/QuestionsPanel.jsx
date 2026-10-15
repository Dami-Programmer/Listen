// Questions: anyone types a question; everyone can upvote (▲); the most
// voted sit at the top. A moderator answers one — or, in a moderated room,
// gives its asker the floor to ask it themselves — and ticks it off. You can
// withdraw your own. (The list itself is the room snapshot's `questions`.)
// Used in the desktop side panel and the phone's people sheet.

import { useState } from 'react';
import { EVENTS, QUESTION_MAX_CHARS, ROLES } from '@listen/shared';
import { socket } from './socket.js';
import { Check, X } from './icons.jsx';

const send = (event, payload, onError) =>
  socket.emit(event, payload, (ack) => {
    if (!ack?.ok) onError?.(ack?.error || 'Something went wrong. Try again.');
  });

/**
 * @param {object[]} props.questions     snapshot `questions`, most votes first
 * @param {object[]} props.participants
 * @param {string}   props.selfId
 * @param {boolean}  props.isModerator
 * @param {boolean}  props.moderated     (to offer "Give the floor")
 */
export default function QuestionsPanel({
  questions = [],
  participants,
  selfId,
  isModerator,
  moderated,
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);

  function ask(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) {
      setError('Write a question first.');
      return;
    }
    send(EVENTS.Q_ASK, { text: body }, setError);
    setText('');
    setError(null);
  }

  const personOf = (id) => participants.find((p) => p.id === id);

  return (
    <div className="qa">
      <form className="qa-ask" onSubmit={ask}>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line.
            if (e.key === 'Enter' && !e.shiftKey) ask(e);
          }}
          placeholder="Ask a question…"
          aria-label="Ask a question"
          maxLength={QUESTION_MAX_CHARS}
          rows={2}
        />
        <button type="submit" className="qa-send">
          Ask
        </button>
      </form>
      {error && <p className="qa-error">{error}</p>}

      {questions.length === 0 ? (
        <p className="qa-empty">
          No questions yet. Ask one, and everyone can upvote the ones they want answered.
        </p>
      ) : (
        <ol className="qa-list">
          {questions.map((q) => {
            const voted = q.votes.includes(selfId);
            const mine = q.from === selfId;
            const asker = personOf(q.from);
            // Moderated room, asker still here and listening: hand them the mic.
            const canGiveFloor = isModerator && moderated && asker && asker.role === ROLES.LISTENER;
            return (
              <li key={q.id} className="qa-item">
                <button
                  type="button"
                  className={`qa-vote${voted ? ' on' : ''}`}
                  onClick={() => send(EVENTS.Q_VOTE, { id: q.id }, setError)}
                  aria-pressed={voted}
                  aria-label={`${voted ? 'Remove your vote' : 'Upvote'} (${q.votes.length})`}
                >
                  <span aria-hidden="true">▲</span>
                  {q.votes.length}
                </button>
                <div className="qa-body">
                  <p className="qa-text">{q.text}</p>
                  <span className="qa-who">{mine ? 'You' : q.name}</span>
                  {(isModerator || mine) && (
                    <span className="qa-actions">
                      {canGiveFloor && (
                        <button
                          type="button"
                          className="qa-act"
                          onClick={() => {
                            send(EVENTS.GRANT_FLOOR, { targetId: q.from }, setError);
                            send(EVENTS.Q_CLOSE, { id: q.id }, setError);
                          }}
                        >
                          Give the floor
                        </button>
                      )}
                      {isModerator ? (
                        <button
                          type="button"
                          className="qa-act"
                          onClick={() => send(EVENTS.Q_CLOSE, { id: q.id }, setError)}
                          title="Answered. Take it off the list"
                        >
                          <Check /> Done
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="qa-act"
                          onClick={() => send(EVENTS.Q_CLOSE, { id: q.id }, setError)}
                        >
                          <X /> Withdraw
                        </button>
                      )}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
