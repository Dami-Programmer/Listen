// The landing page — the first thing someone who's never heard of Turnly sees
// at the main address ("/"). A big centred headline on a dark, starry page,
// then the real app running live in a window (HeroDemo), how it works, what
// it does, who it's for, common questions, and "Start a meeting" (which goes
// to the app's home screen at /start).
//
// Meeting links (?room=…, /gracechurch) and recording links (?rec=…) never
// show this page — they go straight to the meeting (see main.jsx).

import { useId, useState } from 'react';
import Logo from './Logo.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { PROFILE } from './profile.js';
import { FeatureTour, HeroDemo, HowItWorks } from './LandingDemos.jsx';
import { trackEvent } from './analytics.js';

const START = '/start'; // the app's home screen (start or join a meeting)

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
    '🎧',
    'Noise reduction',
    'The fan, the traffic, the kids in the next room. Turnly quietens all of it.',
  ],
  ['📱', 'Works on phones', 'No app to install. Open the link and you’re in.'],
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
  return (
    <div className="landing">
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
            onClick={() => trackEvent('start clicked', { where: 'top' })}
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

      {/* --- 7. last call --- */}
      <section className="ld-final">
        <h2>Ready when you are.</h2>
        <p>Start a meeting and share the link. It takes a few seconds.</p>
        <a
          href={START}
          className="ld-btn"
          onClick={() => trackEvent('start clicked', { where: 'bottom' })}
        >
          Start a meeting
        </a>
      </section>

      <footer className="ld-foot">
        <span>© {new Date().getFullYear()} Turnly. Every voice gets a turn.</span>
        <span className="ld-foot-links">
          <a href="/privacy">Privacy &amp; terms</a>
          <span>
            Made by{' '}
            <a href={PROFILE.portfolio} target="_blank" rel="noreferrer">
              {PROFILE.name}
            </a>
          </span>
        </span>
      </footer>
    </div>
  );
}
