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

import { useEffect, useRef, useState } from 'react';
import { MODES, ROLES } from '@listen/shared';
import { socket } from './socket.js';
import { useCall } from './webrtc.js';
import VideoTile from './VideoTile.jsx';
import ChatPanel from './ChatPanel.jsx';

// Display order for the participant list: host, co-host, speakers, listeners.
const ROLE_RANK = {
  [ROLES.HOST]: 0,
  [ROLES.COHOST]: 1,
  [ROLES.SPEAKER]: 2,
  [ROLES.LISTENER]: 3,
};

const ROLE_LABEL = {
  [ROLES.HOST]: '★ host',
  [ROLES.COHOST]: '★ co-host',
  [ROLES.SPEAKER]: 'speaker',
  [ROLES.LISTENER]: 'listener',
};

// A small coloured role label. Purely visual — the server owns the actual role.
function RolePill({ role }) {
  return <span className={`pill pill-${role}`}>{ROLE_LABEL[role] ?? role}</span>;
}

// Start / stop sharing this tab's screen. In a moderated room only the host +
// speakers get this button; listeners don't (the server enforces it too).
function ShareScreenButton({ sharing, onStart, onStop }) {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  return (
    <button className={sharing ? 'off' : ''} onClick={sharing ? onStop : onStart}>
      {sharing ? '🖥 Stop sharing' : '🖥 Share screen'}
    </button>
  );
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
  const [chat, setChat] = useState([]); // in-call chat, seeded from the join ack
  const [typers, setTypers] = useState({}); // socketId -> name, currently typing
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  // true while we're in the locked room's waiting area, before a moderator lets
  // us in.
  const [waiting, setWaiting] = useState(false);
  // Safety timers so a typer disappears even if their "stopped" ping is lost.
  const typerTimersRef = useRef({});
  // Set when the host kicks us OR turns us away at the door — shown on the join
  // screen so it doesn't just look like a dropped connection.
  const [removedNote, setRemovedNote] = useState(null);

  // Drop every "is typing" indicator and its safety timer.
  const clearTypers = () => {
    Object.values(typerTimersRef.current).forEach(clearTimeout);
    typerTimersRef.current = {};
    setTypers({});
  };

  // Wire socket listeners once. These are the Phase 1 room-state events; the
  // Phase 2 RTC_SIGNAL listener is added/removed inside the useCall hook.
  useEffect(() => {
    function onConnect() {
      setConnected(true);
    }
    function onDisconnect() {
      setConnected(false);
      setJoined(false);
      setWaiting(false);
      setState(null);
      setChat([]);
      clearTypers();
    }
    function onAdmitted({ selfId: id, state: snap, chat: history }) {
      setSelfId(id);
      setState(snap);
      setChat(history ?? []);
      setWaiting(false);
      setJoined(true);
    }
    function onDenied() {
      setWaiting(false);
      setRemovedNote('The host didn’t let you into the room.');
    }
    function onRoomState(snapshot) {
      setState(snapshot);
    }
    function onChatMessage(msg) {
      setChat((c) => [...c, msg]);
      // A delivered message ends that person's "typing" state.
      dropTyper(msg.from);
    }
    // Add or remove one person from the typing set, with a 5s auto-expiry in
    // case their "stopped typing" ping never arrives.
    function dropTyper(id) {
      clearTimeout(typerTimersRef.current[id]);
      delete typerTimersRef.current[id];
      setTypers((m) => {
        if (!(id in m)) return m;
        const next = { ...m };
        delete next[id];
        return next;
      });
    }
    function onChatTyping({ id, name, typing }) {
      if (!id) return;
      if (typing) {
        clearTimeout(typerTimersRef.current[id]);
        typerTimersRef.current[id] = setTimeout(() => dropTyper(id), 5000);
        setTypers((m) => (m[id] === name ? m : { ...m, [id]: name || 'Someone' }));
      } else {
        dropTyper(id);
      }
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
    socket.on('admitted', onAdmitted);
    socket.on('denied', onDenied);
    socket.on('chat-message', onChatMessage);
    socket.on('chat-typing', onChatTyping);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room-state', onRoomState);
      socket.off('room-error', onRoomError);
      socket.off('removed', onRemoved);
      socket.off('admitted', onAdmitted);
      socket.off('denied', onDenied);
      socket.off('chat-message', onChatMessage);
      socket.off('chat-typing', onChatTyping);
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
      if (ack?.ok && ack.waiting) {
        // Locked room — sit in the lobby until a moderator admits us.
        setSelfId(ack.selfId);
        setWaiting(true);
      } else if (ack?.ok) {
        setSelfId(ack.selfId);
        setState(ack.state);
        setChat(ack.chat ?? []);
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
    setWaiting(false);
    setState(null);
    setSelfId(null);
    setChat([]);
    clearTypers();
  }

  if (waiting) {
    return <WaitingScreen roomId={roomId} onCancel={handleLeave} />;
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

  return (
    <CallView
      state={state}
      chat={chat}
      typers={typers}
      selfId={selfId}
      connected={connected}
      onLeave={handleLeave}
    />
  );
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

// --- the locked-room lobby -----------------------------------------------
function WaitingScreen({ roomId, onCancel }) {
  return (
    <main className="page">
      <h1>Listen</h1>
      <p className="tagline">Moderated group calls.</p>

      <div className="card join" aria-live="polite">
        <p>
          <strong>Knock knock 👋</strong>
        </p>
        <p className="tagline">
          Waiting for the host to let you into <code>{roomId}</code>…
        </p>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </main>
  );
}

// --- the in-call screen ----------------------------------------------------
function CallView({ state, chat, typers, selfId, connected, onLeave }) {
  const participants = state?.participants ?? [];
  const self = participants.find((p) => p.id === selfId);

  // socketId -> the id of that peer's screen MediaStream (room-state).
  const sharing = state?.sharing ?? {};

  // The whole call: local camera + screen, remote streams, toggles, and
  // (Phase 4) my role + whether I'm a muted listener.
  const {
    localStream,
    screenStream,
    remotes,
    remoteScreens,
    micOn,
    camOn,
    sharingScreen,
    toggleMic,
    toggleCam,
    startShare,
    stopShare,
    mediaError,
    isListener,
  } = useCall({ selfId, participants, inCall: true, sharing });

  const isHost = self?.role === ROLES.HOST;
  // A moderator is the host OR the appointed co-host — same control surface.
  const isModerator = isHost || self?.role === ROLES.COHOST;
  const cohostId = state?.cohostId ?? null;
  const moderated = state?.mode === MODES.MODERATED;

  // Waiting room — people knocking to get in (moderator-only UI).
  const locked = state?.locked ?? false;
  const waiting = state?.waiting ?? [];

  // Phase 5 — the speaker queue, straight from the snapshot (socketIds, oldest
  // first). The server owns it; we only render it.
  const queue = state?.queue ?? [];
  const myQueuePos = queue.indexOf(selfId); // -1 when my hand isn't raised
  const handRaised = myQueuePos !== -1;

  // Host dashboard inputs: the queued people as participant objects (in queue
  // order), and the non-host speakers the host can revoke / clear.
  const queued = queue.map((id) => participants.find((p) => p.id === id)).filter(Boolean);
  const grantedSpeakers = participants.filter((p) => p.role === ROLES.SPEAKER);

  // Phase 6 — the server-elected active speaker (null when the room is silent).
  // Its tile gets the glow; nothing else on the client decides this.
  const activeSpeakerId = state?.activeSpeakerId ?? null;

  // peerId -> participant, for labelling remote tiles with name + role.
  const peerOf = (id) => participants.find((p) => p.id === id);

  // --- one media stage, Google-Meet style -------------------------------
  // Camera tiles for everyone (me first). If anyone is screen sharing, the
  // screen(s) fill the main area and these cameras drop into a filmstrip;
  // otherwise the cameras ARE the main grid.
  const cameraTiles = [
    localStream && {
      key: 'me',
      stream: localStream,
      label: `${self?.name ?? 'You'} (you)`,
      role: self?.role,
      speaking: activeSpeakerId === selfId,
      muted: true,
      mirror: true,
    },
    ...remotes.map(({ id, stream }) => ({
      key: id,
      stream,
      label: peerOf(id)?.name ?? 'Guest',
      role: peerOf(id)?.role,
      speaking: activeSpeakerId === id,
    })),
  ].filter(Boolean);

  const screenTiles = [
    screenStream && { key: 'me', stream: screenStream, label: 'Your screen', muted: true },
    ...remoteScreens.map(({ id, stream }) => ({
      key: id,
      stream,
      label: `${peerOf(id)?.name ?? 'Guest'}'s screen`,
    })),
  ].filter(Boolean);

  const presenting = screenTiles.length > 0;

  // Participant list sorted host-first, then co-host, speakers, listeners, A-Z.
  const ordered = [...participants].sort(
    (a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.name.localeCompare(b.name),
  );

  // Moderator-only: flip the room mode. The server re-checks that the caller is
  // a moderator — this button just isn't rendered for anyone else.
  function changeMode(mode) {
    socket.emit('set-mode', { mode }, (ack) => {
      if (!ack?.ok) console.warn('[set-mode] rejected:', ack?.error);
    });
  }

  // Every moderator action is a fire-and-forget socket event; the server
  // re-checks permissions, then broadcasts a new snapshot back through <App/>.
  // We only log a rejection.
  function emit(event, payload) {
    socket.emit(event, payload ?? {}, (ack) => {
      if (!ack?.ok) console.warn(`[${event}] rejected:`, ack?.error);
    });
  }
  const raiseHand = () => emit('raise-hand');
  const lowerHand = () => emit('lower-hand'); // lower my own hand
  const dismissHand = (targetId) => emit('lower-hand', { targetId }); // moderator
  const grantFloor = (targetId) => emit('grant-floor', { targetId });
  const revokeFloor = (targetId) => emit('revoke-floor', { targetId });
  const passMic = () => emit('pass-mic'); // a speaker hands the floor on

  // A plain speaker in a moderated room can pass the mic (host / co-host hold
  // the room, not "the mic").
  const canPassMic = moderated && self?.role === ROLES.SPEAKER;

  // Phase 7 — moderation. Destructive actions confirm first.
  const forceMute = (targetId) => emit('force-mute', { targetId });
  function removeParticipant(p) {
    if (window.confirm(`Remove ${p.name} from the call?`)) {
      emit('remove-participant', { targetId: p.id });
    }
  }
  function clearFloor() {
    if (window.confirm('Send every speaker back to listening?')) emit('clear-floor');
  }

  // Co-host — host-only.
  const makeCohost = (p) => emit('promote-cohost', { targetId: p.id });
  function dropCohost(p) {
    if (window.confirm(`Remove ${p.name} as co-host? They stay in the call.`)) {
      emit('demote-cohost', { targetId: p.id });
    }
  }

  // Waiting room — moderator-only.
  const admit = (id) => emit('admit', { socketId: id });
  const deny = (id) => emit('deny', { socketId: id });
  const toggleLock = () => emit('set-lock', { locked: !locked });
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
            <strong>{ROLE_LABEL[self?.role]?.replace('★ ', '') ?? '—'}</strong>
          </p>
        </div>
        <button className="ghost" onClick={onLeave}>
          Leave
        </button>
      </div>

      {/* A moderator (host or co-host) sees the mode toggle + door lock;
          everyone else sees a banner when moderated. */}
      {isModerator ? (
        <div className="mod-bar">
          <div className="mode-toggle" role="group" aria-label="Room mode">
            <button className={!moderated ? 'active' : ''} onClick={() => changeMode(MODES.OPEN)}>
              Open
            </button>
            <button
              className={moderated ? 'active' : ''}
              onClick={() => changeMode(MODES.MODERATED)}
            >
              Moderated
            </button>
          </div>
          <button
            className={`ghost small${locked ? ' danger' : ''}`}
            onClick={toggleLock}
            title={locked ? 'New people must be admitted' : 'Anyone with the link can join'}
          >
            {locked ? '🔒 Door locked' : '🔓 Door open'}
          </button>
        </div>
      ) : (
        moderated && (
          <p className="banner">🔒 Moderated — the host &amp; co-host control who speaks.</p>
        )
      )}

      {/* Moderator-only: people knocking to get into the locked room. */}
      {isModerator && waiting.length > 0 && (
        <div className="card queue">
          <div className="row header">
            <span>Waiting to join ({waiting.length})</span>
          </div>
          {waiting.map((w) => (
            <div className="row" key={w.id}>
              <span>{w.name}</span>
              <span className="actions">
                <button className="small" onClick={() => admit(w.id)}>
                  Admit
                </button>
                <button className="ghost small danger" onClick={() => deny(w.id)}>
                  Deny
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Moderator-only, moderated-only: the raised-hands dashboard. Reorder with
          the arrows, Grant to promote, Dismiss to drop from the queue. Clear
          floor sends every current speaker back to listening. */}
      {isModerator && moderated && (
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

      {/* One stage. Presenting → screen(s) fill the main area, cameras become a
          filmstrip. Not presenting → the cameras are the main grid. */}
      <div className={`stage${presenting ? ' presenting' : ''}`}>
        <div className="stage-main">
          {(presenting ? screenTiles : cameraTiles).map((t) => (
            <VideoTile
              key={presenting ? `screen-${t.key}` : t.key}
              stream={t.stream}
              label={t.label}
              role={t.role}
              speaking={t.speaking}
              muted={t.muted}
              mirror={t.mirror}
              screen={presenting}
            />
          ))}
        </div>

        {presenting && cameraTiles.length > 0 && (
          <div className="stage-strip">
            {cameraTiles.map((t) => (
              <VideoTile
                key={t.key}
                stream={t.stream}
                label={t.label}
                role={t.role}
                speaking={t.speaking}
                muted={t.muted}
                mirror={t.mirror}
              />
            ))}
          </div>
        )}
      </div>

      {/* A listener's mic/camera aren't theirs to control in a moderated room —
          instead they get a raise-hand toggle that puts them in the queue. In a
          moderated room only the host + speakers can screen share. */}
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
          <ShareScreenButton sharing={sharingScreen} onStart={startShare} onStop={stopShare} />
          {canPassMic && (
            <button className="ghost" onClick={passMic}>
              🎤 Pass the mic
            </button>
          )}
          <button className="ghost" onClick={onLeave}>
            Leave call
          </button>
        </div>
      )}

      <ChatPanel messages={chat} typers={typers} selfId={selfId} />

      <div className="card">
        <div className="row header">
          <span>Participants ({participants.length})</span>
        </div>
        {ordered.map((p) => {
          // A moderator can act on anyone but themselves and the host.
          const canMod = isModerator && p.id !== selfId && p.role !== ROLES.HOST;
          // Appointing / dropping a co-host is the host's alone.
          const hostControls = isHost && p.id !== selfId && p.role !== ROLES.HOST;
          return (
            <div className="row" key={p.id}>
              <span>
                {p.name}
                {p.id === selfId ? ' (you)' : ''}
              </span>
              <span className="actions">
                {/* Give the floor to this exact person (Phase 7 hand-off). */}
                {canMod && moderated && p.role === ROLES.LISTENER && (
                  <button className="small" onClick={() => grantFloor(p.id)}>
                    Grant
                  </button>
                )}
                {/* Take the floor back, even mid-speech. */}
                {canMod && moderated && p.role === ROLES.SPEAKER && (
                  <button className="ghost small" onClick={() => revokeFloor(p.id)}>
                    Revoke
                  </button>
                )}
                {hostControls &&
                  (p.id === cohostId ? (
                    <button className="ghost small" onClick={() => dropCohost(p)}>
                      Remove co-host
                    </button>
                  ) : (
                    <button className="ghost small" onClick={() => makeCohost(p)}>
                      Make co-host
                    </button>
                  ))}
                {canMod && (
                  <button className="ghost small" onClick={() => forceMute(p.id)}>
                    Mute
                  </button>
                )}
                {canMod && (
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
