// Phase 2 — the client is now split into two screens:
//
//   <JoinScreen/>  room id + name form  (unchanged from Phase 1)
//   <CallView/>    the actual video call (camera tiles + mic/camera/leave)
//
// <App/> owns the Socket.IO lifecycle and the "have we joined yet?" flag, and
// swaps between the two screens. All media logic lives in webrtc.js (the
// useCall hook); this file is UI only.
//
// Phase 7 adds the host's full moderation surface — per-participant Mute /
// Remove / Grant / Revoke and queue reordering — all in <CallView/>. Every
// button here is advisory: the server re-checks that the caller is the host.

import { useEffect, useState } from 'react';
import { MODES, ROLES } from '@listen/shared';
import { socket } from './socket.js';
import { useCall } from './webrtc.js';
import VideoTile from './VideoTile.jsx';

// Display order for the participant list: host, then speakers, then listeners.
const ROLE_RANK = { [ROLES.HOST]: 0, [ROLES.SPEAKER]: 1, [ROLES.LISTENER]: 2 };

// A small coloured role label. Purely visual — the server owns the actual role.
function RolePill({ role }) {
  return <span className={`pill pill-${role}`}>{role === ROLES.HOST ? '★ host' : role}</span>;
}

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
  // Set when the host kicks us — shown on the join screen so it doesn't just
  // look like a dropped connection. Cleared on the next join attempt.
  const [removedNote, setRemovedNote] = useState(null);

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
    function onRemoved() {
      // Arrives just before the server closes our socket (see onDisconnect).
      setRemovedNote('The host removed you from the room.');
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room-state', onRoomState);
    socket.on('room-error', onRoomError);
    socket.on('removed', onRemoved);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room-state', onRoomState);
      socket.off('room-error', onRoomError);
      socket.off('removed', onRemoved);
    };
  }, []);

  function handleJoin(e) {
    e.preventDefault();
    setError(null);
    setRemovedNote(null);
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
    // Disconnecting the socket also unmounts <CallView/>, whose useCall cleanup
    // stops the camera and closes every peer connection.
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
        note={removedNote}
        onRoomId={setRoomId}
        onName={setName}
        onSubmit={handleJoin}
      />
    );
  }

  return <CallView state={state} selfId={selfId} connected={connected} onLeave={handleLeave} />;
}

// --- the join form (Phase 1, extracted unchanged) ---------------------------
function JoinScreen({ roomId, name, error, note, onRoomId, onName, onSubmit }) {
  return (
    <main className="page">
      <h1>Listen</h1>
      <p className="tagline">Moderated group calls. Phase 7 — full host moderation controls.</p>

      {note && <p className="banner">{note}</p>}

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

// --- the in-call screen ----------------------------------------------------
function CallView({ state, selfId, connected, onLeave }) {
  const participants = state?.participants ?? [];
  const self = participants.find((p) => p.id === selfId);

  const { localStream, remotes, micOn, camOn, toggleMic, toggleCam, mediaError, isListener } =
    useCall({ selfId, participants, inCall: true });

  const isHost = self?.role === ROLES.HOST;
  const moderated = state?.mode === MODES.MODERATED;

  // Phase 5 — the speaker queue, straight from the snapshot (socketIds, oldest
  // first). The server owns it; we only render it.
  const queue = state?.queue ?? [];
  const myQueuePos = queue.indexOf(selfId); // -1 when my hand isn't raised
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

  // Every host action is a fire-and-forget socket event; the server re-checks
  // permissions, then broadcasts a new snapshot that flows back through <App/>.
  function emit(event, payload) {
    socket.emit(event, payload ?? {}, (ack) => {
      if (!ack?.ok) console.warn(`[${event}] rejected:`, ack?.error);
    });
  }
  const raiseHand = () => emit('raise-hand');
  const lowerHand = () => emit('lower-hand'); // lower my own hand
  const dismissHand = (targetId) => emit('lower-hand', { targetId }); // host
  const grantFloor = (targetId) => emit('grant-floor', { targetId });
  const revokeFloor = (targetId) => emit('revoke-floor', { targetId });

  // Phase 7 — host moderation. Destructive actions confirm first.
  const forceMute = (targetId) => emit('force-mute', { targetId });
  function removeParticipant(p) {
    if (window.confirm(`Remove ${p.name} from the call?`)) {
      emit('remove-participant', { targetId: p.id });
    }
  }
  function clearFloor() {
    if (window.confirm('Send every speaker back to listening?')) emit('clear-floor');
  }
  // Move one queued person up (dir -1) or down (dir +1). The server only accepts
  // a full reordering of the current queue, so we send the whole new order.
  function moveInQueue(id, dir) {
    const order = queue.slice();
    const i = order.indexOf(id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    emit('reorder-queue', { order });
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
                  <button
                    className="ghost small"
                    aria-label={`Move ${p.name} up`}
                    disabled={i === 0}
                    onClick={() => moveInQueue(p.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="ghost small"
                    aria-label={`Move ${p.name} down`}
                    disabled={i === queued.length - 1}
                    onClick={() => moveInQueue(p.id, +1)}
                  >
                    ↓
                  </button>
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
        {ordered.map((p) => {
          const target = isHost && p.id !== selfId;
          return (
            <div className="row" key={p.id}>
              <span>
                {p.name}
                {p.id === selfId ? ' (you)' : ''}
              </span>
              <span className="actions">
                {/* Give the floor to this exact person (Phase 7 hand-off). */}
                {target && moderated && p.role === ROLES.LISTENER && (
                  <button className="small" onClick={() => grantFloor(p.id)}>
                    Grant
                  </button>
                )}
                {/* Take the floor back, even mid-speech. */}
                {target && moderated && p.role === ROLES.SPEAKER && (
                  <button className="ghost small" onClick={() => revokeFloor(p.id)}>
                    Revoke
                  </button>
                )}
                {target && (
                  <button className="ghost small" onClick={() => forceMute(p.id)}>
                    Mute
                  </button>
                )}
                {target && (
                  <button className="ghost small danger" onClick={() => removeParticipant(p)}>
                    Remove
                  </button>
                )}
                <RolePill role={p.role} />
              </span>
            </div>
          );
        })}
      </div>

      <details className="card raw">
        <summary>Raw room-state snapshot</summary>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </details>

      <p className="next">
        Next up: <strong>Phase 8</strong> — a TURN server, reconnect handling, and deploy.
      </p>
    </main>
  );
}
