// Phase 2 — the client is split into two screens (JoinScreen / CallView).
// Phase 3 — roles shown in the participant list and on each tile.
// Phase 4 — the host-only Open | Moderated switch; listeners lose their mic/cam.
//
// <App/> owns the Socket.IO lifecycle; all media logic lives in webrtc.js.

import { useEffect, useState } from 'react';
import { MODES, ROLES } from '@listen/shared';
import { socket } from './socket.js';
import { useCall } from './webrtc.js';
import VideoTile from './VideoTile.jsx';

const ROLE_RANK = { [ROLES.HOST]: 0, [ROLES.SPEAKER]: 1, [ROLES.LISTENER]: 2 };

function RolePill({ role }) {
  return <span className={`pill pill-${role}`}>{role === ROLES.HOST ? '★ host' : role}</span>;
}

function readRoomFromUrl() {
  return new URLSearchParams(window.location.search).get('room') ?? '';
}

export default function App() {
  const [roomId, setRoomId] = useState(readRoomFromUrl);
  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [selfId, setSelfId] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);

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
      <JoinScreen
        roomId={roomId}
        name={name}
        error={error}
        onRoomId={setRoomId}
        onName={setName}
        onSubmit={handleJoin}
      />
    );
  }

  return <CallView state={state} selfId={selfId} connected={connected} onLeave={handleLeave} />;
}

function JoinScreen({ roomId, name, error, onRoomId, onName, onSubmit }) {
  return (
    <main className="page">
      <h1>Listen</h1>
      <p className="tagline">Moderated group calls. Phase 4 — the Moderated switch.</p>

      <form className="card join" onSubmit={onSubmit}>
        <label>
          <span>Room</span>
          <input
            value={roomId}
            onChange={(e) => onRoomId(e.target.value)}
            placeholder="e.g. friday-standup"
            autoComplete="off"
          />
        </label>
        <label>
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
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

function CallView({ state, selfId, connected, onLeave }) {
  const participants = state?.participants ?? [];
  const self = participants.find((p) => p.id === selfId);

  const { localStream, remotes, micOn, camOn, toggleMic, toggleCam, mediaError, isListener } =
    useCall({ selfId, participants, inCall: true });

  const isHost = self?.role === ROLES.HOST;
  const moderated = state?.mode === MODES.MODERATED;

  const peerOf = (id) => participants.find((p) => p.id === id);
  const ordered = [...participants].sort(
    (a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.name.localeCompare(b.name),
  );

  // Host-only: ask the server to flip the room mode. The server re-checks that
  // we're the host and rejects otherwise — this button just can't be seen by
  // anyone else.
  function changeMode(mode) {
    socket.emit('set-mode', { mode }, (ack) => {
      if (!ack?.ok) console.warn('[set-mode] rejected:', ack?.error);
    });
  }

  return (
    <main className="page call">
      <div className="topbar">
        <div>
          <h1>{state?.roomId}</h1>
          <p className="tagline">
            {connected ? 'connected' : 'reconnecting…'} · {participants.length} in room · you are{' '}
            <strong>{self?.role ?? '—'}</strong>
          </p>
        </div>
        <button className="ghost" onClick={onLeave}>
          Leave
        </button>
      </div>

      {isHost ? (
        <div className="mode-toggle" role="group" aria-label="Room mode">
          <button className={!moderated ? 'active' : ''} onClick={() => changeMode(MODES.OPEN)}>
            Open
          </button>
          <button className={moderated ? 'active' : ''} onClick={() => changeMode(MODES.MODERATED)}>
            Moderated
          </button>
        </div>
      ) : (
        moderated && <p className="banner">🔒 Moderated — the host controls who speaks.</p>
      )}

      {mediaError && <p className="err">{mediaError}</p>}

      <div className="grid">
        {localStream && (
          <VideoTile
            stream={localStream}
            label={`${self?.name ?? 'You'} (you)`}
            role={self?.role}
            muted
            mirror
          />
        )}
        {remotes.map(({ id, stream }) => {
          const peer = peerOf(id);
          return (
            <VideoTile key={id} stream={stream} label={peer?.name ?? 'Guest'} role={peer?.role} />
          );
        })}
      </div>

      {isListener ? (
        <div className="listener-note">
          <p>🎧 Listening only — the host has moderated this room.</p>
        </div>
      ) : (
        <div className="controls">
          <button className={micOn ? '' : 'off'} onClick={toggleMic}>
            {micOn ? 'Mute mic' : 'Unmute mic'}
          </button>
          <button className={camOn ? '' : 'off'} onClick={toggleCam}>
            {camOn ? 'Stop camera' : 'Start camera'}
          </button>
          <button className="ghost" onClick={onLeave}>
            Leave call
          </button>
        </div>
      )}

      <div className="card">
        <div className="row header">
          <span>Participants ({participants.length})</span>
        </div>
        {ordered.map((p) => (
          <div className="row" key={p.id}>
            <span>
              {p.name}
              {p.id === selfId ? ' (you)' : ''}
            </span>
            <RolePill role={p.role} />
          </div>
        ))}
      </div>

      <details className="card raw">
        <summary>Raw room-state snapshot</summary>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </details>

      <p className="next">
        Next up: <strong>Phase 5</strong> — hand-raising and the speaker queue.
      </p>
    </main>
  );
}
