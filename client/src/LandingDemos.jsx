// The landing page's live product demos (used by Landing.jsx):
//
//   <HowItWorks />    one band: the three steps as a list on the left (click
//                     one to preview it), the real Turnly app playing that
//                     moment of a meeting on the right.
//   <FeatureTour />   the features, the same way: pick one from the list.
//
// The screen on the left is the REAL app: a frame showing /demo?scene=…
// (demo/DemoApp.jsx), where Turnly's own call screen, lobby, chat, questions,
// polls, breakout rooms and settings run against a pretend server inside the
// page, with pretend participants (drawn cameras). Nothing there reaches a
// real meeting, the real server, or the visitor's camera and microphone.
//
// The app only runs while it's on (or near) the screen.

import { useEffect, useRef, useState } from 'react';
import { Check } from './icons.jsx';
import { trackEvent } from './analytics.js';

// The app inside the frame is laid out at a real screen size, then scaled
// to fit — so it looks exactly like Turnly on a laptop or a phone.
// (a small laptop: still the full desktop layout, but less shrinking needed)
const DESKTOP = { w: 1100, h: 700 };
const PHONE = { w: 390, h: 844 };
const NARROW_PX = 760; // below this the landing page shows the phone layout

const themeNow = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

// 'light' or 'dark', kept up to date as the landing page switches (the theme
// button sets data-theme on <html>, also when it follows the device).
function useThemeNow() {
  const [theme, setTheme] = useState(themeNow);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(themeNow()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

// =============================================================================
// The screen: the real app in a frame, scaled to fit
// =============================================================================

// How long a demo may take to start before the cover gives up and offers
// "Try again". Generous on purpose: on a slow phone connection the first
// start (the app's code plus the pretend people's photos) can take a while.
const DEMO_TIMEOUT_MS = 20_000;

function DemoScreen({ scene, phone, run, label }) {
  const box = useRef(null);
  const frame = useRef(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState(false); // on (or close to) the screen
  // which demo said "ready" — the cover lifts only for the one on show
  const [readyFor, setReadyFor] = useState(null);
  // which demo failed: didn't start in time, or crashed (its error screen
  // tells us — ErrorBoundary.jsx)
  const [failedFor, setFailedFor] = useState(null);
  const [tries, setTries] = useState(0); // "Try again" = a fresh start
  const size = phone ? PHONE : DESKTOP;
  const appKey = `${scene}-${run}-${tries}-${phone ? 'p' : 'd'}${near ? '' : '-off'}`;
  const failed = failedFor === appKey;
  const ready = readyFor === appKey && !failed;
  const started = near && width > 0; // the frame is loading / running

  // How wide the space is (the app is scaled to it).
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Run the app only while it's on the screen, so there's (almost) never more
  // than one demo running at once:
  //   - it STARTS once at least a third of it is showing (not before — it
  //     used to start 300px early, so scrolling between two demos ran both)
  //   - it STOPS only once it's gone completely (so a small scroll doesn't
  //     restart it), and starts fresh when you come back
  // And not before the landing page itself has finished loading: the demo at
  // the top would otherwise compete with the page for the first few seconds.
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    let io = null;
    const watch = () => {
      io = new IntersectionObserver(
        ([e]) => {
          if (e.intersectionRatio >= 1 / 3) setNear(true);
          else if (!e.isIntersecting) setNear(false);
        },
        { threshold: [0, 1 / 3] },
      );
      io.observe(el);
    };
    if (document.readyState === 'complete') watch();
    else window.addEventListener('load', watch, { once: true });
    return () => {
      window.removeEventListener('load', watch);
      io?.disconnect();
    };
  }, []);

  // Off the screen the app stops; coming back starts it again, so the
  // cover goes back up until it says it's ready.
  useEffect(() => {
    if (!near) {
      setReadyFor(null);
      setFailedFor(null);
    }
  }, [near]);

  // Messages from the app in the frame:
  //   "ready"  (DemoApp.jsx)       hide the cover — even if it had given up
  //   "failed" (ErrorBoundary.jsx) it crashed: show "Couldn't start the demo"
  useEffect(() => {
    const onMessage = (e) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'turnly-demo-ready') {
        setReadyFor(appKey);
        setFailedFor((f) => (f === appKey ? null : f)); // made it after all
        trackEvent('demo played', { scene }); // (analytics.js)
      }
      if (e.data?.type === 'turnly-demo-failed') {
        setFailedFor(appKey);
        trackEvent('demo failed', { scene });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appKey, scene]);

  // Not ready in time: give up waiting and offer "Try again" (instead of a
  // spinner that turns for ever — e.g. when the demo page itself can't load).
  useEffect(() => {
    if (!started || readyFor === appKey) return undefined;
    const t = setTimeout(() => setFailedFor(appKey), DEMO_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [started, readyFor, appKey]);

  // The landing page switches light / dark: the app follows.
  useEffect(() => {
    const mo = new MutationObserver(() =>
      frame.current?.contentWindow?.postMessage(
        { type: 'turnly-demo-theme', theme: themeNow() },
        window.location.origin,
      ),
    );
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  // Phone: as tall as fits nicely; desktop: as wide as the column.
  const phoneH = Math.min(580, Math.max(440, width * 1.2));
  const PHONE_PAD = 26; // room around the phone for its edge
  const scale = phone ? phoneH / size.h : width / size.w;
  const stageH = phone ? phoneH + PHONE_PAD * 2 : size.h * scale;

  return (
    <div className={`ld-frame${phone ? ' phone' : ''}`}>
      <div className="ld-frame-bar" aria-hidden="true">
        <span className="ld-dot" />
        <span className="ld-dot" />
        <span className="ld-dot" />
        <span className="ld-frame-url">turnly · live demo</span>
        <span className="ld-frame-tag">Pretend people, nothing here is real</span>
      </div>
      <div className="ld-frame-stage" ref={box} style={{ height: stageH || undefined }}>
        {started && (
          <div
            className="ld-frame-app"
            style={{
              width: size.w,
              height: size.h,
              top: phone ? PHONE_PAD : 0,
              transform: `scale(${scale})`,
              left: phone ? `calc(50% - ${(size.w * scale) / 2}px)` : 0,
            }}
          >
            <iframe
              key={appKey}
              ref={frame}
              title={label}
              src={`/demo?scene=${scene}&theme=${themeNow()}`}
              width={size.w}
              height={size.h}
              allow="clipboard-write; autoplay"
              // its own sandbox: it can't open or change the landing page
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            />
          </div>
        )}
        <div className={`ld-frame-cover${ready ? ' gone' : ''}`} aria-hidden={ready}>
          {failed ? (
            <>
              <span role="alert">Couldn’t start the demo</span>
              <button
                type="button"
                className="ld-frame-retry"
                onClick={() => setTries((n) => n + 1)}
              >
                Try again
              </button>
            </>
          ) : (
            <>
              <span className="ld-spinner" />
              Starting the demo meeting…
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// One band: the story on the left, the live app on the right
// =============================================================================

// The words for one step / feature: label, heading, text, ticks, "Try it",
// and Replay.
function StoryBody({ item, index, onReplay, extra, headingId }) {
  return (
    <>
      <p className="ld-eyebrow">
        <span>{String(index + 1).padStart(2, '0')} /</span> {item.label}
      </p>
      <h3 id={headingId}>{item.heading}</h3>
      <p className="ld-story-text">{item.text}</p>
      <ul className="ld-points">
        {item.points.map((p) => (
          <li key={p}>
            <Check />
            {p}
          </li>
        ))}
      </ul>
      {item.tryIt && (
        <p className="ld-tryit">
          <b>Try it</b> {item.tryIt}
        </p>
      )}
      {item.note && <p className="ld-sim">{item.note}</p>}
      {extra}
      <button type="button" className="ld-replay" onClick={onReplay}>
        ↺ Replay this demo
      </button>
    </>
  );
}

// =============================================================================
// Under the headline: the app, big, on a dotted panel
// =============================================================================

// The host's view of a meeting in full swing: the line of raised hands, the
// person talking, everyone else — as two FIXED pictures, not the live app:
// the desktop call in the window frame, and the same meeting on a phone
// overlapping its bottom-left corner. Pictures appear instantly and cost
// nothing to run; the live demos further down ("How it works", "Features")
// stay live.
//
// The pictures are screenshots of the demo's "turns" scene
// (/demo?scene=turns&theme=dark or light): public/hero-desktop.webp (dark)
// and public/hero-desktop-light.webp (light), both a 1440 x 880 screen at
// 1.5x, and public/hero-phone.webp (390 x 844 screen, at 2x). The phone has
// only one picture: the app's phone call screen is dark in both themes. To
// refresh them after the call screen changes, screenshot that page again at
// those sizes.
//
// The desktop picture follows the landing page's light / dark switch: only
// the one on show is downloaded.
export function HeroDemo() {
  const theme = useThemeNow();
  return (
    <div className={`ld-hero-panel ld-hero-shots${theme === 'light' ? ' light' : ''}`}>
      <div className="ld-frame">
        <div className="ld-frame-bar" aria-hidden="true">
          <span className="ld-dot" />
          <span className="ld-dot" />
          <span className="ld-dot" />
          <span className="ld-frame-url">turnly · team meeting</span>
          <span className="ld-frame-tag">Pretend people, nothing here is real</span>
        </div>
        <img
          className="ld-hero-desktop"
          src={theme === 'light' ? '/hero-desktop-light.webp' : '/hero-desktop.webp'}
          width={2160}
          height={1320}
          // the top of the page: load it first. (Lowercase on purpose: this
          // React version passes it through only as the plain HTML attribute,
          // and warns about the camelCase spelling the lint rule expects.)
          // eslint-disable-next-line react/no-unknown-property
          fetchpriority="high"
          alt="Turnly on a computer: the host sees who's talking, who's next, and grants raised hands from the side panel"
        />
      </div>
      <div className="ld-hero-phone">
        <img
          src="/hero-phone.webp"
          width={780}
          height={1688}
          alt="The same meeting on a phone: the person talking, everyone else in a strip down the side"
        />
      </div>
    </div>
  );
}

// =============================================================================
// How it works
// =============================================================================

const STEP_STORIES = [
  {
    scene: 'raise',
    title: 'Raise your hand',
    label: 'RAISE YOUR HAND',
    heading: 'It starts with\na raised hand.',
    text: 'Want to say something? Put your hand up and you join the line. Everyone can see who’s waiting and who’s next.',
    points: [
      'One tap puts you in line',
      'Everyone sees the order',
      'Changed your mind? Put it down',
    ],
    tryIt:
      'Press ✋ at the bottom. You’ll be second in line. Give it a few seconds, Sam wraps up and you move up.',
  },
  {
    scene: 'host',
    title: 'The host gives you the floor',
    label: 'THE HOST GIVES YOU THE FLOOR',
    heading: 'The host picks\nwho’s next.',
    text: 'The host sees everyone who’s waiting and lets them speak one at a time, so nobody gets cut off.',
    points: [
      'Give someone the floor, or take it back',
      'See who’s waiting, in order',
      'Keep things calm and on track',
    ],
    tryIt:
      'You’re the host here. Press Grant next to a raised hand. Then switch Moderated to Open at the top and see what changes.',
  },
  {
    scene: 'speak',
    title: 'You speak, everyone listens',
    label: 'YOU SPEAK, EVERYONE LISTENS',
    heading: 'One person talks.\nEveryone listens.',
    text: 'When it’s your turn, the floor is yours. When you’re finished, you pass it on and the next person speaks.',
    points: [
      'Everyone can see who’s talking',
      'Turns that don’t overlap',
      'Calmer, easier conversations',
    ],
    tryIt:
      'You’ve got the floor. Press 🎤 Pass the mic. Ada goes next, and then she hands it on too.',
  },
];

// One band: a list on the left (click one to preview it), its words under
// the list, and the real app playing it on the right.
function PickOne({ items, name, extras = {} }) {
  const narrow = useNarrow();
  const [active, setActive] = useState(0);
  const [run, setRun] = useState(0); // bump = start the demo over
  const item = items[active];
  return (
    <div className="ld-bands">
      <section className="ld-band" aria-label={name}>
        <div className="ld-band-in">
          {/* the row of tabs: one click to preview each */}
          <div className="ld-steplist" role="tablist" aria-label={name}>
            {items.map((it, i) => (
              <button
                key={it.scene}
                type="button"
                role="tab"
                id={`ld-pick-${it.scene}`}
                aria-selected={active === i}
                aria-controls={`ld-panel-${name}`}
                className={`ld-stepitem${active === i ? ' on' : ''}`}
                onClick={() => setActive(i)}
              >
                <span className="ld-stepitem-n">{String(i + 1).padStart(2, '0')}</span>
                {it.title}
              </button>
            ))}
          </div>
          <div className="ld-story">
            <div
              className="ld-stepbody"
              key={item.scene /* fades in when the pick changes */}
              id={`ld-panel-${name}`}
              role="tabpanel"
              aria-labelledby={`ld-pick-${item.scene}`}
            >
              <StoryBody
                item={item}
                index={active}
                extra={extras[item.scene]}
                onReplay={() => setRun((n) => n + 1)}
              />
            </div>
          </div>
          <DemoScreen
            scene={item.scene}
            phone={narrow || item.phone}
            run={run}
            label={`Live Turnly demo: ${item.label.toLowerCase()}`}
          />
        </div>
      </section>
    </div>
  );
}

export function HowItWorks() {
  return <PickOne items={STEP_STORIES} name="How it works" />;
}

// =============================================================================
// Everything a good meeting needs
// =============================================================================

// The words on the right for each feature (names + descriptions come from
// Landing.jsx's FEATURES, in the same order).
const FEATURE_STORIES = [
  {
    scene: 'turns',
    heading: 'Taking turns,\nwithout the chaos.',
    points: [
      'Raise and lower hands',
      'Give the floor or take it back',
      'Switch between Open and Moderated',
    ],
    tryIt:
      'Grant someone’s hand in the panel, move people up and down the line, or switch Moderated to Open.',
  },
  {
    scene: 'recording',
    heading: 'Record it.\nShare it with everyone.',
    points: [
      'The host or cohost starts it',
      'Everyone can see it’s recording',
      'Everyone who was there gets the link',
    ],
    tryIt: 'Press ⏺ at the bottom, confirm, then stop it again.',
    note: 'This is a demo. Your browser really records, then we throw it away. Nothing is saved.',
  },
  {
    scene: 'questions',
    heading: 'Hear from\nthe whole room.',
    points: [
      'Ask questions and vote on them',
      'Run a poll with no names attached',
      'Watch the results come in',
    ],
    tryIt: 'Ask something, then open the Poll tab and start one. The others will vote.',
  },
  {
    scene: 'breakouts',
    heading: 'Small groups,\none tap away.',
    points: [
      'Shuffle people or pick the groups yourself',
      'Move anyone to another room',
      'Bring everyone back with one tap',
    ],
    tryIt: 'Press Start. Then press Manage to move someone, or End now to call everyone back.',
  },
  {
    scene: 'link',
    heading: 'One link your\ngroup remembers.',
    points: [
      'Claim your group’s name once',
      'The same link every week',
      'A private host link, just for you',
    ],
    tryIt: 'Type your group’s name, check it’s free and claim it. The Copy buttons work.',
    note: 'This is a demo, so nothing actually gets claimed.',
  },
  {
    scene: 'schedule',
    heading: 'Plan it once.\nCalendars do the rest.',
    points: [
      'Pick a date and time',
      'Add it to any calendar',
      'People get a reminder 10 minutes before',
    ],
    tryIt: 'Set a time and press Schedule to see the invite.',
    note: 'This is a demo, so nothing gets booked. The calendar buttons do work, so only press them if you want the sample event.',
  },
  {
    scene: 'noise',
    heading: 'Leave the noise\nbehind.',
    points: [
      'Strong noise removal, built in',
      'Switch it on from the mic menu',
      'Works on phones and computers',
    ],
    tryIt: 'Flip Strong noise reduction in the open mic menu. That’s the real setting.',
    note: 'Want to hear the difference? Play the sample below. We make the sound in your browser, and your microphone isn’t used.',
  },
  {
    scene: 'phones',
    heading: 'The whole meeting\nfits in a pocket.',
    phone: true,
    points: [
      'Nothing to install',
      'Every feature works on a phone',
      'The same meeting on any device',
    ],
    tryIt: 'Tap ✋ to raise your hand, or tap the people icon to see the line.',
  },
];

export function FeatureTour({ features }) {
  const items = features.map(([icon, title, text], i) => ({
    heading: title,
    ...FEATURE_STORIES[i],
    icon,
    title,
    label: title.toUpperCase(),
    text,
  }));
  return <PickOne items={items} name="Features" extras={{ noise: <NoiseSample /> }} />;
}

// =============================================================================
// Noise reduction: a clearly made-up sound to hear the difference
// =============================================================================

// A "voice" plus fan noise, generated in the browser; the switch turns the
// noise down like the filter would. The visitor's microphone is never used,
// and nothing plays until they press Play.
function NoiseSample() {
  const [playing, setPlaying] = useState(false);
  const [on, setOn] = useState(false);
  const audio = useRef(null); // { ctx, noise }

  const stop = () => {
    audio.current?.ctx.close();
    audio.current = null;
    setPlaying(false);
  };
  useEffect(() => () => audio.current?.ctx.close(), []); // leaving stops the sound

  const play = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(ctx.destination);
    // the "voice": a buzzy tone shaped like speech, in syllables
    const voice = ctx.createOscillator();
    voice.type = 'sawtooth';
    voice.frequency.value = 150;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 12;
    vib.connect(vibDepth).connect(voice.frequency);
    const mouth = ctx.createBiquadFilter();
    mouth.type = 'bandpass';
    mouth.frequency.value = 900;
    mouth.Q.value = 1.2;
    const level = ctx.createGain();
    level.gain.value = 0.12;
    const syl = ctx.createOscillator();
    syl.frequency.value = 3.5;
    const sylDepth = ctx.createGain();
    sylDepth.gain.value = 0.12;
    syl.connect(sylDepth).connect(level.gain);
    voice.connect(mouth).connect(level).connect(out);
    // the "fan": steady rushing noise
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04;
      data[i] = last * 3.5;
    }
    const hiss = ctx.createBufferSource();
    hiss.buffer = buf;
    hiss.loop = true;
    const noise = ctx.createGain();
    noise.gain.value = on ? 0.02 : 0.5;
    hiss.connect(noise).connect(out);
    for (const n of [voice, vib, syl, hiss]) n.start();
    audio.current = { ctx, noise };
    setPlaying(true);
  };

  const toggle = () => {
    const next = !on;
    setOn(next);
    const a = audio.current;
    if (a) a.noise.gain.setTargetAtTime(next ? 0.02 : 0.5, a.ctx.currentTime, 0.08);
  };

  return (
    <div className="ld-noise">
      <div className="ld-row">
        <button
          type="button"
          className={`ld-act${playing ? '' : ' primary'}`}
          onClick={playing ? stop : play}
        >
          {playing ? '■ Stop sound' : '▶ Play sample sound'}
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`ld-switch${on ? ' on' : ''}`}
          onClick={toggle}
        >
          <span className="ld-switch-knob" />
          Filter {on ? 'on' : 'off'}
        </button>
      </div>
    </div>
  );
}
