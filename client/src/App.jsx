// Phases 2-5 built the call, roles, the Moderated switch, and the speaker queue.
// Phase 6 — the room elects an active speaker and draws a glow on that tile;
// idle speakers in a moderated room are auto-cycled by the server.
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
      <p className="tagline">
        Moderated group calls. Phase 6 — active-speaker glow &amp; the silence rule.
      </p>

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

  const queue = state?.queue ?? [];
  const myQueuePos = queue.indexOf(selfId);
  const handRaised = myQueuePos !== -1;
  const queued = queue.map((id) => participants.find((p) => p.id === id)).filter(Boolean);
  const grantedSpeakers = participants.filter((p) => p.role === ROLES.SPEAKER);

  // Phase 6 — the server-elected active speaker (null when the room is silent).
  const activeSpeakerId = state?.activeSpeakerId ?? null;

  const peerOf = (id) => participants.find((p) => p.id === id);
  const ordered = [...participants].sort(
    (a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.name.localeCompare(b.name),
  );

  function changeMode(mode) {
    socket.emit('set-mode', { mode }, (ack) => {
      if (!ack?.ok) console.warn('[set-mode] rejected:', ack?.error);
    });
  }

  function emit(event, payload) {
    socket.emit(event, payload ?? {}, (ack) => {
      if (!ack?.ok) console.warn(`[${event}] rejected:`, ack?.error);
    });
  }
  const raiseHand = () => emit('raise-hand');
  const lowerHand = () => emit('lower-hand');
  const dismissHand = (targetId) => emit('lower-hand', { targetId });
  const grantFloor = (targetId) => emit('grant-floor', { targetId });
  const revokeFloor = (targetId) => emit('revoke-floor', { targetId });
  const clearFloor = () => emit('clear-floor');

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

      {isHost && moderated && (
        <div className="card queue">
          <div className="row header">
            <span>Raised hands ({queued.length})</span>
            {grantedSpeakers.length > 0 && (
              <button className="ghost small" onClick={clearFloor}>
                Clear floor
              </button>
            )}
          </div>
          {queued.length === 0 ? (
            <p className="muted">No one&apos;s waiting. Listeners can raise a hand.</p>
          ) : (
            queued.map((p, i) => (
              <div className="row" key={p.id}>
                <span>
                  {i + 1}. {p.name}
                </span>
                <span className="actions">
                  <button className="small" onClick={() => grantFloor(p.id)}>
                    Grant
                  </button>
                  <button className="ghost small" onClick={() => dismissHand(p.id)}>
                    Dismiss
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {mediaError && <p className="err">{mediaError}</p>}

      <div className="grid">
        {localStream && (
          <VideoTile
            stream={localStream}
            label={`${self?.name ?? 'You'} (you)`}
            role={self?.role}
            speaking={activeSpeakerId === selfId}
            muted
            mirror
          />
        )}
        {remotes.map(({ id, stream }) => {
          const peer = peerOf(id);
          return (
            <VideoTile
              key={id}
              stream={stream}
              label={peer?.name ?? 'Guest'}
              role={peer?.role}
              speaking={activeSpeakerId === id}
            />
          );
        })}
      </div>

      {isListener ? (
        <div className="listener-note">
          <p>
            🎧 Listening only &mdash;{' '}
            {handRaised
              ? `you're #${myQueuePos + 1} in line for the floor.`
              : 'raise your hand to ask for the floor.'}
          </p>
          <button className={handRaised ? 'off' : ''} onClick={handRaised ? lowerHand : raiseHand}>
            {handRaised ? '✋ Lower hand' : '✋ Raise hand'}
          </button>
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
            <span className="actions">
              {isHost && moderated && p.role === ROLES.SPEAKER && (
                <button className="ghost small" onClick={() => revokeFloor(p.id)}>
                  Revoke
                </button>
              )}
              <RolePill role={p.role} />
            </span>
          </div>
        ))}
      </div>

      <details className="card raw">
        <summary>Raw room-state snapshot</summary>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </details>

      <p className="next">
        Next up: <strong>Phase 7</strong> — full host controls: force-mute, remove a participant,
        reorder the queue.
      </p>
    </main>
  );
}
