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

import { useEffect, useMemo, useRef, useState } from 'react';
import { MODES, ROLES } from '@listen/shared';
import { socket } from './socket.js';
import { useCall } from './webrtc.js';
import VideoTile from './VideoTile.jsx';
import ChatPanel from './ChatPanel.jsx';
import Avatar from './Avatar.jsx';
import {
  Mic,
  MicOff,
  Cam,
  CamOff,
  Phone,
  Screen,
  Hand,
  Chevron,
  Check,
  X,
  Lock,
  Unlock,
} from './icons.jsx';

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
    <button className={sharing ? 'on' : ''} onClick={sharing ? onStop : onStart}>
      <Screen /> {sharing ? 'Sharing' : 'Share'}
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
      // Drop the socket so a retry starts a clean connection — otherwise the
      // server still has this room pinned to the old socket.
      socket.disconnect();
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

// The moderator's "someone wants in" card. It owns its own enter/exit so the
// card can slide out (0.7s) after Admit/Deny — or if the person is dealt with
// elsewhere / leaves the lobby — instead of vanishing mid-animation.
function JoinRequest({ waiting, onAdmit, onDeny }) {
  const front = waiting[0] ?? null;
  const [shown, setShown] = useState(front);
  const [phase, setPhase] = useState('in'); // 'in' | 'out'
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  // Track the front of the queue while nothing is animating out.
  useEffect(() => {
    if (phase !== 'in') return;
    if (!shown && front) setShown(front);
    else if (shown && (!front || front.id !== shown.id)) setPhase('out');
  }, [phase, shown, front]);

  // Hold the card through its slide-out, then reveal whoever's next (if anyone).
  useEffect(() => {
    if (phase !== 'out') return undefined;
    const t = setTimeout(() => {
      setShown(waitingRef.current[0] ?? null);
      setPhase('in');
    }, 700);
    return () => clearTimeout(t);
  }, [phase]);

  if (!shown) return null;

  const leave = () => setPhase('out');
  const extra = waiting.length > 1 ? ` (+${waiting.length - 1})` : '';

  return (
    <div className={`join-req join-req--${phase}`} key={shown.id}>
      <span>
        <strong>{shown.name}</strong> wants to join
        {extra}
      </span>
      <button
        className="jr-btn jr-deny"
        onClick={() => {
          onDeny(shown.id);
          leave();
        }}
        aria-label={`Deny ${shown.name}`}
      >
        <X />
      </button>
      <button
        className="jr-btn jr-admit"
        onClick={() => {
          onAdmit(shown.id);
          leave();
        }}
        aria-label={`Admit ${shown.name}`}
      >
        <Check />
      </button>
    </div>
  );
}

// --- the in-call screen ----------------------------------------------------
function CallView({ state, chat, typers, selfId, connected, onLeave }) {
  const [tab, setTab] = useState('chat'); // right panel: 'chat' | 'people'
  const [page, setPage] = useState(0); // joiner carousel — which set of three
  const [toasts, setToasts] = useState([]); // transient "X joined" notices
  const seenIdsRef = useRef(null); // participant ids from the previous snapshot

  // Stable reference between snapshots so downstream effects don't churn.
  const participants = useMemo(() => state?.participants ?? [], [state?.participants]);
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
  } = useCall({ selfId, participants, inCall: true, sharing, mode: state?.mode });

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

  // --- media: a big "you" tile + a thumbnail strip; screens take over big ---
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

  // --- layout data for the open-call design ---------------------------
  const micOf = (id) => state?.mics?.[id] ?? true;
  const hostName = participants.find((p) => p.id === state?.hostId)?.name;
  const canShare = !isListener && navigator.mediaDevices?.getDisplayMedia;
  const streamOf = (id) => remotes.find((r) => r.id === id)?.stream;

  // Big tile = a screen if anyone's presenting, otherwise your own camera.
  const mainStream = presenting ? screenTiles[0].stream : localStream;
  const mainMuted = presenting ? Boolean(screenTiles[0].muted) : true;
  const mainName = presenting ? screenTiles[0].label : (self?.name ?? 'You');
  const mainLabel = presenting ? screenTiles[0].label : 'You';

  // The strip below: EVERYONE in the room who isn't on the big tile — driven by
  // the participant list, so a person shows up the instant they join (as an
  // avatar, then their video once the peer connection is up). When someone is
  // presenting, that includes me and any extra screens too.
  const stripTiles = [];
  if (presenting) {
    screenTiles.slice(1).forEach((s) =>
      stripTiles.push({ key: `sc-${s.key}`, stream: s.stream, name: s.label, muted: Boolean(s.muted) }),
    );
    if (self) {
      stripTiles.push({
        key: selfId,
        stream: localStream,
        name: `${self.name ?? 'You'} (you)`,
        muted: true,
        mirror: true,
        speaking: activeSpeakerId === selfId,
        micOn,
        showMic: true,
      });
    }
  }
  participants
    .filter((p) => p.id !== selfId)
    .forEach((p) => {
      stripTiles.push({
        key: p.id,
        stream: streamOf(p.id),
        name: p.name,
        speaking: activeSpeakerId === p.id,
        micOn: micOf(p.id),
        showMic: true,
      });
    });

  // The strip is a carousel: three cards on screen, sliding between "pages" of
  // three. The data drives everything — how many pages, which three show, and
  // whether the arrows are live.
  const PER_PAGE = 3;
  const stripPages = [];
  for (let i = 0; i < stripTiles.length; i += PER_PAGE) {
    stripPages.push(stripTiles.slice(i, i + PER_PAGE));
  }
  const lastPage = Math.max(0, stripPages.length - 1);
  const curPage = Math.min(page, lastPage); // clamp render if people left
  const stripOverflow = stripTiles.length > PER_PAGE;

  // Someone left and collapsed a page we were parked on — step back into range.
  useEffect(() => {
    if (page > lastPage) setPage(lastPage);
  }, [page, lastPage]);

  // Announce new arrivals with a toast that slides in from the edge. We diff the
  // participant ids against the previous snapshot; the very first snapshot is
  // taken as the baseline so we don't greet everyone already in the room.
  useEffect(() => {
    const ids = participants.map((p) => p.id);
    const prev = seenIdsRef.current;
    seenIdsRef.current = ids;
    if (!prev) return;
    const arrivals = participants.filter((p) => p.id !== selfId && !prev.includes(p.id));
    if (arrivals.length === 0) return;
    setToasts((cur) => [
      ...cur,
      ...arrivals.map((p) => ({ key: `${p.id}-${Date.now()}`, name: p.name })),
    ]);
  }, [participants, selfId]);

  // Each toast lives ~3.6s, then slides out (0.7s) before it's dropped. Timers
  // are scheduled once per toast so a re-render can't restart them.
  const toastTimersRef = useRef(new Set());
  useEffect(() => {
    toasts.forEach((t) => {
      if (toastTimersRef.current.has(t.key)) return;
      toastTimersRef.current.add(t.key);
      setTimeout(() => {
        setToasts((cur) => cur.map((x) => (x.key === t.key ? { ...x, leaving: true } : x)));
      }, 3600);
      setTimeout(() => {
        setToasts((cur) => cur.filter((x) => x.key !== t.key));
        toastTimersRef.current.delete(t.key);
      }, 4300);
    });
  }, [toasts]);

  return (
    <div className="bg">
      <div className="shell">
        {toasts.length > 0 && (
          <div className="toast-stack" aria-live="polite">
            {toasts.map((t) => (
              <div className={`toast${t.leaving ? ' toast--out' : ''}`} key={t.key}>
                <span className="toast-dot" aria-hidden="true" />
                <strong>{t.name}</strong> joined
              </div>
            ))}
          </div>
        )}
        <div className="topbar">
          <div className="meeting-pill">
            <h1>{state?.roomId ?? 'Meeting'}</h1>
            <p>
              {hostName ? `hosted by ${hostName}` : 'group call'} · {participants.length} in the room
              {!connected && ' · reconnecting…'}
            </p>
          </div>
          {isModerator && <JoinRequest waiting={waiting} onAdmit={admit} onDeny={deny} />}
        </div>

        {isModerator && (
          <div className="mod-strip">
            <div className="seg" role="group" aria-label="Room mode">
              <button className={!moderated ? 'on' : ''} onClick={() => changeMode(MODES.OPEN)}>
                Open
              </button>
              <button className={moderated ? 'on' : ''} onClick={() => changeMode(MODES.MODERATED)}>
                Moderated
              </button>
            </div>
            <button
              className={`lock-btn${locked ? ' is-locked' : ''}`}
              onClick={toggleLock}
              title={locked ? 'New people must be admitted' : 'Anyone with the link can join'}
            >
              {locked ? <Lock /> : <Unlock />}
              {locked ? 'Locked' : 'Anyone can join'}
            </button>
          </div>
        )}

        {!isModerator && moderated && (
          <p className="banner">🔒 Moderated — the host &amp; co-host control who speaks.</p>
        )}
        {mediaError && <p className="err">{mediaError}</p>}

        {isModerator && moderated && (
          <div className="mod-card">
            <div className="row header">
              <span>Raised hands ({queued.length})</span>
              {grantedSpeakers.length > 0 && (
                <button className="ghost small" onClick={clearFloor}>
                  Clear floor
                </button>
              )}
            </div>
            {queued.length === 0 ? (
              <p className="muted">No one&apos;s waiting.</p>
            ) : (
              queued.map((p, i) => (
                <div className="row" key={p.id}>
                  <span>
                    {i + 1}. {p.name}
                  </span>
                  <span className="actions">
                    <button
                      className="ghost small"
                      disabled={i === 0}
                      onClick={() => moveInQueue(p.id, -1)}
                      aria-label={`Move ${p.name} up`}
                    >
                      ↑
                    </button>
                    <button
                      className="ghost small"
                      disabled={i === queued.length - 1}
                      onClick={() => moveInQueue(p.id, +1)}
                      aria-label={`Move ${p.name} down`}
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

        <div className="stage-row">
          <div className="video-col">
            <div className={`main-tile${presenting ? ' wide' : ''}`}>
              <VideoTile
                stream={mainStream}
                name={mainName}
                muted={mainMuted}
                mirror={!presenting}
                speaking={!presenting && activeSpeakerId === selfId}
                avatarSize={110}
              />

              <span className="you-pill">
                <Avatar name={mainName} size={26} />
                {mainLabel}
              </span>

              {(canShare || canPassMic) && (
                <div className="tile-overlay-btns">
                  {canShare && (
                    <ShareScreenButton
                      sharing={sharingScreen}
                      onStart={startShare}
                      onStop={stopShare}
                    />
                  )}
                  {canPassMic && (
                    <button onClick={passMic}>
                      <Hand /> Pass the mic
                    </button>
                  )}
                </div>
              )}

              <div className="call-controls">
                {isListener ? (
                  <button
                    className={handRaised ? 'off' : ''}
                    onClick={handRaised ? lowerHand : raiseHand}
                    aria-label={handRaised ? 'Lower hand' : 'Raise hand'}
                    title={
                      handRaised
                        ? `You're #${myQueuePos + 1} in line`
                        : 'Raise your hand to ask for the floor'
                    }
                  >
                    <Hand />
                  </button>
                ) : (
                  <>
                    <button
                      className={micOn ? '' : 'off'}
                      onClick={toggleMic}
                      aria-label={micOn ? 'Mute mic' : 'Unmute mic'}
                    >
                      {micOn ? <Mic /> : <MicOff />}
                    </button>
                    <button
                      className={camOn ? '' : 'off'}
                      onClick={toggleCam}
                      aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
                    >
                      {camOn ? <Cam /> : <CamOff />}
                    </button>
                  </>
                )}
                <button className="hangup" onClick={onLeave} aria-label="Leave call">
                  <Phone />
                </button>
              </div>
            </div>

            {stripTiles.length > 0 && (
              <div className="thumb-carousel">
                <div className="thumb-viewport">
                  <div
                    className="thumb-track"
                    style={{ transform: `translateX(-${curPage * 100}%)` }}
                  >
                    {stripPages.map((group, gi) => (
                      <div
                        className="thumb-page"
                        key={gi}
                        aria-hidden={gi !== curPage}
                      >
                        {group.map((t) => (
                          <div className="thumb" key={t.key}>
                            <VideoTile
                              stream={t.stream}
                              name={t.name}
                              muted={t.muted ?? false}
                              mirror={t.mirror ?? false}
                              speaking={t.speaking ?? false}
                              avatarSize={46}
                            />
                            {t.showMic && (
                              <span
                                className={`mic-badge${t.micOn ? '' : ' muted'}`}
                                aria-hidden="true"
                              >
                                {t.micOn ? <Mic /> : <MicOff />}
                              </span>
                            )}
                            <span className="thumb-name">{t.name}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>

                {stripOverflow && (
                  <div className="thumb-nav">
                    {curPage > 0 && (
                      <button
                        className="thumb-nav-btn prev"
                        onClick={() => setPage(curPage - 1)}
                        aria-label="Show previous participants"
                      >
                        <Chevron />
                      </button>
                    )}
                    <button
                      className="thumb-nav-btn next"
                      onClick={() => setPage(curPage + 1)}
                      disabled={curPage >= lastPage}
                      aria-label="Show more participants"
                    >
                      <Chevron />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="side-panel">
            <div className="side-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === 'chat'}
                className={tab === 'chat' ? 'on' : ''}
                onClick={() => setTab('chat')}
              >
                Room Chat
              </button>
              <button
                role="tab"
                aria-selected={tab === 'people'}
                className={tab === 'people' ? 'on' : ''}
                onClick={() => setTab('people')}
              >
                Participant
              </button>
            </div>

            {tab === 'chat' ? (
              <ChatPanel messages={chat} typers={typers} selfId={selfId} />
            ) : (
              <div className="people-list">
                {ordered.map((p) => {
                  const canMod = isModerator && p.id !== selfId && p.role !== ROLES.HOST;
                  const hostControls = isHost && p.id !== selfId && p.role !== ROLES.HOST;
                  return (
                    <div className="person" key={p.id}>
                      <Avatar name={p.name} size={34} />
                      <div className="person-meta">
                        <div className="person-name">
                          {p.name}
                          {p.id === selfId ? ' (you)' : ''}
                        </div>
                        <div className="person-role">
                          <RolePill role={p.role} />
                          {!micOf(p.id) && ' · muted'}
                        </div>
                      </div>
                      <div className="person-actions">
                        {canMod && moderated && p.role === ROLES.LISTENER && (
                          <button className="small" onClick={() => grantFloor(p.id)}>
                            Grant
                          </button>
                        )}
                        {canMod && moderated && p.role === ROLES.SPEAKER && (
                          <button className="ghost small" onClick={() => revokeFloor(p.id)}>
                            Revoke
                          </button>
                        )}
                        {hostControls &&
                          (p.id === cohostId ? (
                            <button className="ghost small" onClick={() => dropCohost(p)}>
                              Un-co-host
                            </button>
                          ) : (
                            <button className="ghost small" onClick={() => makeCohost(p)}>
                              Co-host
                            </button>
                          ))}
                        {canMod && (
                          <button className="ghost small" onClick={() => forceMute(p.id)}>
                            Mute
                          </button>
                        )}
                        {canMod && (
                          <button
                            className="ghost small danger"
                            onClick={() => removeParticipant(p)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
