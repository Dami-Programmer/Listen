import { useEffect, useState } from 'react';
import { ROLES } from '@listen/shared';
import { socket } from './socket.js';

// Room id lives in the URL (?room=…). No accounts, no persistence.
function readRoomFromUrl() {
  return new URLSearchParams(window.location.search).get('room') ?? '';
}

export default function App() {
  const [roomId, setRoomId] = useState(readRoomFromUrl);
  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [selfId, setSelfId] = useState(null);
  const [state, setState] = useState(null); // latest room-state snapshot
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);

  // Wire socket listeners once.
  useEffect(() => {
    function onConnect() {
      setConnected(true);
    }
    function onDisconnect() {
      setConnected(false);
      setJoined(false);
      setState(null);
    }
    function onRoomState(snapshot) {
      setState(snapshot);
    }
    function onRoomError(err) {
      setError(err?.message ?? 'unknown error');
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room-state', onRoomState);
    socket.on('room-error', onRoomError);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room-state', onRoomState);
      socket.off('room-error', onRoomError);
    };
  }, []);

  function handleJoin(e) {
    e.preventDefault();
    setError(null);
    const id = roomId.trim();
    if (!id || !name.trim()) return;

    // Reflect the room in the URL so it's shareable.
    const url = new URL(window.location.href);
    url.searchParams.set('room', id);
    window.history.replaceState({}, '', url);

    if (!socket.connected) socket.connect();
    socket.emit('join-room', { roomId: id, name: name.trim() }, (ack) => {
      if (ack?.ok) {
        setSelfId(ack.selfId);
        setState(ack.state);
        setJoined(true);
      } else {
        setError(ack?.error ?? 'join failed');
      }
    });
  }

  function handleLeave() {
    socket.disconnect();
    setJoined(false);
    setState(null);
    setSelfId(null);
  }

  if (!joined) {
    return (
      <main className="page">
        <h1>Listen</h1>
        <p className="tagline">Moderated group calls. Phase 1 — signaling.</p>

        <form className="card join" onSubmit={handleJoin}>
          <label>
            <span>Room</span>
            <input
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="e.g. friday-standup"
              autoComplete="off"
            />
          </label>
          <label>
            <span>Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sam"
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={!roomId.trim() || !name.trim()}>
            Join room
          </button>
          {error && <p className="err">{error}</p>}
        </form>
      </main>
    );
  }

  const participants = state?.participants ?? [];
  const self = participants.find((p) => p.id === selfId);

  return (
    <main className="page">
      <div className="topbar">
        <div>
          <h1>{state?.roomId}</h1>
          <p className="tagline">
            {connected ? 'connected' : 'reconnecting…'} · mode: {state?.mode} · you are{' '}
            <strong>{self?.role ?? '—'}</strong>
          </p>
        </div>
        <button className="ghost" onClick={handleLeave}>
          Leave
        </button>
      </div>

      <div className="card">
        <div className="row header">
          <span>Participants ({participants.length})</span>
        </div>
        {participants.map((p) => (
          <div className="row" key={p.id}>
            <span>
              {p.name}
              {p.id === selfId ? ' (you)' : ''}
            </span>
            <code>
              {p.role === ROLES.HOST ? '★ host' : p.role}
              {p.id === state?.hostId && p.role !== ROLES.HOST ? ' ★' : ''}
            </code>
          </div>
        ))}
      </div>

      <details className="card raw">
        <summary>Raw room-state snapshot</summary>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </details>

      <p className="next">
        Next up: <strong>Phase 2</strong> — getUserMedia + mesh WebRTC so people can see and hear
        each other.
      </p>
    </main>
  );
}
