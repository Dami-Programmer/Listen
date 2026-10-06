// Phase 2 — the client is now split into two screens:
//
//   <PreJoin/>     camera/mic check + room id + name (PreJoin.jsx)
//   <CallView/>    the actual video call (camera tiles + mic/camera/leave)
//
// <App/> owns the Socket.IO lifecycle and the "have we joined yet?" flag, and
// swaps between the two screens. All media logic lives in webrtc.js (the
// useCall hook); this file is UI only.
//
// Phase 7 adds the host's full moderation surface — per-participant Mute /
// Remove / Grant / Revoke and queue reordering — all in <CallView/>. Every
// button here is advisory: the server re-checks that the caller is the host.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EVENTS, MODES, ROLES } from '@listen/shared';
import { socket } from './socket.js';
import { useCall } from './webrtc.js';
import VideoTile from './VideoTile.jsx';
import ChatPanel from './ChatPanel.jsx';
import PreJoin from './PreJoin.jsx';
import Avatar from './Avatar.jsx';
import Toasts from './Toasts.jsx';
import { ConfirmHost, confirmDialog } from './ConfirmDialog.jsx';
import InviteCard from './InviteCard.jsx';
import DevicePicker from './DevicePicker.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import Logo from './Logo.jsx';
import { PipView } from './Pip.jsx';
import { usePip } from './usePip.js';
import { newMeetingCode } from './meeting.js';
import MobileCall from './MobileCall.jsx';
import useIsMobile from './useIsMobile.js';
import {
  Cam,
  CamOff,
  ChatBubble,
  Check,
  ChevronDown,
  GridView,
  Hand,
  LinkIcon,
  Lock,
  Maximize,
  Mic,
  MicOff,
  Minimize,
  People,
  Phone,
  Screen,
  SpotlightView,
  Unlock,
  X,
} from './icons.jsx';

// The viewer's chosen stage layout, remembered in this browser.
const LAYOUT_KEY = 'listen.layout';
function readLayout() {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'spotlight';
  } catch {
    return 'spotlight';
  }
}

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

// Room id lives in the URL (?room=…). No accounts, no persistence.
function readRoomFromUrl() {
  return new URLSearchParams(window.location.search).get('room') ?? '';
}

export default function App() {
  const [roomId, setRoomId] = useState(readRoomFromUrl);
  // Opened from an invite link (?room=… already in the address bar): the
  // meeting is fixed, so the lobby hides the code box entirely. Leaving the
  // call clears it, back to a normal lobby.
  const [invited, setInvited] = useState(() => Boolean(readRoomFromUrl()));
  const [name, setName] = useState('');
  // Meeting name — typed by whoever starts a new meeting (mobile lobby).
  const [title, setTitle] = useState('');
  const [avatar, setAvatar] = useState(null);
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
  // Devices + mic/cam on/off picked in the pre-join lobby, used by the call.
  const [mediaPrefs, setMediaPrefs] = useState(null);
  // STUN + TURN servers for the call, sent by the server in the join ack.
  const [iceServers, setIceServers] = useState(null);

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
    // Someone edited one of their messages: swap in the new text.
    function onChatEdited({ id, text, editedAt }) {
      setChat((c) => c.map((m) => (m.id === id ? { ...m, text, editedAt } : m)));
    }
    // Someone unsent one of their messages. We don't delete it from the list
    // straight away — we flag it `unsent`, so the chat panel can play a
    // fade-out first; the panel then stops drawing it. Everything else
    // (unread badge, avatars) already ignores unsent messages.
    function onChatUnsent({ id }) {
      setChat((c) => c.map((m) => (m.id === id ? { ...m, unsent: true } : m)));
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

    // 'connect' / 'disconnect' are Socket.IO's own built-in lifecycle events —
    // not part of our EVENTS enum, so they stay as literal strings.
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on(EVENTS.ROOM_STATE, onRoomState);
    socket.on(EVENTS.ERROR, onRoomError);
    socket.on(EVENTS.REMOVED, onRemoved);
    socket.on(EVENTS.ADMITTED, onAdmitted);
    socket.on(EVENTS.DENIED, onDenied);
    socket.on(EVENTS.CHAT_MESSAGE, onChatMessage);
    socket.on(EVENTS.CHAT_EDITED, onChatEdited);
    socket.on(EVENTS.CHAT_UNSENT, onChatUnsent);
    socket.on(EVENTS.CHAT_TYPING, onChatTyping);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(EVENTS.ROOM_STATE, onRoomState);
      socket.off(EVENTS.ERROR, onRoomError);
      socket.off(EVENTS.REMOVED, onRemoved);
      socket.off(EVENTS.ADMITTED, onAdmitted);
      socket.off(EVENTS.DENIED, onDenied);
      socket.off(EVENTS.CHAT_MESSAGE, onChatMessage);
      socket.off(EVENTS.CHAT_EDITED, onChatEdited);
      socket.off(EVENTS.CHAT_UNSENT, onChatUnsent);
      socket.off(EVENTS.CHAT_TYPING, onChatTyping);
    };
  }, []);

  function handleJoin(e, prefs) {
    e.preventDefault();
    setError(null);
    setMediaPrefs(prefs ?? null);
    setRemovedNote(null);
    if (!name.trim()) return;
    // No code typed -> this is a brand-new meeting with its own code.
    const id = roomId.trim() || newMeetingCode();
    setRoomId(id);

    // Reflect the room in the URL so it's shareable.
    const url = new URL(window.location.href);
    url.searchParams.set('room', id);
    window.history.replaceState({}, '', url);

    if (!socket.connected) socket.connect();
    socket.emit(EVENTS.JOIN_ROOM, { roomId: id, name: name.trim(), avatar, title: title.trim() }, (ack) => {
      if (ack?.ok) setIceServers(ack.iceServers ?? null);
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
    // Leaving (or cancelling a knock) wipes the form: name, picture and
    // meeting code, plus the ?room= in the address bar, so the next person at
    // this screen starts from scratch.
    setName('');
    setTitle('');
    setAvatar(null);
    setRoomId('');
    setInvited(false);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
  }

  if (waiting) {
    return <WaitingScreen roomId={roomId} onCancel={handleLeave} />;
  }

  if (!joined) {
    return (
      <PreJoin
        roomId={roomId}
        invited={invited}
        name={name}
        title={title}
        avatar={avatar}
        error={error}
        note={removedNote}
        onRoomId={setRoomId}
        onName={setName}
        onTitle={setTitle}
        onAvatar={setAvatar}
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
      media={mediaPrefs}
      iceServers={iceServers}
    />
  );
}

// --- the locked-room lobby -----------------------------------------------
function WaitingScreen({ roomId, onCancel }) {
  const isMobile = useIsMobile();
  // Phones: same white page as the mobile lobby.
  if (isMobile) {
    return (
      <main className="prejoin pjm pjm-wait" aria-live="polite">
        <div className="pjm-wait-body">
          <div className="pjm-wait-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <h1>Knock knock 👋</h1>
          <p>Waiting for the host to let you in.</p>
          <code>{roomId}</code>
          <button type="button" className="pjm-wait-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </main>
    );
  }
  return (
    <main className="page">
      <Logo />
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

// Open/close state for something that should animate OUT before it vanishes.
//
// React removes an element the instant we stop rendering it — too soon for a
// closing animation to play. So "close" happens in two steps:
//   1. hide() sets `closing`: the element stays on screen, but gets a
//      `.closing` class whose CSS plays the exit animation.
//   2. When that animation finishes, the element's onAnimationEnd calls
//      onExitEnd(), which finally sets `open` to false and unmounts it.
// (Same trick as the image viewer — see ImageViewer.jsx.)
//
//   open     — render it? (still true while the exit animation plays)
//   closing  — the exit animation is playing
function useExitable() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const show = () => {
    setOpen(true);
    setClosing(false); // re-opening mid-exit cancels the exit
  };
  const hide = () => setClosing(true);
  const toggle = () => (open && !closing ? hide() : show());
  function onExitEnd(e) {
    // Children's animations bubble their animationend up to here too (and
    // the ENTRANCE animation ends here as well) — only the element's own exit
    // animation should remove it.
    if (e.target !== e.currentTarget || !closing) return;
    setOpen(false);
    setClosing(false);
  }
  // Close instantly, no animation — for when a parent is already animating
  // away and taking this with it.
  const reset = () => {
    setOpen(false);
    setClosing(false);
  };
  return { open, closing, show, hide, toggle, onExitEnd, reset, setClosing };
}

// --- the in-call screen ----------------------------------------------------
function CallView({ state, chat, typers, selfId, connected, onLeave, media, iceServers }) {
  const participants = state?.participants ?? [];
  const isMobile = useIsMobile();
  // Side panel (chat, participants, moderation) — toggled by the chat button,
  // closed by it or by the panel's ✕. Slides out before it disappears.
  const panel = useExitable();
  const panelOpen = panel.open && !panel.closing; // "open" as far as unread counting cares
  // The chat panel's people dropdown (participants + moderation), and the row
  // it hangs off — used to close it on a click anywhere outside. It also
  // animates out (folds back up into its button).
  const people = useExitable();
  const peopleOpen = people.open && !people.closing;
  const { setClosing: setPeopleClosing } = people; // stable setter, safe for the effect below
  const peopleRef = useRef(null);
  // The dropdown lives inside the panel. If the panel closes while it's open,
  // it leaves with the panel — so the next time the panel opens, start with
  // the dropdown closed rather than popping straight back open.
  if (!panel.open && people.open) people.reset();
  useEffect(() => {
    if (!peopleOpen) return undefined;
    function onDown(e) {
      if (peopleRef.current && !peopleRef.current.contains(e.target)) setPeopleClosing(true);
    }
    function onKey(e) {
      if (e.key === 'Escape') setPeopleClosing(true);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [peopleOpen, setPeopleClosing]);
  // Tablet / desktop: a tap or click anywhere outside the chat panel closes
  // it. Not the chat button (it toggles the panel itself), and not things
  // drawn over the page on the panel's behalf — chat toasts (they open it),
  // the photo viewer and confirm dialogs.
  const panelRef = useRef(null);
  const chatBtnRef = useRef(null);
  const { setClosing: setPanelClosing } = panel; // stable setter
  useEffect(() => {
    if (!panelOpen) return undefined;
    function onDown(e) {
      const t = e.target;
      if (panelRef.current?.contains(t) || chatBtnRef.current?.contains(t)) return;
      if (t.closest?.('.toasts, .img-viewer, .confirm-backdrop')) return;
      setPanelClosing(true);
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [panelOpen, setPanelClosing]);
  // Unread badge on the chat button: other people's messages you haven't seen
  // yet. Opening the panel marks them all read.
  //
  // We remember WHICH messages you've seen (their ids), not just how many —
  // with unsend, counts alone go wrong (unsend a read message and the next
  // new one wouldn't show). Unread = other people's messages, not unsent,
  // whose id isn't in `readIds`.
  //
  // `readIds` starts empty, so for someone who joins late, every message
  // already in the room's history (the server hands it over on join) counts
  // as unread — the badge shows e.g. "7" the moment they arrive, telling them
  // there's a conversation to catch up on.
  const [readIds, setReadIds] = useState(() => new Set());
  const unreadMsgs = chat.filter((m) => m.from !== selfId && !m.unsent && !readIds.has(m.id));
  if (panelOpen && unreadMsgs.length > 0) setReadIds(new Set(chat.map((m) => m.id)));
  const unread = panelOpen ? 0 : unreadMsgs.length;
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
    devices,
    switchDevice,
    startShare,
    stopShare,
    mediaError,
    isListener,
  } = useCall({
    selfId,
    iceServers,
    participants,
    inCall: true,
    sharing,
    mode: state?.mode,
    media,
  });

  // The floating mini-call shown while you're on another tab (Pip.jsx).
  const { pipWin } = usePip();

  const isHost = self?.role === ROLES.HOST;
  // A moderator is the host OR the appointed co-host — same control surface.
  const isModerator = isHost || self?.role === ROLES.COHOST;
  // Whoever starts a meeting (first in, so host, and alone) gets the invite
  // link straight away; anyone can reopen it from the Invite button.
  const [inviteOpen, setInviteOpen] = useState(() => isHost && participants.length === 1);
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

  // Is this person's mic live? Every client reports its own mic to the server
  // (MIC_STATE), which shares the whole room's in `state.mics`. Anyone we
  // haven't heard about yet is assumed live, so nobody is wrongly shown muted.
  const micOf = (id) => state?.mics?.[id] ?? true;
  // Same for cameras (CAM_STATE -> `state.cams`).
  const camOf = (id) => state?.cams?.[id] ?? true;

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
      // My own mic: read straight from the hook — it's instant, no round trip.
      micOff: !micOn,
    },
    ...remotes.map(({ id, stream }) => ({
      key: id,
      stream,
      label: peerOf(id)?.name ?? 'Guest',
      role: peerOf(id)?.role,
      speaking: activeSpeakerId === id,
      // Everyone else's mic: what they last reported via the server.
      micOff: !micOf(id),
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

  // Google-Meet-style: only one presenter at a time. If someone else already
  // has the floor, starting your own share interrupts theirs — so confirm
  // first rather than silently cutting them off.
  const otherPresenterId = Object.keys(sharing).find((id) => id !== selfId) ?? null;
  async function handleStartShare() {
    if (otherPresenterId) {
      const presenter = peerOf(otherPresenterId);
      const ok = await confirmDialog({
        title: `${presenter?.name ?? 'Someone'} is presenting`,
        message: 'Stop their share and present instead?',
        confirmLabel: 'Present instead',
        person: presenter,
      });
      if (!ok) return;
    }
    startShare();
  }

  // Participant list sorted host-first, then co-host, speakers, listeners, A-Z.
  const ordered = [...participants].sort(
    (a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.name.localeCompare(b.name),
  );

  // Moderator-only: flip the room mode. The server re-checks that the caller is
  // a moderator — this button just isn't rendered for anyone else.
  function changeMode(mode) {
    socket.emit(EVENTS.SET_MODE, { mode }, (ack) => {
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
  const raiseHand = () => emit(EVENTS.RAISE_HAND);
  const lowerHand = () => emit(EVENTS.LOWER_HAND); // lower my own hand
  const dismissHand = (targetId) => emit(EVENTS.LOWER_HAND, { targetId }); // moderator
  const grantFloor = (targetId) => emit(EVENTS.GRANT_FLOOR, { targetId });
  const revokeFloor = (targetId) => emit(EVENTS.REVOKE_FLOOR, { targetId });
  const passMic = () => emit(EVENTS.PASS_MIC); // a speaker hands the floor on

  // A plain speaker in a moderated room can pass the mic (host / co-host hold
  // the room, not "the mic").
  const canPassMic = moderated && self?.role === ROLES.SPEAKER;

  // Phase 7 — moderation. Destructive actions confirm first.
  const forceMute = (targetId) => emit(EVENTS.FORCE_MUTE, { targetId });
  async function removeParticipant(p) {
    const ok = await confirmDialog({
      title: `Remove ${p.name} from the call?`,
      message: 'They’ll be taken out of the meeting right away.',
      confirmLabel: 'Remove',
      danger: true,
      person: p,
    });
    if (ok) emit(EVENTS.REMOVE_PARTICIPANT, { targetId: p.id });
  }
  async function clearFloor() {
    const ok = await confirmDialog({
      title: 'Clear the floor?',
      message: 'Every speaker goes back to listening.',
      confirmLabel: 'Clear floor',
      danger: true,
    });
    if (ok) emit(EVENTS.CLEAR_FLOOR);
  }

  // Co-host — host-only.
  const makeCohost = (p) => emit(EVENTS.PROMOTE_COHOST, { targetId: p.id });
  async function dropCohost(p) {
    const ok = await confirmDialog({
      title: `Remove ${p.name} as co-host?`,
      message: 'They stay in the call.',
      confirmLabel: 'Remove co-host',
      danger: true,
      person: p,
    });
    if (ok) emit(EVENTS.DEMOTE_COHOST, { targetId: p.id });
  }

  // Waiting room — moderator-only.
  const admit = (id) => emit(EVENTS.ADMIT, { socketId: id });
  const deny = (id) => emit(EVENTS.DENY, { socketId: id });
  const toggleLock = () => emit(EVENTS.SET_LOCK, { locked: !locked });
  // Move one queued person up (dir -1) or down (dir +1). The server only accepts
  // a full reordering of the current queue, so we send the whole new order.
  function moveInQueue(id, dir) {
    const order = queue.slice();
    const i = order.indexOf(id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    emit(EVENTS.REORDER_QUEUE, { order });
  }

  // The one big tile: a screen share if anyone is presenting, otherwise the
  // other person who's talking, otherwise the first other person. You're only
  // big when you're alone — your own camera always sits in the small corner.
  const others = cameraTiles.filter((t) => t.key !== 'me');
  const selfTile = cameraTiles.find((t) => t.key === 'me');
  // 6+ people: click any small tile (yours included) to put it on the big
  // screen. The pick sticks until you click another one; if that person
  // leaves, we fall back to the automatic choice below.
  const [pinnedKey, setPinnedKey] = useState(null);
  const canPick = !presenting && cameraTiles.length >= 6;
  const pinned = canPick ? cameraTiles.find((t) => t.key === pinnedKey) : null;
  const spotlight = presenting
    ? screenTiles[0]
    : (pinned ?? others.find((t) => t.speaking) ?? others[0] ?? selfTile);
  // Everyone not in the spotlight sits in a small strip over its corner, with
  // you pinned at the far right.
  const stripTiles = (presenting ? others : others.filter((t) => t !== spotlight)).concat(
    selfTile && spotlight !== selfTile ? [selfTile] : [],
  );
  const spotlightName = spotlight?.key === 'me' ? (self?.name ?? 'You') : spotlight?.label;
  // "<name> is muted" works for anyone now — each tile carries its own
  // `micOff` flag (see cameraTiles above). A screen share has no mic of its
  // own, so it never says muted.
  const spotlightMuted = !presenting && Boolean(spotlight?.micOff);

  // While presenting, the big tile's pill names the PRESENTER (not "X's
  // screen") with their live mic state: "[mic] Christina Jona is muted".
  const presenterCam = presenting ? cameraTiles.find((t) => t.key === spotlight.key) : null;
  const pillName = presenting
    ? spotlight.key === 'me'
      ? (self?.name ?? 'You')
      : (peerOf(spotlight.key)?.name ?? 'Guest')
    : spotlightName;
  const pillMuted = presenting ? Boolean(presenterCam?.micOff) : spotlightMuted;

  // Full screen for people WATCHING someone else's screen share (the
  // presenter doesn't need to see their own screen bigger). The button blows
  // up the whole stage tile — share + presenter's name pill — and Esc or the
  // button again brings it back. Double-clicking the share does the same.
  const stageRef = useRef(null);
  const [stageFull, setStageFull] = useState(false);
  const viewingShare = presenting && spotlight?.key !== 'me';
  useEffect(() => {
    const sync = () =>
      setStageFull(
        Boolean(stageRef.current) &&
          (document.fullscreenElement ?? document.webkitFullscreenElement) === stageRef.current,
      );
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);
  const exitFullscreen = () =>
    (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
  // The presenter stopped sharing while we were full screen: step back out
  // rather than leave a full-screen camera tile behind.
  useEffect(() => {
    if (!viewingShare && stageFull) exitFullscreen();
  }, [viewingShare, stageFull]);
  function toggleStageFull() {
    const el = stageRef.current;
    if (!el) return;
    if (stageFull) exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    // iPhone Safari can only full-screen a <video> itself.
    else el.querySelector('video')?.webkitEnterFullscreen?.();
  }

  // Who the floating mini-call (Pip.jsx) shows: the presenter's screen, or the
  // spotlight person — as their avatar on a card while their camera is off.
  const pipPerson = !spotlight
    ? null
    : presenting
      ? { name: pillName, micOff: pillMuted }
      : spotlight.key === 'me'
        ? { name: self?.name ?? 'You', avatar: self?.avatar, camOff: !camOn, micOff: !micOn }
        : {
            name: peerOf(spotlight.key)?.name ?? 'Guest',
            avatar: peerOf(spotlight.key)?.avatar,
            camOff: !camOf(spotlight.key),
            micOff: !micOf(spotlight.key),
          };

  // Equal-tile layouts, from the designs:
  //   2 others ("2 screen"): two tiles side by side
  //   3 others ("3 screen"): one tile centered on top, two side by side below
  //   4 others ("5 people"): a 2 x 2 grid
  // All tiles the same size, no big frame, your small self-view floating in
  // the stage. Only while nobody is presenting; every other case keeps the
  // big-tile layout below. `gridCount` is 0 when the grid isn't used.
  const gridCount = !presenting && [2, 3, 4].includes(others.length) ? others.length : 0;

  // The viewer's layout choice (control-bar toggle):
  //   'spotlight' — everything above: big tile + your small self-view
  //   'grid'      — EVERYONE, you included, in equal tiles; no small screen
  // A screen share still takes the stage in either mode.
  const [layout, setLayout] = useState(readLayout);
  function toggleLayout() {
    const next = layout === 'grid' ? 'spotlight' : 'grid';
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* private mode etc. — the choice just won't be remembered */
    }
  }
  const equalGrid = layout === 'grid' && !presenting;
  // Near-square arrangement: 1 -> 1x1, 2 -> 2x1, 3-4 -> 2x2, 5-6 -> 3x2,
  // 7-9 -> 3x3, 10-12 -> 4x3 ... An unfilled last row is centered.
  const eqCols = Math.max(1, Math.ceil(Math.sqrt(cameraTiles.length)));
  const eqRows = Math.max(1, Math.ceil(cameraTiles.length / eqCols));

  // Your own small screen in the grid layouts — the exact same tile as the
  // self-view in the one-other-person layout (it reuses the `.cs-strip`
  // styles). Where it goes depends on where there's room:
  //   2 others: empty space bottom-right of the stage
  //   3 others: empty space right of the top tile
  //   4 others: no empty space at all, so it sits INSIDE the last (bottom-
  //             right) tile's corner — just like it overlaps the big tile
  //             in the one-other layout. `inset` adds that 16px margin.
  const selfInLastTile = gridCount === 4;
  const selfView = selfTile && (
    <div className={`cs-strip cs-self-float${selfInLastTile ? ' inset' : ''}`}>
      <VideoTile
        sinkId={media?.speakerId}
        stream={selfTile.stream}
        label={selfTile.label}
        speaking={selfTile.speaking}
        muted={selfTile.muted}
        mirror={selfTile.mirror}
        micOff={selfTile.micOff}
      />
    </div>
  );

  const knocker = isModerator ? waiting[0] : null;

  // Everyone but me — for the avatar row at the top of the chat panel (I'm
  // shown separately, top-right).
  const otherPeople = participants.filter((p) => p.id !== selfId);

  // Phones get their own call screen (MobileCall.jsx) over the same call state.
  if (isMobile) {
    return (
      <>
        <MobileCall
          call={{
            state,
            chat,
            typers,
            selfId,
            connected,
            onLeave,
            media,
            participants,
            self,
            isHost,
            isModerator,
            moderated,
            locked,
            waiting,
            queue,
            queued,
            handRaised,
            myQueuePos,
            isListener,
            canPassMic,
            cameraTiles,
            screenTiles,
            presenting,
            micOn,
            camOn,
            sharingScreen,
            toggleMic,
            toggleCam,
            devices,
            switchDevice,
            startShare: handleStartShare,
            stopShare,
            mediaError,
            layout,
            toggleLayout,
            micOf,
            camOf,
            cohostId,
            act: {
              changeMode,
              toggleLock,
              admit,
              deny,
              grantFloor,
              revokeFloor,
              dismissHand,
              moveInQueue,
              forceMute,
              removeParticipant,
              clearFloor,
              makeCohost,
              dropCohost,
              raiseHand,
              lowerHand,
              passMic,
            },
          }}
        />
        <ConfirmHost />
      </>
    );
  }

  return (
    <main className="callscreen">
      {/* Left column: everything that was already on screen — topbar, video,
          controls. The chat panel is a sibling column so it can run the full
          height of the window, like the design. */}
      <div className="cs-stage-col">
        <header className="cs-topbar">
          <div className="cs-brand-col">
            <Logo />
          </div>
          <div className="cs-title-row">
            <h1>{state?.title || state?.roomId}</h1>
            <button
              className={`cs-invite-btn${inviteOpen ? ' on' : ''}`}
              onClick={() => setInviteOpen((v) => !v)}
              aria-expanded={inviteOpen}
              title="Get the invite link"
            >
              <LinkIcon /> Invite
            </button>
            {/* light / dark switch, right next to Invite */}
            <ThemeToggle />
            {isHost && (
              <ModeSwitch
                moderated={moderated}
                onToggle={() => changeMode(moderated ? MODES.OPEN : MODES.MODERATED)}
              />
            )}
            {!connected && <span className="cs-status">reconnecting…</span>}
          </div>

          <JoinRequest
            knocker={knocker}
            extra={Math.max(0, waiting.length - 1)}
            onAdmit={admit}
            onDeny={deny}
          />
        </header>

        {mediaError && <p className="err">{mediaError}</p>}

        <div className="cs-body">
          {equalGrid ? (
            // Grid view: everyone (me first) in same-size tiles. --cols /
            // --rows drive the tile size in the CSS.
            <div className="cs-eqgrid" style={{ '--cols': eqCols, '--rows': eqRows }}>
              {cameraTiles.map((t) => (
                <div key={t.key} className={`cs-grid-tile${t.speaking ? ' speaking' : ''}`}>
                  <VideoTile
                    sinkId={media?.speakerId}
                    stream={t.stream}
                    label={t.label}
                    muted={t.muted}
                    mirror={t.mirror}
                  />
                  <div className="cs-name-pill">
                    <span className="cs-name-icon">{t.micOff ? <MicOff /> : <Mic />}</span>
                    {t.micOff ? `${t.label} is muted` : t.label}
                  </div>
                </div>
              ))}
            </div>
          ) : gridCount ? (
            // `cs-grid-2` / `-3` / `-4` pick the arrangement in the CSS.
            <div className={`cs-grid cs-grid-${gridCount}`}>
              {others.map((t, i) => (
                // One of the equal tiles. The glow for "this person is
                // talking" goes on this wrapper (not the video inside it), so
                // the rounded corners don't clip it.
                <div key={t.key} className={`cs-grid-tile${t.speaking ? ' speaking' : ''}`}>
                  <VideoTile
                    sinkId={media?.speakerId}
                    stream={t.stream}
                    label={t.label}
                    muted={t.muted}
                    mirror={t.mirror}
                  />
                  {/* Same "[mic] Jonas Berg is muted" pill as the big tile. */}
                  <div className="cs-name-pill">
                    <span className="cs-name-icon">{t.micOff ? <MicOff /> : <Mic />}</span>
                    {t.micOff ? `${t.label} is muted` : t.label}
                  </div>
                  {/* 4 others: your self-view lives in the last tile's corner */}
                  {selfInLastTile && i === others.length - 1 && selfView}
                </div>
              ))}
              {/* 2 / 3 others: your self-view floats in the stage's free space */}
              {!selfInLastTile && selfView}
            </div>
          ) : (
            <div
              className={`cs-main-tile${stageFull ? ' is-full' : ''}`}
              ref={stageRef}
              onDoubleClick={viewingShare ? toggleStageFull : undefined}
            >
              {spotlight && (
                <VideoTile
                  sinkId={media?.speakerId}
                  key={presenting ? `screen-${spotlight.key}` : spotlight.key}
                  stream={spotlight.stream}
                  label={spotlight.label}
                  muted={spotlight.muted}
                  mirror={spotlight.mirror}
                  screen={presenting}
                />
              )}
              {spotlight && (
                <div className="cs-name-pill">
                  <span className="cs-name-icon">{pillMuted ? <MicOff /> : <Mic />}</span>
                  {pillMuted ? `${pillName} is muted` : pillName}
                </div>
              )}
              {viewingShare && (
                <button
                  type="button"
                  className="cs-fullscreen-btn"
                  onClick={toggleStageFull}
                  aria-label={stageFull ? 'Exit full screen' : 'Full screen'}
                  title={stageFull ? 'Exit full screen (Esc)' : 'Full screen'}
                >
                  {stageFull ? <Minimize /> : <Maximize />}
                </button>
              )}
              {!presenting && stripTiles.length > 0 && (
                <div className="cs-strip">
                  {stripTiles.map((t) => {
                    const tile = (
                      <VideoTile
                        sinkId={media?.speakerId}
                        key={t.key}
                        stream={t.stream}
                        label={t.label}
                        speaking={t.speaking}
                        muted={t.muted}
                        mirror={t.mirror}
                        micOff={t.micOff}
                      />
                    );
                    return canPick ? (
                      <button
                        key={t.key}
                        className="cs-strip-pick"
                        onClick={() => setPinnedKey(t.key)}
                        aria-label={`Show ${t.label} on the big screen`}
                        title={`Show ${t.label} on the big screen`}
                      >
                        {tile}
                      </button>
                    ) : (
                      tile
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {/* Presenting: everyone's camera (you included) in a column beside
              the share — the same in spotlight and grid view. */}
          {presenting && <SideStrip tiles={cameraTiles} sinkId={media?.speakerId} />}

          {/* Whoever holds the floor gets "Pass the mic" right on the stage —
              faded until hovered, so it never gets in the way of the video. */}
          {canPassMic && (
            <button
              className="cs-pass-mic"
              onClick={passMic}
              title="Hand the floor to the next raised hand"
            >
              🎤 Pass the mic
            </button>
          )}
        </div>

        <footer className="cs-controls">
          {/* Door lock, bottom-left — the mirror of the chat button. Moderators
              only: locked = newcomers wait to be admitted. */}
          {isModerator && (
            <button
              className={`cs-door-btn${locked ? ' on' : ''}`}
              onClick={toggleLock}
              aria-label={locked ? 'Door locked — click to open' : 'Door open — click to lock'}
              title={
                locked
                  ? 'Door locked: new people must be admitted'
                  : 'Door open: anyone with the link can join'
              }
            >
              {locked ? <Lock /> : <Unlock />}
            </button>
          )}
          <div className="cs-controls-center">
            {/* Mic and camera each carry a ^ on their left that opens the
                device list (DevicePicker) — Google-Meet style. */}
            <DevicePicker kind="video" current={devices.video} onSwitch={switchDevice}>
              <button
                onClick={toggleCam}
                aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
                title={camOn ? 'Turn camera off' : 'Turn camera on'}
              >
                {camOn ? <Cam /> : <CamOff />}
              </button>
            </DevicePicker>
            <DevicePicker kind="audio" current={devices.audio} onSwitch={switchDevice}>
              <button
                onClick={toggleMic}
                disabled={isListener}
                aria-label={micOn ? 'Mute' : 'Unmute'}
                title={
                  isListener ? 'Raise your hand to ask for the floor' : micOn ? 'Mute' : 'Unmute'
                }
              >
                {micOn && !isListener ? <Mic /> : <MicOff />}
              </button>
            </DevicePicker>
            {/* Host / co-host run the floor, so they never raise a hand. For
                everyone else it only does something as a moderated listener. */}
            {!isModerator && (
              <button
                className={handRaised ? 'on' : ''}
                onClick={handRaised ? lowerHand : raiseHand}
                disabled={!isListener}
                aria-label={handRaised ? 'Lower hand' : 'Raise hand'}
                title={
                  isListener
                    ? handRaised
                      ? `Lower hand (#${myQueuePos + 1} in line)`
                      : 'Raise hand'
                    : moderated
                      ? 'You already have the floor'
                      : 'Hand-raising is for moderated rooms'
                }
              >
                <Hand />
              </button>
            )}
            <button
              className="cs-hangup"
              onClick={onLeave}
              aria-label="Leave call"
              title="Leave call"
            >
              <Phone />
            </button>
            {!isListener && navigator.mediaDevices?.getDisplayMedia && (
              <button
                className={sharingScreen ? 'on' : ''}
                onClick={sharingScreen ? stopShare : handleStartShare}
                aria-label={sharingScreen ? 'Stop sharing' : 'Share screen'}
                title={sharingScreen ? 'Stop sharing' : 'Share screen'}
              >
                <Screen />
              </button>
            )}
            <button
              className={layout === 'grid' ? 'on' : ''}
              onClick={toggleLayout}
              aria-label={layout === 'grid' ? 'Switch to spotlight view' : 'Switch to grid view'}
              title={
                presenting
                  ? 'Layout applies when nobody is presenting'
                  : layout === 'grid'
                    ? 'Spotlight view'
                    : 'Grid view'
              }
            >
              {layout === 'grid' ? <SpotlightView /> : <GridView />}
            </button>
          </div>
          <button
            ref={chatBtnRef}
            className={`cs-chat-btn${panelOpen ? ' on' : ''}`}
            onClick={panel.toggle}
            aria-label={[
              panelOpen ? 'Hide chat' : 'Show chat',
              !panelOpen && unread > 0 && `${unread} unread`,
              isModerator && moderated && queue.length > 0 && `${queue.length} hand(s) raised`,
            ]
              .filter(Boolean)
              .join(', ')}
            title={panelOpen ? 'Hide chat' : 'Show chat'}
          >
            <ChatBubble />
            {isModerator && moderated && queue.length > 0 && (
              <span
                key={`hand-${queue.length}`}
                className="cs-hand-flag"
                title={`${queue.length} hand${queue.length > 1 ? 's' : ''} raised`}
              >
                <Hand />
                {queue.length > 1 && <b>{queue.length}</b>}
              </span>
            )}
            {unread > 0 && (
              <span key={unread} className="cs-unread" aria-hidden="true">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        </footer>

        {inviteOpen && state?.roomId && (
          <InviteCard roomId={state.roomId} locked={locked} onClose={() => setInviteOpen(false)} />
        )}

        {pipWin && (
          <PipView
            win={pipWin}
            main={spotlight}
            person={pipPerson}
            self={selfTile}
            controls={{
              micOn,
              camOn,
              isListener,
              showHand: !isModerator && isListener,
              handRaised,
              toggleMic,
              toggleCam,
              toggleHand: handRaised ? lowerHand : raiseHand,
              onLeave,
            }}
          />
        )}

        <Toasts
          chat={chat}
          queue={queue}
          selfId={selfId}
          participants={participants}
          panelOpen={panelOpen}
          onOpen={panel.show}
        />
        <ConfirmHost />
      </div>

      {/* Right column: the chat panel (design: "Design Sprint Meeting" chat).
          Top to bottom: close + my avatar; the people button + who's here;
          the messages and composer (ChatPanel). */}
      {panel.open && (
        <aside
          ref={panelRef}
          // `.closing` swaps the slide-in for the slide-out; when that ends,
          // onExitEnd removes the panel for real.
          className={`cs-panel${panel.closing ? ' closing' : ''}`}
          onAnimationEnd={panel.onExitEnd}
        >
          <div className="cp-head">
            <button
              className="cp-close"
              onClick={panel.hide}
              aria-label="Close chat"
              title="Close chat"
            >
              <X />
            </button>
            {/* Me, top-right. My dot uses my own mic state directly. */}
            {self && (
              <Avatar name={self.name} src={self.avatar} size={44} status={micOn ? 'on' : 'off'} />
            )}
          </div>

          <div className="cp-people-row" ref={peopleRef}>
            {/* Opens the dropdown with everything the old panel had: the
                participant list + moderation, door lock, pass-the-mic and
                raised hands. */}
            <button
              className={`cp-people-btn${peopleOpen ? ' on' : ''}`}
              onClick={people.toggle}
              aria-expanded={peopleOpen}
              aria-label="People and room controls"
              title="People and room controls"
            >
              <People className="cp-people-icon" />
              <ChevronDown className="cp-chevron" />
            </button>

            {/* Up to three other people, then "+ N" for the rest. Dots: green
                = mic on, red = muted (from the shared `mics` map). */}
            <div className="cp-avatars">
              {otherPeople.slice(0, 3).map((p) => (
                <Avatar
                  key={p.id}
                  name={p.name}
                  src={p.avatar}
                  size={38}
                  status={micOf(p.id) ? 'on' : 'off'}
                />
              ))}
              {otherPeople.length > 3 && (
                <span className="cp-more">+ {otherPeople.length - 3}</span>
              )}
            </div>

            {people.open && (
              <div
                className={`cp-people-pop${people.closing ? ' closing' : ''}`}
                onAnimationEnd={people.onExitEnd}
              >
                {isListener && (
                  <p className="muted">
                    🎧 Listening only &mdash;{' '}
                    {handRaised
                      ? `you're #${myQueuePos + 1} in line for the floor.`
                      : 'raise your hand to ask for the floor.'}
                  </p>
                )}

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

                <div className="card">
                  <div className="row header">
                    <span>Participants ({participants.length})</span>
                  </div>
                  {ordered.map((p) => {
                    const canMod = isModerator && p.id !== selfId && p.role !== ROLES.HOST;
                    const hostControls = isHost && p.id !== selfId && p.role !== ROLES.HOST;
                    return (
                      <div className="row" key={p.id}>
                        <span>
                          {p.name}
                          {p.id === selfId ? ' (you)' : ''}
                        </span>
                        <span className="actions">
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
                            <button
                              className="ghost small danger"
                              onClick={() => removeParticipant(p)}
                            >
                              Remove
                            </button>
                          )}
                          <RolePill role={p.role} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <ChatPanel
            messages={chat}
            typers={typers}
            selfId={selfId}
            mics={state?.mics ?? {}}
            participants={participants}
          />
        </aside>
      )}
    </main>
  );
}

// Host-only Open / Moderated badge. Both labels are always rendered on top of
// each other: the active one slides/fades in, the other slides/fades out, the
// colour cross-fades, and the pill's width glides to fit the new word.
function ModeSwitch({ moderated, onToggle }) {
  const btnRef = useRef(null);
  const openRef = useRef(null);
  const modRef = useRef(null);

  useLayoutEffect(() => {
    const btn = btnRef.current;
    let stale = false;
    const fit = () => {
      const label = moderated ? modRef.current : openRef.current;
      if (stale || !btn || !label) return;
      const { paddingLeft, paddingRight, borderLeftWidth, borderRightWidth } =
        getComputedStyle(btn);
      const extra = [paddingLeft, paddingRight, borderLeftWidth, borderRightWidth].reduce(
        (sum, v) => sum + parseFloat(v),
        0,
      );
      btn.style.width = `${label.offsetWidth + extra}px`;
    };
    fit();
    // Re-fit once the web font has loaded and changed the word widths.
    document.fonts?.ready.then(fit);
    // A toggle before the font loads must not let the old mode's fit win.
    return () => {
      stale = true;
    };
  }, [moderated]);

  return (
    <button
      ref={btnRef}
      className={`cs-mode-badge${moderated ? ' moderated' : ''}`}
      onClick={onToggle}
      title="Switch room mode"
      aria-label={`Room is ${moderated ? 'moderated' : 'open'} — click to switch`}
    >
      <span ref={openRef} className={`cs-mode-label${moderated ? '' : ' active'}`}>
        Open
      </span>
      <span ref={modRef} className={`cs-mode-label${moderated ? ' active' : ''}`}>
        Moderated
      </span>
    </button>
  );
}

// Top-right "X wants to join the meeting" pill. Slides/fades in when someone
// knocks and back out when they're admitted or denied (by any moderator). It
// keeps showing the outgoing person until the exit animation ends, then swaps
// to whoever is next in line.
function JoinRequest({ knocker: incoming, extra, onAdmit, onDeny }) {
  const [shown, setShown] = useState(incoming);
  const [leaving, setLeaving] = useState(false);
  // Whoever we just admitted/denied — ignored until the server's snapshot
  // catches up, so the pill doesn't bounce back in.
  const [handled, setHandled] = useState(null);
  const knocker = incoming?.id === handled ? null : incoming;

  // The door changed under us: start the exit, or show the new knocker.
  if (!leaving && knocker?.id !== shown?.id) {
    if (shown) setLeaving(true);
    else setShown(knocker);
  }

  if (!shown) return null;

  function act(fn) {
    fn(shown.id);
    setHandled(shown.id);
    setLeaving(true); // animate out now rather than waiting for the server
  }

  function handleAnimationEnd() {
    if (!leaving) return;
    setLeaving(false);
    setShown(knocker);
  }

  return (
    <div
      key={shown.id}
      className={`cs-join-req${leaving ? ' leaving' : ''}`}
      aria-live="polite"
      onAnimationEnd={handleAnimationEnd}
    >
      <Avatar name={shown.name} src={shown.avatar} size={30} className="cs-jr-avatar" />
      <span>
        <strong>{shown.name}</strong> wants to join the meeting
        {extra > 0 && ` (+${extra})`}
      </span>
      <button
        className="cs-jr-btn cs-jr-deny"
        aria-label={`Deny ${shown.name}`}
        disabled={leaving}
        onClick={() => act(onDeny)}
      >
        <X />
      </button>
      <button
        className="cs-jr-btn cs-jr-admit"
        aria-label={`Admit ${shown.name}`}
        disabled={leaving}
        onClick={() => act(onAdmit)}
      >
        <Check />
      </button>
    </div>
  );
}

// The camera column beside a screen share (design: "share"). It scrolls
// when there are more people than fit; the chevron under it pages down one
// tile at a time and only shows while there's more below.
function SideStrip({ tiles, sinkId }) {
  const listRef = useRef(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const check = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, [tiles.length]);

  function pageDown() {
    const el = listRef.current;
    const tile = el?.firstElementChild;
    if (!tile) return;
    const step = tile.getBoundingClientRect().height + parseFloat(getComputedStyle(el).rowGap || 0);
    el.scrollBy({ top: step, behavior: 'smooth' });
  }

  return (
    <div className="cs-side">
      <div className="cs-side-list" ref={listRef}>
        {tiles.map((t) => (
          <div key={t.key} className={`cs-side-tile${t.speaking ? ' speaking' : ''}`}>
            <VideoTile
              sinkId={sinkId}
              stream={t.stream}
              label={t.label}
              muted={t.muted}
              mirror={t.mirror}
              micOff={t.micOff}
            />
          </div>
        ))}
      </div>
      <button
        className={`cs-side-more${more ? '' : ' hidden'}`}
        onClick={pageDown}
        aria-label="Show more people"
        title="Show more people"
        tabIndex={more ? 0 : -1}
      >
        <ChevronDown />
      </button>
    </div>
  );
}
