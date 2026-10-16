// The privacy page (/privacy), with short terms of use at the bottom.
//
// Written from what the code actually does — if that changes (a new service,
// something kept longer), update this page too. The places it describes:
//   meetings + chat     server/src/rooms.js (in memory only)
//   chat files          server/src/chatFiles.js (storage, a day at most)
//   recordings          server/src/recordings.js (deleted a day after)
//   room names          server/src/names.js
//   reviews             server/src/index.js POST /feedback (emailed via Resend)
//   error reports       client/src/errorReport.js -> the server's log
//   browser storage     theme.js, App.jsx (layout), useTour.js, PreJoin.jsx,
//                       roomNames.js (host keys), webrtc.js (noise setting)
//   outside services    Render, Cloudflare (R2 + Realtime), Resend, Google
//                       Fonts, Wikipedia + Jikan (character pictures)
// It is plain-language information, not legal advice — have it checked.

import Logo from './Logo.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { PROFILE } from './ProfileCard.jsx';

const CONTACT = 'garrywilliams20@protonmail.com';
const UPDATED = '16 October 2026';

export default function PrivacyPage() {
  return (
    <div className="landing ld-legal-page">
      <header className="ld-top">
        <a href="/" className="ld-logo" aria-label="Turnly home">
          <Logo />
        </a>
        <div className="ld-top-right">
          <ThemeToggle />
        </div>
      </header>

      <main className="ld-legal">
        <h1>Privacy</h1>
        <p className="ld-legal-meta">
          Last updated {UPDATED} · Turnly is run by {PROFILE.name}, based in Nigeria · Questions or
          requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
        </p>

        <p className="ld-legal-lead">
          Turnly has no accounts, no ads and no tracking. We keep as little as we can, for as short
          a time as we can, and only to run your meetings. This page says exactly what that is.
        </p>

        <h2>What we keep, and for how long</h2>
        <dl className="ld-legal-list">
          <dt>Your name, picture and the meeting’s name</dt>
          <dd>
            What you type when you join (and the picture you choose, if any) is shared with the
            others in your meeting. It’s held in the server’s memory only while the meeting is on,
            and is gone when it ends.
          </dd>

          <dt>Chat messages</dt>
          <dd>
            Held in memory during the meeting so people who join late can catch up. Gone when the
            meeting ends. You can unsend your own messages; the host can delete any message.
          </dd>

          <dt>Photos and files sent in the chat</dt>
          <dd>
            Stored so everyone in the meeting can open them, behind a private link. Deleted when the
            sender unsends them, when the meeting ends, and in any case within a day.
          </dd>

          <dt>Recordings</dt>
          <dd>
            Only if the host starts one, and everyone in the meeting sees that it’s being recorded.
            Anyone with the link can watch it, and it is deleted a day after the meeting ends.
          </dd>

          <dt>Permanent room names and scheduled meetings</dt>
          <dd>
            If you claim a name (like turnly/your-group) or schedule a meeting, we keep the name,
            the meeting’s title and time, and a scrambled copy of its host key (never the key
            itself). One-off scheduled meetings are deleted a day after they end; claimed names are
            kept until you ask us to delete them.
          </dd>

          <dt>Reviews</dt>
          <dd>
            If you send a review after a meeting, it’s emailed to us with the name you gave, the
            meeting’s name, and whether you used a phone or computer and which browser.
          </dd>

          <dt>Error reports</dt>
          <dd>
            When something goes wrong in your browser — a crash, or a call that fails to connect — a
            short technical description and which browser you use are written to our server’s log,
            so we can fix it. Never the page address, your name or your messages. Logs are kept only
            briefly by our hosting provider.
          </dd>
        </dl>

        <h2>Audio and video</h2>
        <p>
          Your camera and microphone are only used during a meeting, and only after your browser
          asks your permission. Audio and video go straight to the other people in the meeting, or
          through Cloudflare’s video relay when a direct connection isn’t possible. We don’t store
          them — unless the host records the meeting (see above).
        </p>

        <h2>Stored in your own browser</h2>
        <p>
          A few small settings are saved on your device, not on our servers: light or dark mode,
          your layout and noise-reduction choices, which tips you’ve already seen, and the host keys
          for room names you’ve claimed. Clearing your browser’s site data removes them. We don’t
          use cookies for tracking.
        </p>

        <h2>Services we use</h2>
        <ul>
          <li>
            <b>Render</b> hosts the website and the server (and keeps its logs).
          </li>
          <li>
            <b>Cloudflare</b> stores recordings, chat files and room names (R2), and relays audio
            and video when needed.
          </li>
          <li>
            <b>Resend</b> delivers review emails to us.
          </li>
          <li>
            <b>Google Fonts</b> provides the site’s fonts, so your browser contacts Google when it
            loads them.
          </li>
          <li>
            <b>Wikipedia</b> and <b>Jikan</b> (an anime database) answer the character-picture
            search when you look for a picture; what you type is sent to them, and the picture you
            pick is loaded from their sites.
          </li>
        </ul>
        <p>We never sell or rent anything about you, and we don’t share it with anyone else.</p>

        <h2>Your rights</h2>
        <p>
          You can ask us what we hold about you, to correct it, or to delete it — including a
          claimed room name or a recording before its day is up. Email{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We follow the Nigeria Data Protection Act; if
          you’re unhappy with how we handle a request you can complain to the Nigeria Data
          Protection Commission. If you’re elsewhere, your local data protection authority.
        </p>

        <h2>Children</h2>
        <p>
          Turnly isn’t meant for children under 13 on their own. If a child uses it, a parent,
          teacher or leader should run the meeting.
        </p>

        <h2 id="terms">Terms of use</h2>
        <p>By using Turnly you agree to these simple rules:</p>
        <ul>
          <li>
            Use it lawfully and kindly: no harassment, hate, threats, or sharing things you don’t
            have the right to share.
          </li>
          <li>
            Ask before you record. The host is responsible for having everyone’s agreement, and for
            anything they do with a recording.
          </li>
          <li>What you say, share and send in a meeting is yours, and your responsibility.</li>
          <li>
            Turnly is free and provided as it is. We work to keep it running well, but can’t promise
            it will always be available or error-free, and aren’t liable for losses from using it.
          </li>
          <li>
            We may remove a room name, or block access, that’s used to break these rules. We may
            update this page; the date at the top says when it last changed.
          </li>
        </ul>

        <p className="ld-legal-back">
          <a href="/">← Back to Turnly</a>
        </p>
      </main>
    </div>
  );
}
