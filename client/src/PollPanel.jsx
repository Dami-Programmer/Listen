// Polls: a moderator asks a question with 2-6 answers; everyone taps one (and
// can change their mind while it's open); the results fill in as live bars.
// Votes are anonymous — only the counts are shared. One poll at a time (the
// room snapshot's `poll`). Used in the desktop side panel and the phone's
// people sheet.

import { useState } from 'react';
import { EVENTS, POLL_MAX_OPTIONS, POLL_TEXT_MAX_CHARS } from '@listen/shared';
import { socket } from './socket.js';
import { X } from './icons.jsx';

// What I picked in each poll (the server never says who voted for what). In
// memory: the vote itself is safe on the server even if this is forgotten.
const myVotes = new Map(); // poll id -> option index

/**
 * @param {object|null} props.poll         snapshot `poll`
 * @param {boolean}     props.isModerator
 */
export default function PollPanel({ poll, isModerator }) {
  const [, rerender] = useState(0);
  const [error, setError] = useState(null);

  const send = (event, payload) =>
    socket.emit(event, payload, (ack) => {
      if (!ack?.ok) setError(ack?.error || 'Something went wrong. Try again.');
    });

  if (!poll) {
    return isModerator ? (
      <PollComposer onError={setError} error={error} />
    ) : (
      <p className="qa-empty">No poll right now. When the host starts one, it shows up here.</p>
    );
  }

  const mine = myVotes.get(poll.id);
  const vote = (i) => {
    if (!poll.open) return;
    myVotes.set(poll.id, i);
    rerender((n) => n + 1);
    setError(null);
    send(EVENTS.POLL_VOTE, { id: poll.id, option: i });
  };

  return (
    <div className="poll">
      <p className="poll-q">{poll.question}</p>
      <p className="poll-meta">
        {poll.open ? 'Tap an answer. You can change it later' : 'Poll closed'} · {poll.total}{' '}
        {poll.total === 1 ? 'vote' : 'votes'}
      </p>
      <ul className="poll-options">
        {poll.options.map((o, i) => {
          const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
          return (
            <li key={i}>
              <button
                type="button"
                className={`poll-option${mine === i ? ' mine' : ''}`}
                onClick={() => vote(i)}
                disabled={!poll.open}
                aria-pressed={mine === i}
              >
                <span className="poll-bar" style={{ width: `${pct}%` }} aria-hidden="true" />
                <span className="poll-text">{o.text}</span>
                <span className="poll-pct">{pct}%</span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="qa-error">{error}</p>}
      {isModerator && (
        <div className="poll-mod">
          {poll.open ? (
            <button
              type="button"
              className="qa-act"
              onClick={() => send(EVENTS.POLL_END, { id: poll.id })}
            >
              End poll
            </button>
          ) : (
            <button
              type="button"
              className="qa-act"
              onClick={() => send(EVENTS.POLL_CLEAR, { id: poll.id })}
            >
              Remove · new poll
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The moderator's "new poll" form: a question and 2-6 answers.
function PollComposer({ onError, error }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);

  function start(e) {
    e.preventDefault();
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q) return onError('Write the question first.');
    if (opts.length < 2) return onError('Add at least two answers.');
    socket.emit(EVENTS.POLL_START, { question: q, options: opts }, (ack) => {
      if (!ack?.ok) onError(ack?.error || 'Couldn’t start the poll.');
    });
    onError(null);
    setQuestion('');
    setOptions(['', '']);
    return undefined;
  }

  return (
    <form className="poll-new" onSubmit={start}>
      <label className="poll-label field">
        <span>Ask everyone</span>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Which day works best?"
          maxLength={POLL_TEXT_MAX_CHARS}
        />
      </label>
      {options.map((o, i) => (
        <div className="poll-answer" key={i}>
          <input
            value={o}
            onChange={(e) =>
              setOptions((list) => list.map((x, j) => (j === i ? e.target.value : x)))
            }
            placeholder={`Answer ${i + 1}`}
            aria-label={`Answer ${i + 1}`}
            maxLength={POLL_TEXT_MAX_CHARS}
          />
          {options.length > 2 && (
            <button
              type="button"
              className="poll-remove"
              onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
              aria-label={`Remove answer ${i + 1}`}
            >
              <X />
            </button>
          )}
        </div>
      ))}
      {options.length < POLL_MAX_OPTIONS && (
        <button
          type="button"
          className="poll-add"
          onClick={() => setOptions((list) => [...list, ''])}
        >
          + Add an answer
        </button>
      )}
      {error && <p className="qa-error">{error}</p>}
      <button type="submit" className="qa-send poll-start">
        Start poll
      </button>
    </form>
  );
}
