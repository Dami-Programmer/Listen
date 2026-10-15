// Things people do in a meeting besides talking: questions, polls, and the
// numbers behind the meeting report. All of it lives on the room object
// (rooms.js creates `stats`, `questions` and `poll`), and like everything else
// it's gone when the room closes.
//
//   questions  — anyone asks; everyone upvotes; a moderator closes them
//   poll       — one at a time; anonymous votes, live counts
//   stats      — per person: when they came and went, how long they talked,
//                hands raised, turns given (the meeting report)

import { randomUUID } from 'node:crypto';
import { POLL_MAX_OPTIONS, POLL_TEXT_MAX_CHARS, QUESTION_MAX_CHARS } from '@listen/shared';

// At most this many open questions at once (oldest dropped past it).
const QUESTIONS_MAX = 50;

const clean = (text, max) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/* --------------------------------------------------------------------------
 * The meeting report: attendance and talk time
 * ------------------------------------------------------------------------ */

// Someone is in the room now (joined, let in, or back from a rejoin).
export function statsJoin(room, socketId, name) {
  room.stats[socketId] = {
    name,
    joinedAt: Date.now(),
    leftAt: null,
    talkMs: 0,
    talkSince: null,
    hands: 0,
    turns: 0,
  };
}

// They left (for good — not a dropped connection being held).
export function statsLeave(room, socketId) {
  talkStop(room, socketId);
  const s = room.stats[socketId];
  if (s && !s.leftAt) s.leftAt = Date.now();
}

// They started / stopped talking (from the SPEAKING pings).
export function talkStart(room, socketId) {
  const s = room.stats[socketId];
  if (s && !s.talkSince) s.talkSince = Date.now();
}
export function talkStop(room, socketId) {
  const s = room.stats[socketId];
  if (s?.talkSince) {
    s.talkMs += Date.now() - s.talkSince;
    s.talkSince = null;
  }
}

export const countHand = (room, socketId) => {
  if (room.stats[socketId]) room.stats[socketId].hands += 1;
};
export const countTurn = (room, socketId) => {
  if (room.stats[socketId]) room.stats[socketId].turns += 1;
};

/**
 * Everything so far, one row per PERSON: someone who left and rejoined (a
 * new connection each time) is added up into one row, by name.
 */
export function meetingReport(room) {
  const now = Date.now();
  const byName = new Map();
  for (const [id, s] of Object.entries(room.stats)) {
    const row = byName.get(s.name) ?? {
      name: s.name,
      firstJoined: s.joinedAt,
      lastLeft: null,
      present: false,
      talkMs: 0,
      hands: 0,
      turns: 0,
    };
    row.firstJoined = Math.min(row.firstJoined, s.joinedAt);
    const here = Boolean(room.participants[id]) && !s.leftAt;
    row.present = row.present || here;
    if (s.leftAt) row.lastLeft = Math.max(row.lastLeft ?? 0, s.leftAt);
    row.talkMs += s.talkMs + (s.talkSince ? now - s.talkSince : 0);
    row.hands += s.hands;
    row.turns += s.turns;
    byName.set(s.name, row);
  }
  return {
    title: room.title,
    startedAt: room.createdAt,
    now,
    people: [...byName.values()]
      .map((r) => ({ ...r, lastLeft: r.present ? null : r.lastLeft }))
      .sort((a, b) => b.talkMs - a.talkMs || a.firstJoined - b.firstJoined),
  };
}

/* --------------------------------------------------------------------------
 * Questions
 * ------------------------------------------------------------------------ */

/** Ask a question. Returns it, or null if the text is empty. */
export function askQuestion(room, socketId, name, text) {
  const body = clean(text, QUESTION_MAX_CHARS);
  if (!body) return null;
  const q = { id: randomUUID(), from: socketId, name, text: body, ts: Date.now(), votes: [] };
  room.questions.push(q);
  if (room.questions.length > QUESTIONS_MAX) room.questions.shift();
  return q;
}

/** Add or take back my vote. Returns false for an unknown question. */
export function voteQuestion(room, socketId, id) {
  const q = room.questions.find((x) => x.id === id);
  if (!q) return false;
  q.votes = q.votes.includes(socketId)
    ? q.votes.filter((v) => v !== socketId)
    : [...q.votes, socketId];
  return true;
}

/** Take a question off the list (answered, dismissed, or withdrawn). */
export function closeQuestion(room, id) {
  const before = room.questions.length;
  room.questions = room.questions.filter((q) => q.id !== id);
  return room.questions.length !== before;
}

/** The asker of a question (to check "your own" for withdrawing). */
export const askerOf = (room, id) => room.questions.find((q) => q.id === id)?.from ?? null;

/* --------------------------------------------------------------------------
 * Polls (one at a time)
 * ------------------------------------------------------------------------ */

/**
 * Start a poll (replacing any previous one). `options` is 2-POLL_MAX_OPTIONS
 * answers. Returns the poll, or null if it isn't a valid poll.
 */
export function startPoll(room, byName, question, options) {
  const q = clean(question, POLL_TEXT_MAX_CHARS);
  const opts = (Array.isArray(options) ? options : [])
    .map((o) => clean(o, POLL_TEXT_MAX_CHARS))
    .filter(Boolean)
    .slice(0, POLL_MAX_OPTIONS);
  if (!q || opts.length < 2) return null;
  room.poll = {
    id: randomUUID(),
    question: q,
    options: opts,
    votes: {}, // socketId -> option index (never sent to anyone)
    open: true,
    by: byName,
  };
  return room.poll;
}

/** Vote (or change my vote) while the poll is open. */
export function votePoll(room, socketId, id, option) {
  const p = room.poll;
  if (!p || p.id !== id || !p.open) return false;
  if (!Number.isInteger(option) || option < 0 || option >= p.options.length) return false;
  p.votes[socketId] = option;
  return true;
}

export function endPoll(room, id) {
  if (room.poll?.id !== id) return false;
  room.poll.open = false;
  return true;
}

export function clearPoll(room, id) {
  if (room.poll?.id !== id) return false;
  room.poll = null;
  return true;
}

/* --------------------------------------------------------------------------
 * For rooms.js
 * ------------------------------------------------------------------------ */

/** What the snapshot shows: open questions (most votes first) and the poll. */
export function activitySnapshot(room) {
  const p = room.poll;
  const counts = p ? p.options.map(() => 0) : [];
  if (p) for (const v of Object.values(p.votes)) counts[v] += 1;
  return {
    questions: [...room.questions]
      .sort((a, b) => b.votes.length - a.votes.length || a.ts - b.ts)
      .map(({ id, from, name, text, ts, votes }) => ({
        id,
        from,
        name,
        text,
        ts,
        votes: [...votes],
      })),
    poll: p
      ? {
          id: p.id,
          question: p.question,
          options: p.options.map((text, i) => ({ text, votes: counts[i] })),
          total: Object.keys(p.votes).length,
          open: p.open,
          by: p.by,
        }
      : null,
  };
}

/** Someone's connection moved to a new socket id (see rooms.js rekey). */
export function activityRekey(room, oldId, newId) {
  if (room.stats[oldId]) {
    room.stats[newId] = room.stats[oldId];
    delete room.stats[oldId];
  }
  for (const q of room.questions) {
    if (q.from === oldId) q.from = newId;
    q.votes = q.votes.map((v) => (v === oldId ? newId : v));
  }
  if (room.poll && oldId in room.poll.votes) {
    room.poll.votes[newId] = room.poll.votes[oldId];
    delete room.poll.votes[oldId];
  }
}
