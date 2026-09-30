// "Your meeting is ready" — the meeting's invite link with a Copy button.
// Pops up for whoever starts a meeting, and reopens from the Invite button next
// to the meeting name. Bottom-left, above the door-lock button.

import { useRef, useState } from 'react';
import { inviteLink } from './meeting.js';
import { Check, Copy, X } from './icons.jsx';

export default function InviteCard({ roomId, locked, onClose }) {
  const link = inviteLink(roomId);
  const inputRef = useRef(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard API blocked (plain http, old browser): select the text so
      // Ctrl+C works, and try the legacy copy command.
      inputRef.current?.select();
      if (!document.execCommand('copy')) return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="invite" role="dialog" aria-label="Invite people">
      <button className="invite-close" onClick={onClose} aria-label="Close" title="Close">
        <X />
      </button>
      <strong>Your meeting is ready</strong>
      <p>Share this link with the people you want to join you.</p>
      <div className="invite-link">
        <input
          ref={inputRef}
          value={link}
          readOnly
          onFocus={(e) => e.target.select()}
          aria-label="Invite link"
        />
        <button onClick={copy} className={copied ? 'on' : ''}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {locked && (
        <p className="invite-note">
          The door is locked, so you&rsquo;ll admit each person as they arrive.
        </p>
      )}
    </div>
  );
}
