// Phase 2 — the client is now split into two screens:
//
//   <JoinScreen/>  room id + name form  (unchanged from Phase 1)
//   <CallView/>    the actual video call (camera tiles + mic/camera/leave)
//
// <App/> owns the Socket.IO lifecycle and the "have we joined yet?" flag, and
// swaps between the two screens. All media logic lives in webrtc.js (the
// useCall hook); this file is UI only.

import { useEffect, useState } from 'react';
import { socket } from './socket.js';
import { useCall } from './webrtc.js';
import VideoTile from './VideoTile.jsx';

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
      <p className="tagline">Moderated group calls. Phase 2 — the call.</p>

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

  const { localStream, remotes, micOn, camOn, toggleMic, toggleCam, mediaError } = useCall({
    selfId,
    participants,
    inCall: true,
  });

  const peerOf = (id) => participants.find((p) => p.id === id);

  return (
    <main className="page call">
      <div className="topbar">
        <div>
          <h1>{state?.roomId}</h1>
          <p className="tagline">
            {connected ? 'connected' : 'reconnecting…'} · {participants.length} in room
          </p>
        </div>
        <button className="ghost" onClick={onLeave}>
          Leave
        </button>
      </div>

      {mediaError && <p className="err">{mediaError}</p>}

      <div className="grid">
        {localStream && (
          <VideoTile stream={localStream} label={`${self?.name ?? 'You'} (you)`} muted mirror />
        )}
        {remotes.map(({ id, stream }) => (
          <VideoTile key={id} stream={stream} label={peerOf(id)?.name ?? 'Guest'} />
        ))}
      </div>

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
            <code>{p.id === state?.hostId ? '★ host' : p.role}</code>
          </div>
        ))}
      </div>

      <details className="card raw">
        <summary>Raw room-state snapshot</summary>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </details>

      <p className="next">
        Next up: <strong>Phase 3</strong> — roles: host / speaker / listener, visible but not yet
        enforced.
      </p>
    </main>
  );
}
