// "You lost your connection — reconnecting…" across the top of the screen,
// Google-Meet style. Shown by <App/> while OUR connection to the server is
// down but we're still on the call screen, waiting for the internet to come
// back (see EVENTS.RESUME). Works the same on desktop and phones.
//
// Nothing to do here except wait — Socket.IO keeps retrying on its own, and
// <App/> gets our seat back the moment it reconnects. Leave is offered for
// anyone who'd rather give up.
//
// While we're offline, the browser can tell us when the device itself has no
// network at all (Wi-Fi off, airplane mode) — then the second line says so,
// which is more useful than "trying" forever.

import { useEffect, useState } from 'react';

export default function ReconnectBanner({ onLeave }) {
  // navigator.onLine is false only when the device has no network at all.
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return (
    <div className="reconnect-banner" role="alert" aria-live="assertive">
      <span className="reconnect-spin" aria-hidden="true" />
      <span className="reconnect-text">
        <strong>You lost your connection</strong>
        <span>
          {online ? 'Trying to reconnect…' : 'Check your internet. We’ll rejoin when it’s back.'}
        </span>
      </span>
      <button type="button" className="reconnect-leave" onClick={onLeave}>
        Leave
      </button>
    </div>
  );
}
