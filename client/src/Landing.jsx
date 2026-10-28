// The landing page — the first thing someone who's never heard of Turnly sees
// at the main address ("/"). A big centred headline on a dark, starry page,
// then the real app running live in a window (HeroDemo), how it works, what
// it does, who it's for, common questions, and "Start a meeting" (which goes
// to the app's home screen at /start).
//
// Meeting links (?room=…, /gracechurch) and recording links (?rec=…) never
// show this page — they go straight to the meeting (see main.jsx).

import { useEffect, useId, useState } from 'react';
import Logo from './Logo.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { PROFILE } from './profile.js';
import { FeatureTour, HeroDemo, HowItWorks } from './LandingDemos.jsx';
import { trackEvent } from './analytics.js';
import { markStartClick } from './startClick.js';
import LandingDock from './LandingDock.jsx';

const START = '/start'; // the app's home screen (start or join a meeting)

// The server's address. (Read here rather than from socket.js, so this page
// doesn't have to load the Socket.IO client just to say hello.)
const SERVER = import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001';

// ---- the words (edit here) ------------------------------------------------
const FEATURES = [
  ['✋', 'Taking turns', 'People raise a hand, join the line, and the host picks who goes next.'],
  [
    '⏺️',
    'Recording',
    'Record the call with video and sound. Everyone who was there gets the link afterwards.',
  ],
  [
    '❓',
    'Questions & polls',
    'Collect questions and let people vote on them, or run a quick poll with no names attached.',
  ],
  [
    '🧩',
    'Breakout rooms',
    'Split into small groups for a while, at random or hand picked, then bring everyone back.',
  ],
  ['🔗', 'Your own room link', 'A link that stays the same every week, like turnly/gracechurch.'],
  [
    '📅',
    'Scheduling',
    'Pick a time and send the invite. People’s calendars remind them 10 minutes before.',
  ],
  [
    '📊',
    'Meeting report',
    'See who came, who spoke and for how long. Spot who never got a word in.',
  ],
  ['📱', 'Works on phones', 'No app to install. Open the link and you’re in.'],
  [
    '💬',
    'Chat',
    'Everyone who joins sees what’s already been said, so nobody has to ask “what did I miss?”. Share photos and files, fix a typo, or take a message back.',
  ],
];

const AUDIENCES = [
  ['⛪', 'Churches', 'Bible study, prayer meetings and Q&A where the quiet ones get heard too.'],
  ['🎓', 'Classes', 'Students put a hand up instead of everyone unmuting at once.'],
  ['💼', 'Teams', 'Meetings that stay on topic and actually finish on time.'],
  ['🤝', 'Community groups', 'Town halls, clubs and associations where everyone gets a fair go.'],
];

const FAQ = [
  ['Is it free?', 'Yes, it’s free to use right now.'],
  ['Do I need an account?', 'No. Type your name and join. Nobody has to sign up.'],
  [
    'Do guests need to download anything?',
    'No. It runs in the browser on phones and laptops. Send them the link and that’s it.',
  ],
  [
    'Can anyone just talk?',
    'Up to you. Leave the room open for a normal chat, or switch on turns so people raise a hand first.',
  ],
];
// ---------------------------------------------------------------------------

// The footer's round "Social" icons: [link, label, icon]. Links live in
// profile.js. (Simple drawn icons, no image files.)
const IG = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <path d="M17.5 6.5h.01" />
  </svg>
);
const TIKTOK = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M16.6 3h-3.1v12.3a2.8 2.8 0 1 1-2.8-2.8c.3 0 .6 0 .9.1V9.4a6 6 0 1 0 5 5.9V9.1a7.6 7.6 0 0 0 4.4 1.4V7.4a4.4 4.4 0 0 1-4.4-4.4Z" />
  </svg>
);
// X (formerly Twitter): its "X" mark, filled
const XLOGO = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.8 3h3.1l-6.8 7.7 8 10.3h-6.3l-4.9-6.3L5.3 21H2.2l7.3-8.3L1.9 3h6.4l4.4 5.8Zm-1.1 16.2h1.7L7.4 4.7H5.6Z" />
  </svg>
);
// LinkedIn: the "in" mark, filled
const LINKEDIN = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M4.98 3.5a2.48 2.48 0 1 1 0 4.96 2.48 2.48 0 0 1 0-4.96ZM3 9.75h3.96V21H3V9.75Zm6.44 0h3.8v1.54h.05c.53-1 1.82-2.05 3.75-2.05 4 0 4.74 2.64 4.74 6.06V21h-3.95v-5.06c0-1.2-.02-2.76-1.68-2.76-1.69 0-1.95 1.32-1.95 2.67V21H9.44V9.75Z" />
  </svg>
);
const WHATSAPP = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3Z" />
  </svg>
);
const WEB = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
);
const SOCIAL = [
  [PROFILE.instagram, 'Instagram', IG],
  [PROFILE.tiktok, 'TikTok', TIKTOK],
  [PROFILE.x, 'X', XLOGO],
  [PROFILE.linkedin, 'LinkedIn', LINKEDIN],
  [PROFILE.contact, 'WhatsApp', WHATSAPP],
  [PROFILE.portfolio, 'Portfolio', WEB],
];

// A section's label: small spaced capitals between two fading lines
// ("——  FEATURES  ——").
function SectionLabel({ as: Tag = 'p', children }) {
  return (
    <Tag className="ld-label">
      <span>{children}</span>
    </Tag>
  );
}

// One common question. Tap to open: the answer smoothly grows open (and
// closes the same way) — see .ld-q-body in index.css.
function Question({ q, a }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`ld-q${open ? ' open' : ''}`}>
      <button
        type="button"
        className="ld-q-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {q}
      </button>
      <div className="ld-q-body" id={id} role="region" aria-hidden={!open}>
        <div>
          <p>{a}</p>
        </div>
      </div>
    </div>
  );
}

// A few faint stars behind the top of the page (they twinkle slowly).
// [left %, top px, size px, delay s]
const STARS = [
  [21, 120, 14, 0],
  [42, 70, 10, 1.6],
  [64, 300, 9, 0.8],
  [78, 210, 13, 2.4],
  [12, 330, 8, 3.1],
  [88, 90, 9, 1.1],
  [53, 470, 7, 2.0],
  [31, 520, 9, 0.4],
  [71, 560, 8, 2.8],
  [94, 400, 7, 1.9],
];

export default function Landing() {
  // Wake the server up while people read this page. On Render's free plan it
  // falls asleep after ~15 idle minutes and takes up to a minute to start
  // again — starting it now means it's usually awake by the time they click
  // through to a meeting (the lobby, PreJoin.jsx, does the same). The answer
  // itself doesn't matter.
  useEffect(() => {
    fetch(`${SERVER}/health`).catch(() => {});
  }, []);

  return (
    // id="top": where the dock's "Back to top" goes
    <div className="landing" id="top">
      <div className="ld-stars" aria-hidden="true">
        {STARS.map(([x, y, size, delay]) => (
          <span
            key={`${x}-${y}`}
            style={{ left: `${x}%`, top: y, fontSize: size, animationDelay: `${delay}s` }}
          >
            ✦
          </span>
        ))}
      </div>

      {/* --- top bar --- */}
      <header className="ld-top">
        <a href="/" className="ld-logo" aria-label="Turnly home">
          <Logo />
        </a>
        <nav className="ld-nav">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#who">Who it’s for</a>
          <a href="#faq">Questions</a>
        </nav>
        <div className="ld-top-right">
          <a className="ld-made" href={PROFILE.portfolio} target="_blank" rel="noreferrer">
            <span aria-hidden="true">♥</span> Made by {PROFILE.name}
          </a>
          <ThemeToggle />
        </div>
      </header>

      {/* --- 1. the top: what Turnly is --- */}
      <section className="ld-hero">
        {/* the big soft glow behind the headline, turned 45° */}
        <div className="ld-glow" aria-hidden="true" />
        <h1>
          <span className="dim">Every</span> voice <span className="dim">gets a</span> turn
          <span className="dim">.</span> <br />
          <span className="dim">Even in</span> big <span className="dim">meetings</span>
          <span className="dim">!</span>
        </h1>
        <p className="ld-lead">
          Video calls where people raise a hand and the host gives them the floor. So big meetings
          never turn into talking over each other.
        </p>
        <div className="ld-cta">
          <a
            href={START}
            className="ld-btn"
            onClick={() => {
              markStartClick(); // the water-filling splash on the start page (StartSplash.jsx)
              trackEvent('start clicked', { where: 'top' });
            }}
          >
            <span aria-hidden="true">▶</span> Start a meeting
          </a>
          <a href="#how" className="ld-btn ghost">
            <span aria-hidden="true">✋</span> See how it works
          </a>
        </div>
        <p className="ld-small">Free · No account · Nothing to install · Works on phones</p>
      </section>

      {/* --- 2. the real app, live (LandingDemos.jsx) --- */}
      <section className="ld-hero-show">
        <HeroDemo />
      </section>

      {/* --- 3. how it works: one band per step (LandingDemos.jsx) --- */}
      <div className="ld-block" id="how">
        <SectionLabel as="h2">How it works</SectionLabel>
        <HowItWorks />
      </div>

      {/* --- 4. features: one band per feature (LandingDemos.jsx) --- */}
      <div className="ld-block" id="features">
        <SectionLabel as="h2">Features</SectionLabel>
        <FeatureTour features={FEATURES} />
      </div>

      {/* --- 5. who it's for --- */}
      <section className="ld-section" id="who">
        <SectionLabel>Who it’s for</SectionLabel>
        <h2 className="ld-big">{'Made for groups where\neveryone should be heard.'}</h2>
        <div className="ld-audience">
          {AUDIENCES.map(([icon, title, text]) => (
            <div key={title} className="ld-card">
              <span className="ld-icon">{icon}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --- 6. common questions --- */}
      <section className="ld-section ld-faq" id="faq">
        <SectionLabel>Questions</SectionLabel>
        <h2 className="ld-big">Common questions.</h2>
        {FAQ.map(([q, a]) => (
          <Question key={q} q={q} a={a} />
        ))}
      </section>

      {/* --- 7. the footer: last call, contact, and a giant TURNLY ---
          A big two-line headline (the end of "are." fades to grey) with
          Start a meeting; Email | Social; a thin line; the small print; and
          the TURNLY wordmark cut off by the bottom edge, dissolving into
          blur. The details come from profile.js. */}
      <footer className="ld-foot">
        <div className="ld-foot-in">
          <h2 className="ld-foot-title">
            Ready when
            <br />
            you <span className="ld-foot-fade">are.</span>
          </h2>
          <a
            href={START}
            className="ld-btn ld-foot-cta"
            onClick={() => {
              markStartClick(); // the water-filling splash on the start page (StartSplash.jsx)
              trackEvent('start clicked', { where: 'bottom' });
            }}
          >
            <span aria-hidden="true">▶</span> Start a meeting
          </a>

          <div className="ld-foot-contact">
            <div>
              <p className="ld-foot-label">Email</p>
              <a className="ld-foot-email" href={`mailto:${PROFILE.email}`}>
                {PROFILE.email}
              </a>
            </div>
            <div>
              <p className="ld-foot-label">Social</p>
              <div className="ld-foot-social">
                {SOCIAL.map(([href, label, Icon]) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={label}
                    title={label}
                  >
                    <Icon />
                  </a>
                ))}
              </div>
            </div>
          </div>

          <div className="ld-foot-small">
            <span className="ld-foot-left">
              <span>Based in {PROFILE.basedIn}</span>
              <a href="/privacy">Privacy &amp; terms</a>
              <span>
                Made by{' '}
                <a href={PROFILE.portfolio} target="_blank" rel="noreferrer">
                  {PROFILE.name}
                </a>
              </span>
            </span>
            <span>© {new Date().getFullYear()} Turnly</span>
          </div>

          {/* the giant wordmark (decoration — the name is already above) */}
          <div className="ld-foot-giant" aria-hidden="true">
            <span>TURNLY</span>
          </div>
        </div>
      </footer>

      {/* --- the floating dock at the bottom: appears once you reach the demo
          picture (LandingDock.jsx) --- */}
      <LandingDock start={START} />
    </div>
  );
}
