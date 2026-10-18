// The Turnly server, running inside the demo page (demo only).
//
// It uses the REAL server's meeting rules — server/src/rooms.js (who's host,
// raising hands, granting / passing the floor, modes, chat, breakout moves,
// snapshots) and server/src/activities.js (questions, polls, the meeting
// report) — imported straight from the server folder. Around them is a slim
// copy of the server's event handlers (server/src/index.js), talking to the
// app through DemoSocket instead of Socket.IO.
//
// The other people in the meeting are pretend participants ("bots") with
// drawn cameras (bots.js). A few small behaviours make the room feel alive —
// the one with the floor talks, someone answers a chat message, votes come in
// on a poll — all listed in scenes.js / below.
//
// Isolation: the rooms live in this page's memory only. Recording keeps
// nothing (every piece is acknowledged and dropped), and nothing is ever sent
// to the real server.

import { EVENTS, MODES, REACTIONS, ROLES, STICKERS } from '@listen/shared';
import {
  addChatMessage,
  addParticipant,
  captionsOn,
  clearFloor,
  deleteChatMessage,
  demoteCohost,
  editChatMessage,
  getRoom,
  grantFloor,
  lowerHand,
  moveParticipant,
  passFloor,
  promoteCohost,
  raiseHand,
  rekey,
  removeParticipant,
  reorderQueue,
  revokeFloor,
  setCam,
  setCaptionWatcher,
  setChatMuted,
  setDevice,
  setLock,
  setMic,
  setMode,
  setSharing,
  setSpeaking,
  snapshot,
  ticketOf,
  unsendChatMessage,
} from '../../../server/src/rooms.js';
import {
  askQuestion,
  askerOf,
  clearPoll,
  closeQuestion,
  endPoll,
  meetingReport,
  startPoll,
  votePoll,
  voteQuestion,
} from '../../../server/src/activities.js';
import { BotPeers } from './bots.js';
import { setTalking } from './cameras.js';

export const YOU = 'demo-you';
const BREAKOUT_MAX_ROOMS = 20;

// The pretend participants.
export const CAST = {
  grace: { name: 'Grace', color: '#e5484d' },
  sam: { name: 'Sam', color: '#2f9e6b' },
  ada: { name: 'Ada', color: '#8a5cf6' },
  tunde: { name: 'Tunde', color: '#d9822b' },
  mia: { name: 'Mia', color: '#d6409f' },
  ben: { name: 'Ben', color: '#3b82f6' },
};
// bot ids look like "bot-sam" (or "bot-sam~2" after a move — see relocate)
const baseOf = (id) => id.replace(/^bot-/, '').replace(/~\d+$/, '');
const isBot = (id) => typeof id === 'string' && id.startsWith('bot-');
const later = (ms, fn) => setTimeout(fn, ms);

const CHAT_REPLIES = [
  'Good point 👍',
  'Thanks for sharing that!',
  'Agreed.',
  'Can you say a bit more about that?',
  'Love this 🙌',
];

export function createDemoServer(socket, scene) {
  const MAIN = `demo-${scene.id}`;
  let here = null; // the room the visitor is in
  let seq = 0; // order the floor was given in (who talks)
  const floorOrder = new Map(); // botId -> seq
  const timers = new Set();
  let ended = false;
  let arranging = false; // a scene is setting up (before the visitor's join is answered)

  const peers = new BotPeers(
    (botId, msg) => {
      if (getRoom(here)?.participants[botId])
        socket.deliver(EVENTS.RTC_SIGNAL, { from: botId, ...msg });
    },
    (botId) => CAST[baseOf(botId)] ?? { name: 'Guest', color: '#64748b' },
  );

  const after = (ms, fn) => {
    const t = later(ms, () => {
      timers.delete(t);
      if (!ended) fn();
    });
    timers.add(t);
  };

  // --- sending to the app ---------------------------------------------------
  function toApp(roomId, event, payload) {
    if (roomId === here) socket.deliver(event, payload);
  }

  // --- pretend captions ------------------------------------------------------
  // Real captions come from each speaker's own browser (captions.js), which
  // the demo never uses — it would listen to the visitor's real microphone.
  // So while the visitor has captions on, whoever's talking "says" one of
  // these every few seconds.
  const CAPTION_LINES = [
    'Thanks everyone for joining, let’s get started.',
    'I’ll keep this short so there’s time for questions.',
    'Raise your hand if you’d like to add something.',
    'Great point, let’s come back to that at the end.',
    'Ada, you’re next, go ahead whenever you’re ready.',
  ];
  let captionLoop = false;
  let captionNo = 0;
  function captionTick() {
    const room = getRoom(here);
    if (!room || !captionsOn(room)) {
      captionLoop = false;
      return;
    }
    const talker = [...room.speaking].reverse().find((id) => id !== YOU);
    if (talker && room.participants[talker]) {
      toApp(here, EVENTS.CAPTION, {
        id: talker,
        name: room.participants[talker].name,
        text: CAPTION_LINES[captionNo++ % CAPTION_LINES.length],
        final: true,
      });
    }
    after(2800, captionTick);
  }

  function broadcast(roomId = here) {
    for (const id of new Set([roomId, here, MAIN])) {
      const room = getRoom(id);
      if (!room) continue;
      talk(room);
      const state = snapshot(id);
      if (state) toApp(id, EVENTS.ROOM_STATE, state);
    }
    const mine = getRoom(here);
    peers.keepOnly(new Set(Object.keys(mine?.participants ?? {})));
    setTalking(mine ? mine.speaking : []);
    scene.onChange?.(api);
  }

  // A line from Turnly in the chat (like the server's postNote).
  function postNote(roomId, room, text, extra = {}) {
    const message = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from: null,
      name: 'Turnly',
      ts: Date.now(),
      kind: 'note',
      text,
      recording: null,
      ...extra,
    };
    addChatMessage(room, message);
    toApp(roomId, EVENTS.CHAT_MESSAGE, message);
  }

  // A pretend participant posts in the chat. `fields` = what's in the
  // message: { text } or { kind: 'file', file }, plus optionally `minsAgo`
  // (how long before now it was "sent" — the chat demo's history from before
  // the visitor joined) and `edited` (shows "(edited)").
  function say(room, botId, { minsAgo = 0, edited = false, ...fields }) {
    const ts = Date.now() - minsAgo * 60_000;
    const message = {
      id: `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from: botId,
      name: room.participants[botId]?.name ?? 'Guest',
      ts,
      kind: 'text',
      ...fields,
      ...(edited ? { editedAt: ts + 30_000 } : {}),
    };
    addChatMessage(room, message);
    // While a scene is still setting up, the visitor hasn't joined yet: the
    // message reaches them in the chat history that comes with joining —
    // sending it now as well would show it twice.
    if (!arranging) toApp(here, EVENTS.CHAT_MESSAGE, message);
    return message;
  }

  // Who among the pretend participants is talking: the one most recently
  // given the floor (moderated), or the scene's chatty one (open).
  function talk(room) {
    const bots = Object.values(room.participants).filter((p) => isBot(p.id));
    let talker = null;
    if (room.mode === MODES.MODERATED) {
      const speakers = bots.filter((p) => p.role === ROLES.SPEAKER && room.mics[p.id] !== false);
      speakers.sort((a, b) => (floorOrder.get(b.id) ?? -1) - (floorOrder.get(a.id) ?? -1));
      talker = speakers[0]?.id ?? null;
    } else {
      talker =
        bots.find((p) => baseOf(p.id) === scene.openTalker && room.mics[p.id] !== false)?.id ??
        null;
    }
    for (const p of bots) setSpeaking(room, p.id, p.id === talker);
  }

  // --- the pretend participants' actions -------------------------------------
  const bot = (name) => `bot-${name}`;
  function addBot(name, roomId = MAIN) {
    const id = bot(name);
    const room = addParticipant(roomId, id, CAST[name].name, null, scene.title);
    setDevice(room, id, true);
    return id;
  }
  function giveFloor(room, id) {
    grantFloor(room, id);
    floorOrder.set(id, (seq += 1));
  }
  // Someone in the room (not the visitor, not the host) raises a hand.
  function someoneRaises(room) {
    const who = Object.values(room.participants).find(
      (p) => isBot(p.id) && p.role === ROLES.LISTENER && !room.queue.includes(p.id),
    );
    if (who) raiseHand(room, who.id);
    return who?.id ?? null;
  }
  function botPasses(room, id) {
    const { passed, next } = passFloor(room, id);
    if (passed && next) floorOrder.set(next, (seq += 1));
    return passed;
  }

  // Move someone between rooms (breakouts), keeping their seat (moveParticipant).
  // The visitor's app is told (MOVED); a pretend participant who arrives in
  // the visitor's room gets a fresh id, so the app connects to them anew.
  function relocate(id, fromId, toId, create) {
    const to = moveParticipant(fromId, toId, id, create);
    if (!to) return null;
    if (id === YOU) {
      here = toId;
      socket.deliver(EVENTS.MOVED, {
        selfId: YOU,
        state: snapshot(toId),
        chat: [...to.chat],
        ticket: ticketOf(to, YOU),
      });
    } else if (isBot(id)) {
      const n = Number(id.match(/~(\d+)$/)?.[1] ?? 1) + 1;
      rekey(to, id, `bot-${baseOf(id)}~${n}`);
      peers.close(id);
    }
    return to;
  }

  function breakoutRoomInfo(k) {
    const main = getRoom(MAIN);
    return {
      title: `${main?.title || 'Meeting'} · Room ${k + 1}`,
      breakoutOf: { main: MAIN, name: `Room ${k + 1}`, endsAt: main?.breakouts?.endsAt ?? null },
    };
  }

  function startBreakouts(count, minutes, assign) {
    const main = getRoom(MAIN);
    const people = Object.keys(main.participants).filter(
      (id) => id !== main.hostId && id !== main.cohostId,
    );
    for (let i = people.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [people[i], people[j]] = [people[j], people[i]];
    }
    const n = assign
      ? Math.max(1, Math.min(count, BREAKOUT_MAX_ROOMS))
      : Math.max(1, Math.min(count, people.length, BREAKOUT_MAX_ROOMS));
    const endsAt = minutes > 0 ? Date.now() + minutes * 60_000 : null;
    const ids = Array.from({ length: n }, (_, i) => `${MAIN}~${i + 1}`);
    main.breakouts = { ids, endsAt };
    people.forEach((id, i) => {
      const k = assign ? assign[id] : i % n;
      if (!Number.isInteger(k) || k < 0 || k >= n) return;
      relocate(id, MAIN, ids[k], breakoutRoomInfo(k));
    });
    for (const [i, id] of ids.entries()) {
      const room = getRoom(id);
      if (room) postNote(id, room, `Welcome to Room ${i + 1}!`);
    }
    if (endsAt) after(minutes * 60_000, () => endBreakouts());
  }

  function endBreakouts() {
    const main = getRoom(MAIN);
    for (const id of main?.breakouts?.ids ?? []) {
      const room = getRoom(id);
      for (const pid of Object.keys(room?.participants ?? {})) {
        relocate(pid, id, MAIN, { title: main.title });
      }
    }
    if (main) main.breakouts = null;
    broadcast(MAIN);
  }

  function moveBreakoutPerson(personId, to, byName) {
    const main = getRoom(MAIN);
    const ids = main?.breakouts?.ids ?? [];
    const fromId = [MAIN, ...ids].find((id) => getRoom(id)?.participants[personId]);
    if (!fromId) return 'They’re not in this meeting any more.';
    if (personId === main.hostId || personId === main.cohostId) {
      return 'The host and cohost stay in the main room.';
    }
    const toId = to === -1 ? MAIN : ids[to];
    if (!toId) return 'Pick a room.';
    if (toId === fromId) return null;
    const name = getRoom(fromId).participants[personId].name;
    const target = relocate(
      personId,
      fromId,
      toId,
      to === -1 ? { title: main.title } : breakoutRoomInfo(to),
    );
    if (!target) return 'Couldn’t move them. Try again.';
    postNote(toId, target, `🧩 ${byName} moved ${name} here.`);
    broadcast(fromId);
    broadcast(toId);
    return null;
  }

  // --- the app's requests (the server's handlers, slimmed down) -------------
  const moderator = (room) => room && (room.hostId === YOU || room.cohostId === YOU);

  function handle(from, event, payload = {}, ack) {
    if (ended) return ack?.({ ok: false, error: 'demo ended' });
    const room = getRoom(here);
    const fail = (error) => ack?.({ ok: false, error });
    const ok = (extra = {}) => ack?.({ ok: true, ...extra });
    const needMod = () => {
      if (moderator(room)) return true;
      socket.deliver(EVENTS.ERROR, { message: 'only a moderator can do that' });
      fail('only a moderator can do that');
      return false;
    };

    switch (event) {
      case EVENTS.JOIN_ROOM: {
        if (here) return fail('already in a room');
        const name = String(payload.name || 'You').slice(0, 40);
        if (scene.youHost) {
          addParticipant(MAIN, YOU, name, payload.avatar ?? null, scene.title);
          scene.populate(api);
        } else {
          scene.populate(api);
          addParticipant(MAIN, YOU, name, payload.avatar ?? null, scene.title);
        }
        here = MAIN;
        const r = getRoom(MAIN);
        setLock(r, false);
        arranging = true; // (see say())
        scene.arrange?.(api, r);
        arranging = false;
        talk(r);
        setTalking(r.speaking);
        ok({
          selfId: YOU,
          state: snapshot(MAIN),
          chat: [...r.chat],
          iceServers: [],
          ticket: ticketOf(r, YOU),
        });
        broadcast(MAIN);
        return undefined;
      }
      case EVENTS.RESUME:
        return fail('expired');
      case EVENTS.RTC_SIGNAL:
        if (payload.targetId && room?.participants[payload.targetId]) {
          peers.handle(payload.targetId, payload);
        }
        return undefined;
      case EVENTS.SET_MODE:
        if (!needMod()) return undefined;
        if (payload.mode !== MODES.OPEN && payload.mode !== MODES.MODERATED)
          return fail('unknown mode');
        setMode(room, payload.mode);
        ok();
        break;
      case EVENTS.RAISE_HAND:
        raiseHand(room, YOU);
        ok();
        scene.onRaise?.(api, room);
        break;
      case EVENTS.LOWER_HAND: {
        const t = payload.targetId && payload.targetId !== YOU ? payload.targetId : YOU;
        if (t !== YOU && !moderator(room)) return fail('only a moderator can lower another hand');
        lowerHand(room, t);
        ok();
        break;
      }
      case EVENTS.GRANT_FLOOR:
        if (!needMod()) return undefined;
        giveFloor(room, payload.targetId);
        ok();
        scene.onGrant?.(api, room, payload.targetId);
        break;
      case EVENTS.REVOKE_FLOOR:
        if (!needMod()) return undefined;
        revokeFloor(room, payload.targetId);
        ok();
        break;
      case EVENTS.CLEAR_FLOOR:
        if (!needMod()) return undefined;
        clearFloor(room);
        ok();
        break;
      case EVENTS.PASS_MIC: {
        const { passed, next } = passFloor(room, YOU);
        if (!passed) return fail('you are not a speaker');
        if (next) floorOrder.set(next, (seq += 1));
        ok();
        scene.onGrant?.(api, room, next);
        break;
      }
      case EVENTS.FORCE_MUTE:
        if (!needMod()) return undefined;
        if (room.participants[payload.targetId]) setMic(room, payload.targetId, false); // the bot complies
        ok();
        break;
      case EVENTS.REMOVE_PARTICIPANT:
        if (!needMod()) return undefined;
        if (!room.participants[payload.targetId] || payload.targetId === room.hostId) {
          return fail('unknown participant');
        }
        removeParticipant(payload.targetId);
        peers.close(payload.targetId);
        ok();
        break;
      case EVENTS.REORDER_QUEUE:
        if (!needMod()) return undefined;
        reorderQueue(room, payload.order);
        ok();
        break;
      case EVENTS.PROMOTE_COHOST:
        if (room.hostId !== YOU) return fail('only the host can do that');
        promoteCohost(room, payload.targetId);
        ok();
        break;
      case EVENTS.DEMOTE_COHOST:
        if (room.hostId !== YOU) return fail('only the host can do that');
        demoteCohost(room, payload.targetId || room.cohostId);
        ok();
        break;
      case EVENTS.SET_LOCK:
        if (!needMod()) return undefined;
        setLock(room, payload.locked);
        ok();
        break;
      case EVENTS.ADMIT:
      case EVENTS.DENY:
        return fail('not waiting');
      case EVENTS.CHAT_SEND: {
        const me = room?.participants[YOU];
        if (!me) return fail('not in a room');
        const base = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          from: YOU,
          name: me.name,
          ts: Date.now(),
        };
        let message;
        if (payload.kind === 'file') {
          if (!String(payload.file?.url ?? '').startsWith('data:')) return fail('bad attachment');
          message = { ...base, kind: 'file', file: { ...payload.file } };
        } else {
          const body = String(payload.text ?? '').trim();
          const sticker = payload.kind === 'sticker';
          if (sticker ? !STICKERS.includes(body) : !body) return fail('empty message');
          message = { ...base, kind: sticker ? 'sticker' : 'text', text: body.slice(0, 2000) };
        }
        addChatMessage(room, message);
        ok();
        toApp(here, EVENTS.CHAT_MESSAGE, message);
        replyInChat(here);
        return undefined;
      }
      case EVENTS.CHAT_EDIT: {
        const msg = editChatMessage(
          room,
          YOU,
          String(payload.id ?? ''),
          String(payload.text ?? '').trim(),
        );
        if (!msg) return fail('you can only edit your own text messages');
        ok();
        toApp(here, EVENTS.CHAT_EDITED, { id: msg.id, text: msg.text, editedAt: msg.editedAt });
        return undefined;
      }
      case EVENTS.CHAT_UNSEND:
        if (!unsendChatMessage(room, YOU, String(payload.id ?? ''))) return fail('not yours');
        ok();
        toApp(here, EVENTS.CHAT_UNSENT, { id: payload.id });
        return undefined;
      // Chat moderation, as on the real server (server/src/index.js).
      case EVENTS.CHAT_DELETE: {
        if (!needMod()) return undefined;
        const removed = deleteChatMessage(room, String(payload.id ?? ''));
        if (!removed) return fail('no such message');
        ok();
        toApp(here, EVENTS.CHAT_UNSENT, { id: removed.id });
        return undefined;
      }
      case EVENTS.CHAT_MUTE:
        if (!needMod()) return undefined;
        if (
          payload.targetId === room.hostId ||
          !setChatMuted(room, payload.targetId, payload.muted === true)
        ) {
          return fail('can’t mute that person’s chat');
        }
        ok();
        break;
      // Live captions (as on the real server), with pretend lines (above).
      case EVENTS.CAPTIONS_WANT:
        setCaptionWatcher(room, YOU, payload.on === true);
        ok();
        if (captionsOn(room) && !captionLoop) {
          captionLoop = true;
          after(600, captionTick);
        }
        break;
      case EVENTS.CAPTION:
        return undefined; // (the demo never transcribes — see above)
      case EVENTS.CHAT_TYPING:
        return undefined;
      case EVENTS.SCREEN_SHARE:
        setSharing(room, YOU, payload.on === true, payload.streamId);
        break;
      case EVENTS.MIC_STATE:
        if ((room.mics[YOU] ?? true) === (payload.on === true)) return undefined;
        setMic(room, YOU, payload.on);
        break;
      case EVENTS.CAM_STATE:
        if ((room.cams[YOU] ?? true) === (payload.on === true)) return undefined;
        setCam(room, YOU, payload.on);
        break;
      case EVENTS.SPEAKING:
        if (!setSpeaking(room, YOU, payload.speaking === true)) return undefined;
        break;
      case EVENTS.REACT:
        if (!REACTIONS.includes(payload.emoji)) return undefined;
        toApp(here, EVENTS.REACTION, {
          id: YOU,
          name: room.participants[YOU].name,
          emoji: payload.emoji,
        });
        // someone joins in
        after(700, () => {
          const other = Object.values(getRoom(here)?.participants ?? {}).find((p) => isBot(p.id));
          if (other)
            toApp(here, EVENTS.REACTION, { id: other.id, name: other.name, emoji: payload.emoji });
        });
        return undefined;
      case EVENTS.Q_ASK: {
        const q = askQuestion(room, YOU, room.participants[YOU].name, payload.text);
        if (!q) return fail('Write a question first.');
        ok();
        broadcast();
        postNote(here, room, `${q.name} asked: “${q.text}”`, { question: q.id });
        // others think it's a good one
        for (const [i, p] of Object.values(room.participants)
          .filter((x) => isBot(x.id))
          .slice(0, 2)
          .entries()) {
          after(1200 + i * 900, () => {
            voteQuestion(room, p.id, q.id);
            broadcast();
          });
        }
        return undefined;
      }
      case EVENTS.Q_VOTE:
        if (!voteQuestion(room, YOU, payload.id)) return fail('not found');
        ok();
        break;
      case EVENTS.Q_CLOSE:
        if (!moderator(room) && askerOf(room, payload.id) !== YOU)
          return fail('only a moderator can do that');
        if (!closeQuestion(room, payload.id)) return fail('not found');
        ok();
        break;
      case EVENTS.POLL_START: {
        if (!needMod()) return undefined;
        const poll = startPoll(
          room,
          room.participants[YOU].name,
          payload.question,
          payload.options,
        );
        if (!poll) return fail('A poll needs a question and at least two answers.');
        postNote(here, room, `${poll.by} started a poll: ${poll.question}`);
        ok();
        // the others vote, one by one (pretend people, clearly)
        const voters = Object.values(room.participants).filter((p) => isBot(p.id));
        voters.forEach((p, i) =>
          after(900 + i * 700, () => {
            if (room.poll?.id === poll.id && room.poll.open !== false) {
              const pick = (i * 7 + 3) % poll.options.length;
              votePoll(room, p.id, poll.id, i % 3 === 0 ? 0 : pick);
              broadcast();
            }
          }),
        );
        break;
      }
      case EVENTS.POLL_VOTE:
        if (!votePoll(room, YOU, payload.id, payload.option)) return fail('poll closed');
        ok();
        break;
      case EVENTS.POLL_END:
        if (!needMod()) return undefined;
        if (!endPoll(room, payload.id)) return fail('not found');
        ok();
        break;
      case EVENTS.POLL_CLEAR:
        if (!needMod()) return undefined;
        if (!clearPoll(room, payload.id)) return fail('not found');
        ok();
        break;
      case EVENTS.REPORT_GET:
        if (!needMod()) return undefined;
        return ok({ report: meetingReport(room) });
      case EVENTS.BREAKOUT_START: {
        if (!needMod()) return undefined;
        if (room.breakoutOf) return fail('Already in a breakout room.');
        if (room.breakouts) return fail('Breakout rooms are already running.');
        const n = Number(payload.rooms);
        const mins = Number(payload.minutes);
        const others = Object.keys(room.participants).filter(
          (id) => id !== room.hostId && id !== room.cohostId,
        );
        if (!Number.isInteger(n) || n < 1 || n > BREAKOUT_MAX_ROOMS)
          return fail('Pick how many rooms.');
        if (!Number.isInteger(mins) || mins < 0 || mins > 180) return fail('Pick how long.');
        let chosen = null;
        if (payload.assign && typeof payload.assign === 'object') {
          chosen = {};
          for (const id of others) {
            const k = payload.assign[id];
            if (Number.isInteger(k) && k >= 0 && k < n) chosen[id] = k;
          }
          if (!Object.keys(chosen).length) return fail('Put at least one person in a room.');
        } else if (others.length < 2) return fail('You need at least 2 other people.');
        startBreakouts(n, mins, chosen);
        ok();
        break;
      }
      case EVENTS.BREAKOUT_END:
        if (!needMod()) return undefined;
        if (!room.breakouts) return fail('No breakout rooms running.');
        endBreakouts();
        return ok();
      case EVENTS.BREAKOUT_MOVE: {
        if (!needMod()) return undefined;
        if (!room.breakouts) return fail('No breakout rooms running.');
        const k = Number(payload.to);
        if (typeof payload.id !== 'string' || !Number.isInteger(k) || k < -1)
          return fail('Pick a room.');
        const error = moveBreakoutPerson(payload.id, k, room.participants[YOU].name);
        return error ? fail(error) : ok();
      }
      case EVENTS.BREAKOUT_MESSAGE: {
        if (!needMod()) return undefined;
        const body = String(payload.text ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        if (!body || !room.breakouts) return fail('Nothing to send.');
        for (const id of room.breakouts.ids) {
          const r = getRoom(id);
          if (r) postNote(id, r, `📣 ${room.participants[YOU].name}: ${body}`);
        }
        return ok();
      }
      case EVENTS.DEVICE:
        setDevice(room, YOU, payload.desktop);
        room.participants[YOU].canRecord = payload.canRecord !== false;
        return undefined;
      case EVENTS.REC_START: {
        if (!needMod()) return undefined;
        if (room.recording) return fail('already recording');
        const recorder = room.participants[YOU].canRecord !== false ? YOU : null;
        room.recording = {
          id: 'demo-recording',
          startedAt: Date.now(),
          recorderId: recorder,
          part: recorder ? 1 : null,
        };
        postNote(
          here,
          room,
          `${room.participants[YOU].name} started recording. This is a demo, so nothing is saved.`,
        );
        ok({ id: 'demo-recording' });
        break;
      }
      case EVENTS.REC_STOP:
        if (!needMod()) return undefined;
        if (!room.recording) return fail('not recording');
        room.recording = null;
        postNote(
          here,
          room,
          `${room.participants[YOU].name} stopped recording. In a real meeting everyone would get a link to watch it. This demo saved nothing.`,
        );
        ok();
        break;
      case EVENTS.REC_CHUNK:
        // The real recorder really records — and the demo throws every piece away.
        return ok();
      default:
        // (the Cloudflare SFU events: the demo uses direct connections instead)
        return fail('not available in the demo');
    }
    broadcast();
    return undefined;
  }

  // Someone answers a chat message (typing… then a short reply).
  function replyInChat(roomId) {
    const room = getRoom(roomId);
    const who =
      Object.values(room?.participants ?? {}).find((p) => isBot(p.id) && p.id !== room.hostId) ??
      Object.values(room?.participants ?? {}).find((p) => isBot(p.id));
    if (!who) return;
    after(900, () =>
      toApp(roomId, EVENTS.CHAT_TYPING, { id: who.id, name: who.name, typing: true }),
    );
    after(2400, () => {
      const r = getRoom(roomId);
      if (!r?.participants[who.id]) return;
      const message = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        from: who.id,
        name: who.name,
        ts: Date.now(),
        kind: 'text',
        text: CHAT_REPLIES[Math.floor(Math.random() * CHAT_REPLIES.length)],
      };
      addChatMessage(r, message);
      toApp(roomId, EVENTS.CHAT_MESSAGE, message);
    });
  }

  // The visitor left (the red button).
  function leave() {
    const room = getRoom(here);
    if (room?.participants[YOU]) removeParticipant(YOU);
    here = null;
    peers.closeAll();
  }

  function stop() {
    ended = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    peers.closeAll();
  }

  // What scenes.js can use to set up and run a scene.
  const api = {
    MAIN,
    state: {}, // a scene's own notes ("already moved the line", …)
    addBot,
    giveFloor,
    someoneRaises,
    botPasses,
    raiseHand,
    setMode,
    after,
    broadcast,
    postNote,
    say,
    askQuestion,
    voteQuestion,
    room: () => getRoom(here ?? MAIN),
    bot,
  };

  return { handle, leave, stop };
}
