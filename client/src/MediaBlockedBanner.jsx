// "Your audio and video can't connect" across the top of the screen. Shown by
// <CallView/> while my connection to Cloudflare (sfu.js) hasn't come up at all
// — almost always a network that blocks calls (strict office / school Wi-Fi).
// Everyone is still listed in the meeting, so without this it just looks like
// silence. Same place and look as "You lost your connection"
// (ReconnectBanner.jsx), desktop and phones.
//
// It goes away by itself when the connection comes up. Dismiss hides it until
// the next time (the banner is unmounted when the connection comes up, so its
// `dismissed` starts fresh).

import { useState } from 'react';

export default function MediaBlockedBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="reconnect-banner media-blocked" role="alert" aria-live="assertive">
      <span className="media-blocked-ic" aria-hidden="true">
        !
      </span>
      <span className="reconnect-text">
        <strong>Your audio and video can’t connect</strong>
        <span>
          Your network may be blocking calls. Try mobile data or another Wi‑Fi. At work, ask IT to
          allow video calls.
        </span>
      </span>
      <button type="button" className="media-blocked-dismiss" onClick={() => setDismissed(true)}>
        Dismiss
      </button>
    </div>
  );
}
