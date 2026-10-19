// "Get a permanent link for your group" (from the home screen): claim a name
// like gracechurch, and the group meets at turnly.io/gracechurch every time.
//
// Step 1: type the group's name; a link name is suggested and checked as you
//         type (free / taken).
// Step 2: claimed — two links: the one to share, and the private HOST link
//         (shown only now; it's what makes you the host). The host key is
//         also remembered on this device. "Use it now" fills in the room.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SIGNALING_URL } from './socket.js';
import { Copy, Check, LinkIcon, X } from './icons.jsx';
import { nameFromTitle, nameLinks, saveHostKey } from './roomNames.js';

// Wait this long after typing stops before checking the name.
const CHECK_DELAY_MS = 400;

function CopyRow({ label, value, hint }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this link:', value);
    }
  }
  return (
    <div className="claim-link">
      <span className="claim-link-label">{label}</span>
      <div className="claim-link-row">
        <input value={value} readOnly onFocus={(e) => e.target.select()} aria-label={label} />
        <button type="button" className="claim-copy" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {hint && <span className="claim-link-hint">{hint}</span>}
    </div>
  );
}

/**
 * @param {Function} props.onClose
 * @param {Function} props.onUse   (name, title) — fill in the room to join now
 */
export default function ClaimRoom({ onClose, onUse }) {
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [check, setCheck] = useState(null); // null | 'checking' | 'free' | 'taken' | 'invalid'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [claimed, setClaimed] = useState(null); // { name, hostKey }

  // Suggest the link name from the group's name until it's edited by hand.
  useEffect(() => {
    if (!nameEdited) setName(nameFromTitle(title));
  }, [title, nameEdited]);

  // Is it free? (checked shortly after typing stops)
  useEffect(() => {
    if (!name) {
      setCheck(null);
      return undefined;
    }
    setCheck('checking');
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${SIGNALING_URL}/names/${encodeURIComponent(name)}`);
        const data = await r.json();
        setCheck(!data.valid ? 'invalid' : data.available ? 'free' : 'taken');
      } catch {
        setCheck(null);
      }
    }, CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [name]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function claim(e) {
    e.preventDefault();
    if (!title.trim()) return setError('Type your group’s name first.');
    if (check !== 'free') return setError('Pick a link name that’s free.');
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${SIGNALING_URL}/names`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, title: title.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || 'Couldn’t claim it. Try again.');
      saveHostKey(data.name, data.hostKey); // this device is the host's
      setClaimed({ name: data.name, hostKey: data.hostKey });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  const links = claimed && nameLinks(claimed.name, claimed.hostKey);
  const status = {
    checking: 'Checking…',
    free: '✓ Free',
    taken: 'Taken. Try another',
    invalid: '3-30 letters, numbers or hyphens',
  }[check];

  // Drawn straight onto the page (a portal), not inside the lobby: the
  // lobby's rise-in animation would otherwise shrink the full-screen dark
  // backdrop to the lobby's own box.
  return createPortal(
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-card claim-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* icon tile · title + one grey line · round ✕ */}
        <div className="report-head dlg-head">
          <span className={`dlg-icon${claimed ? ' ok' : ''}`} aria-hidden="true">
            {claimed ? <Check /> : <LinkIcon />}
          </span>
          <div className="dlg-head-text">
            <h2 id="claim-title" className="confirm-title">
              {claimed ? 'Your permanent link' : 'A permanent link for your group'}
            </h2>
            <p className="dlg-sub">
              {claimed
                ? 'Share the first link. Keep the second one to yourself.'
                : 'Same link every time, and you’re always the host.'}
            </p>
          </div>
          <button type="button" className="report-x" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>

        {!claimed ? (
          <form className="claim-form" onSubmit={claim}>
            <label className="poll-label field">
              <span>Your group’s name</span>
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setError(null);
                }}
                placeholder="Grace Church"
                maxLength={80}
                autoFocus
              />
            </label>
            {/* the site's address in grey, then the name you type */}
            <label className="poll-label field">
              <span>Your link</span>
              <span className="claim-url">
                <span className="claim-origin">{window.location.host}/</span>
                <input
                  value={name}
                  onChange={(e) => {
                    setNameEdited(true);
                    setName(
                      e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, '')
                        .slice(0, 30),
                    );
                    setError(null);
                  }}
                  placeholder="gracechurch"
                  aria-label="Link name"
                />
              </span>
              {status && <span className={`claim-status ${check}`}>{status}</span>}
            </label>
            {error && <p className="qa-error">{error}</p>}
            <div className="dlg-foot">
              <button type="button" className="confirm-btn cancel" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="qa-send claim-go" disabled={busy}>
                {busy ? 'Claiming…' : 'Claim this link'}
              </button>
            </div>
          </form>
        ) : (
          <div className="claim-form">
            <CopyRow
              label="Share this with your group"
              value={links.share}
              hint="The same link every time. People can save it."
            />
            <CopyRow
              label="Your private host link"
              value={links.host}
              hint="Keep it to yourself: whoever opens it is the host. It’s saved on this device; open it once on any other device you host from. It can’t be shown again."
            />
            <div className="dlg-foot">
              <button
                type="button"
                className="qa-send claim-go"
                onClick={() => onUse(claimed.name, title.trim())}
              >
                Use it now
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
