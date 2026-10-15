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
  people: { desktop: [['.cs-chat-btn'], ['.cp-people-btn']], phone: [] },
  questions: {
    desktop: [['.cs-chat-btn'], ['.cp-tab', 'Questions']],
    phone: [['.mc-people'], ['.mc-tab', 'Questions']],
  },
  breakouts: {
    desktop: [['.cs-chat-btn'], ['.cp-people-btn'], ['.cp-report-btn', 'Breakout']],
    phone: [['.mc-people'], ['.cp-report-btn', 'Breakout']],
  },
  mic: { desktop: [['[aria-label="Choose microphone"]']], phone: [] },
};

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
  noise: call({ open: OPEN_PANEL.mic }),
  phones: { ...raise, title: 'Sunday Bible Study' },
};

for (const [id, scene] of Object.entries(SCENES)) scene.id = id;
