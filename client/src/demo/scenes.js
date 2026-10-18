// The demo's scenes: who's in the pretend meeting, how it starts, what the
// pretend participants do, and which part of the real app to open first.
// The landing page picks one with /demo?scene=<id> (LandingDemos.jsx).
//
//   youHost   the visitor is the host (else Grace is, and the visitor is a guest)
//   populate  who else is there (in join order — the first one in is the host)
//   arrange   the starting situation, using the server's own rules (rooms.js)
//   open      what to click open in the real app once it's on screen
//             ({ desktop, phone }: lists of [selector, text?] to click in turn)
//   lobby     start in the real lobby with this dialog open ('claim' /
//             'schedule') instead of in the call
//   on…       small reactions of the pretend participants

import { MODES } from '@listen/shared';

const EVERYONE = ['grace', 'sam', 'ada', 'tunde', 'mia'];
const addAll = (names) => (api) => names.forEach((n) => api.addBot(n));

// When the line runs out, someone else puts a hand up a moment later — so
// the host always has someone to give the floor to.
function keepALine(api) {
  const room = api.room();
  if (!room || room.mode !== MODES.MODERATED || room.queue.length || api.state.refilling) return;
  api.state.refilling = true;
  api.after(3500, () => {
    api.state.refilling = false;
    const r = api.room();
    if (r && !r.queue.length && api.someoneRaises(r)) api.broadcast();
  });
}

// A pretend participant with the floor talks for a while, then passes it on
// (to the first raised hand — which may be you).
function talkThenPass(api, room, id) {
  if (!id || !id.startsWith('bot-')) return;
  api.after(8000, () => {
    const r = api.room();
    if (!r?.participants[id] || r.participants[id].role !== 'speaker') return;
    const next = r.queue[0] ?? null;
    if (api.botPasses(r, id)) {
      api.broadcast();
      talkThenPass(api, r, next);
    }
  });
}

const OPEN_PANEL = {
  // (the header's "N participants" button opens the chat panel AND its people list)
  people: { desktop: [['.cs-people-pill']], phone: [] },
  questions: {
    desktop: [['.cs-chat-btn'], ['.cp-tab', 'Questions']],
    phone: [['.mc-people'], ['.mc-tab', 'Questions']],
  },
  breakouts: {
    desktop: [['.cs-people-pill'], ['.cp-report-btn', 'Breakout']],
    phone: [['.mc-people'], ['.cp-report-btn', 'Breakout']],
  },
  report: {
    desktop: [['.cs-people-pill'], ['.cp-report-btn', 'Meeting report']],
    phone: [['.mc-people'], ['.cp-report-btn', 'Meeting report']],
  },
  // phones: the chat feed is already on screen, nothing to open
  chat: { desktop: [['.cs-chat-btn']], phone: [] },
};

// --- the chat demo -----------------------------------------------------------
// What was said before the visitor joined (so they see "catching up" — the
// history every late joiner gets). [who, minutes ago, message fields]
const CHAT_HISTORY = [
  ['grace', 12, { text: 'Welcome everyone! We’re on chapter 3 tonight 📖' }],
  [
    'ada',
    10,
    {
      kind: 'file',
      // a picture from this site, as "a photo someone shared"
      file: { name: 'welcome-slide.jpg', type: 'image/jpeg', size: 182_000, url: '/og-image.jpg' },
    },
  ],
  [
    'tunde',
    9,
    {
      kind: 'file',
      // a real (tiny) file, so Download really downloads something
      file: {
        name: 'Reading plan.txt',
        type: 'text/plain',
        size: 64,
        url: `data:text/plain;charset=utf-8,${encodeURIComponent(
          'Week 3 reading plan\nChapter 3, pages 40-48\nBring one question for the group.\n',
        )}`,
      },
    },
  ],
  ['grace', 7, { text: 'Page 42, verse 6', edited: true }],
  ['sam', 4, { text: 'Thanks Tunde, that plan helps 🙏' }],
];

// --- the meeting report demo ---------------------------------------------------
// A meeting that's been going for a while, so the report has something to
// show: [who, joined (minutes ago), talked (seconds), hands raised, turns]
// Mia never got a word in — the kind of thing the report is for.
const REPORT_PEOPLE = [
  ['sam', 42, 760, 2, 2],
  ['grace', 42, 555, 0, 0],
  ['ada', 40, 365, 3, 2],
  ['tunde', 38, 200, 1, 1],
  ['ben', 20, 45, 1, 1],
  ['mia', 35, 0, 2, 0],
];

const raise = {
  title: 'Sunday Bible Study',
  youHost: false,
  populate: addAll(EVERYONE),
  arrange(api, room) {
    api.setMode(room, MODES.MODERATED);
    api.giveFloor(room, api.bot('sam'));
    api.raiseHand(room, api.bot('ada'));
  },
  // Once you're in line, Sam finishes and the floor moves to Ada — watch
  // your place go from #2 to #1.
  onRaise(api) {
    if (api.state.moved) return;
    api.state.moved = true;
    api.after(4500, () => {
      const r = api.room();
      if (r && api.botPasses(r, api.bot('sam'))) api.broadcast();
    });
  },
};

const host = {
  title: 'Sunday Bible Study',
  youHost: true,
  populate: addAll(EVERYONE),
  arrange(api, room) {
    api.setMode(room, MODES.MODERATED);
    api.giveFloor(room, api.bot('sam'));
    api.raiseHand(room, api.bot('ada'));
    api.raiseHand(room, api.bot('tunde'));
  },
  open: OPEN_PANEL.people,
  onChange: keepALine,
};

const speak = {
  title: 'Sunday Bible Study',
  youHost: false,
  populate: addAll(EVERYONE),
  arrange(api, room) {
    api.setMode(room, MODES.MODERATED);
    api.giveFloor(room, 'demo-you');
    api.raiseHand(room, api.bot('ada'));
    api.raiseHand(room, api.bot('tunde'));
  },
  onGrant: talkThenPass,
};

const call = (extra) => ({
  title: 'Team meeting',
  youHost: true,
  populate: addAll(['grace', 'sam', 'ada', 'tunde']),
  openTalker: 'sam',
  ...extra,
});

export const SCENES = {
  // How it works
  raise,
  host,
  speak,
  // Everything a good meeting needs
  turns: { ...host, title: 'Team meeting' },
  recording: call({}),
  questions: call({
    arrange(api, room) {
      const [sam, ada, tunde, mia] = ['sam', 'ada', 'tunde', 'grace'].map(api.bot);
      const q1 = api.askQuestion(room, sam, 'Sam', 'Can we get the slides afterwards?');
      const q2 = api.askQuestion(room, ada, 'Ada', 'Will next week be at the same time?');
      api.voteQuestion(room, ada, q1.id);
      api.voteQuestion(room, tunde, q1.id);
      api.voteQuestion(room, mia, q2.id);
    },
    open: OPEN_PANEL.questions,
  }),
  breakouts: call({
    populate: addAll(['grace', 'sam', 'ada', 'tunde', 'mia', 'ben']),
    open: OPEN_PANEL.breakouts,
  }),
  link: call({ lobby: 'claim' }),
  schedule: call({ lobby: 'schedule' }),
  report: call({
    populate: addAll(['grace', 'sam', 'ada', 'tunde', 'ben', 'mia']),
    arrange(api, room) {
      const now = Date.now();
      const ago = (mins) => now - mins * 60_000;
      room.createdAt = ago(42); // the meeting started 42 minutes ago…
      if (room.stats['demo-you']) room.stats['demo-you'].joinedAt = ago(42); // …with you, the host
      for (const [who, joined, talkSecs, hands, turns] of REPORT_PEOPLE) {
        const s = room.stats[api.bot(who)];
        if (!s) continue;
        Object.assign(s, { joinedAt: ago(joined), talkMs: talkSecs * 1000, hands, turns });
      }
    },
    open: OPEN_PANEL.report,
  }),
  phones: { ...raise, title: 'Sunday Bible Study' },
  chat: call({
    title: 'Sunday Bible Study',
    arrange(api, room) {
      for (const [who, minsAgo, fields] of CHAT_HISTORY) {
        api.say(room, api.bot(who), { minsAgo, ...fields });
      }
    },
    open: OPEN_PANEL.chat,
  }),
};

for (const [id, scene] of Object.entries(SCENES)) scene.id = id;
