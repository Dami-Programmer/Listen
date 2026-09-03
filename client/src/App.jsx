import { useEffect, useState } from 'react';
import { MODES, ROLES } from '@listen/shared';

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001';

export default function App() {
  const [health, setHealth] = useState('checking…');

  useEffect(() => {
    fetch(`${SIGNALING_URL}/health`)
      .then((r) => r.json())
      .then((data) => setHealth(`server ok (phase ${data.phase})`))
      .catch(() => setHealth('server unreachable'));
  }, []);

  return (
    <main className="page">
      <h1>Listen</h1>
      <p className="tagline">Moderated group calls. Phase 0 — foundation.</p>

      <div className="card">
        <div className="row">
          <span>Signaling URL</span>
          <code>{SIGNALING_URL}</code>
        </div>
        <div className="row">
          <span>Health</span>
          <code>{health}</code>
        </div>
        <div className="row">
          <span>Shared enums loaded</span>
          <code>
            modes: {Object.values(MODES).join(', ')} | roles: {Object.values(ROLES).join(', ')}
          </code>
        </div>
      </div>

      <p className="next">
        Next up: <strong>Phase 1</strong> — Socket.IO signaling and the in-memory room registry.
      </p>
    </main>
  );
}
