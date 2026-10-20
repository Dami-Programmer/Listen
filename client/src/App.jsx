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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EVENTS, MODES, RECONNECT_GRACE_MS, REJOIN_WINDOW_MS, ROLES } from '@listen/shared';
import { IS_DEMO, socket } from './socket.js';
import { strongNoiseSupported, useCall } from './webrtc.js';
import VideoTile from './VideoTile.jsx';
import ChatPanel from './ChatPanel.jsx';
import PreJoin from './PreJoin.jsx';
import Avatar from './Avatar.jsx';
import Toasts from './Toasts.jsx';
import { ConfirmHost } from './ConfirmDialog.jsx';
import { confirmDialog } from './confirm.js';
import InviteCard from './InviteCard.jsx';
import DevicePicker from './DevicePicker.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { PipView } from './Pip.jsx';
import { usePip } from './usePip.js';
import { newMeetingCode } from './meeting.js';
import { hostKeyFor, readRoomFromUrl } from './roomNames.js';
import MobileCall from './MobileCall.jsx';
import useIsMobile from './useIsMobile.js';
import { playKnock } from './knockSound.js';
import ReconnectBanner from './ReconnectBanner.jsx';
import LeftScreen from './LeftScreen.jsx';
import AloneReminder from './AloneReminder.jsx';
import Tour from './Tour.jsx';
import { hasSeenTour, useTour } from './useTour.js';
import TourButton from './TourButton.jsx';
import { trackEvent } from './analytics.js';
import NoiseToggle, { NoiseBadge } from './NoiseToggle.jsx';
import JoinRequestPill from './JoinRequestPill.jsx';
import { useHoverGrow } from './useHoverGrow.js';
import { BreakoutBanner, BreakoutPanel } from './Breakouts.jsx';
import TabSwap from './TabSwap.jsx';
import RecBadge from './RecBadge.jsx';
import { canTranscribe, useCaptionLines, useTranscriber } from './captions.js';
import { CaptionsBar, CcIcon } from './CaptionsBar.jsx';
import NextUp from './NextUp.jsx';
import { ReactionButton, ReactionsLayer } from './Reactions.jsx';
import QuestionsPanel from './QuestionsPanel.jsx';
import PollPanel from './PollPanel.jsx';
import { ReportDialog } from './MeetingReport.jsx';
import { fetchReport } from './report.js';
import { canRecord, isPhoneOrTablet, useRecorder } from './recorder.js';

// How long the "You left the meeting" screen offers Rejoin — the same minute
// the server keeps the rejoin pass for.
const REJOIN_SECONDS = Math.round(REJOIN_WINDOW_MS / 1000);

// Joining: after this long with no answer, explain the wait ("Waking up the
// server…"); after this long, give up and let them try again. A sleeping
// Render free-plan server takes ~30–60 s to wake.
const SLOW_JOIN_MS = 4000;
const JOIN_TIMEOUT_MS = 90_000;

// Alone in a meeting this long → "Are you still there?"; no answer within the
// countdown → you leave the call (AloneReminder.jsx).
const ALONE_REMINDER_MS = 5 * 60 * 1000;
const ALONE_COUNTDOWN_S = 120;
import {
  ArrowDown,
  ArrowUp,
  BarChart,
  Cam,
  CamOff,
  ChatBubble,
  ChevronDown,
  ChevronRight,
  GridView,
  Hand,
  LinkIcon,
  Lock,
  Maximize,
  Mic,
  MicOff,
  Minimize,
  Phone,
  RecordIcon,
  Screen,
  SpotlightView,
  Star,
  StopRecordIcon,
  Unlock,
  UserX,
  X,
} from './icons.jsx';
import PersonMenu from './PersonMenu.jsx';

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

// The room lives in the URL (?room=…, or /name for a fixed room — see
// roomNames.js). No accounts.

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
  // true while we're in the locked room's waiting area, before a moderator lets
  // us in.
  const [waiting, setWaiting] = useState(false);
  // ...and the room is a fixed one whose host isn't there yet.
  const [waitingForHost, setWaitingForHost] = useState(false);
  // Safety timers so a typer disappears even if their "stopped" ping is lost.
  const typerTimersRef = useRef({});
  // Set when the host kicks us OR turns us away at the door — shown on the join
  // screen so it doesn't just look like a dropped connection.
  const [removedNote, setRemovedNote] = useState(null);
  // Devices + mic/cam on/off picked in the pre-join lobby, used by the call.
  const [mediaPrefs, setMediaPrefs] = useState(null);
  // STUN + TURN servers for the call, sent by the server in the join ack.
  const [iceServers, setIceServers] = useState(null);

  // --- reconnecting after a network drop (Google-Meet style) --------------
  // true while our connection to the server is down but we're still on the
  // call screen, waiting for it to come back (see EVENTS.RESUME).
  const [reconnecting, setReconnecting] = useState(false);
  // The secret ticket the server gave us when we got in. Showing it on the
  // new connection gets our seat (role, hand, chat) back. Kept in memory
  // only: a page refresh is a fresh start, like Google Meet.
  const ticketRef = useRef(null);
  // The socket listeners below are registered once, so they read these
  // through refs rather than (stale) state.
  const reconnectingRef = useRef(false);
  // Gives up if the server can't be reached at all for too long.
  const giveUpTimerRef = useRef(null);

  // --- "You left the meeting — Rejoin" (Google-Meet style) ----------------
  // true on the screen shown right after pressing Leave; `rejoining` while
  // the Rejoin request is on its way.
  const [left, setLeft] = useState(false);
  const [rejoining, setRejoining] = useState(false);
  // The meeting we just left (its name, or code), for the review form.
  const [leftMeeting, setLeftMeeting] = useState('');
  // Its latest recording, if it was recorded — the screen links to it.
  const [leftRecording, setLeftRecording] = useState(null);
  // The meeting report, if we were the host / co-host (see CallView's leave).
  const [leftReport, setLeftReport] = useState(null);

  // --- the Join button while the server answers ---------------------------
  // true from the Join click until the server answers ("Joining…"), and
  // `slowJoin` once that has taken more than a few seconds ("Waking up the
  // server…"). The ref holds the in-flight attempt's timers — and blocks a
  // second click from sending a second join request.
  const [joining, setJoining] = useState(false);
  const [slowJoin, setSlowJoin] = useState(false);
  const joinAttemptRef = useRef(null);
  // true when this call was entered with Rejoin — so the "Your meeting is
  // ready" invite card (for whoever just STARTED a meeting) doesn't pop up.
  const [rejoined, setRejoined] = useState(false);

  // Drop every "is typing" indicator and its safety timer.
  const clearTypers = () => {
    Object.values(typerTimersRef.current).forEach(clearTimeout);
    typerTimersRef.current = {};
    setTypers({});
  };

  // Stop trying to get back in: back to the lobby with a note. Unlike Leave,
  // this KEEPS the name, picture and meeting code, so "Join" right there is
  // all it takes to rejoin.
  function dropToLobby(note) {
    clearTimeout(giveUpTimerRef.current);
    reconnectingRef.current = false;
    ticketRef.current = null;
    socket.disconnect(); // also stops Socket.IO's automatic retrying
    setReconnecting(false);
    setJoined(false);
    setWaiting(false);
    setState(null);
    setSelfId(null);
    setChat([]);
    clearTypers();
    setRemovedNote(note);
  }
  // The socket listeners are registered once, so they call the latest
  // dropToLobby through a ref.
  const dropToLobbyRef = useRef(dropToLobby);
  dropToLobbyRef.current = dropToLobby;

  // Wire socket listeners once. These are the Phase 1 room-state events; the
  // Phase 2 RTC_SIGNAL listener is added/removed inside the useCall hook.
  useEffect(() => {
    const LOST_NOTE = 'You lost your connection and left the meeting. Join again to go back in.';

    function onConnect() {
      // We're back online after a drop: show our ticket to get our seat back.
      if (reconnectingRef.current && ticketRef.current) {
        socket.emit(EVENTS.RESUME, { ticket: ticketRef.current }, (ack) => {
          if (!ack?.ok) {
            // Too late (the seat was given up) or the server restarted.
            dropToLobbyRef.current(LOST_NOTE);
            return;
          }
          clearTimeout(giveUpTimerRef.current);
          reconnectingRef.current = false;
          ticketRef.current = ack.ticket ?? null;
          // A reconnect always gets a new socket id. Everything on screen
          // follows from these, and the call rebuilds its connections to
          // everyone under the new id (webrtc.js effects B + C).
          setSelfId(ack.selfId);
          setState(ack.state);
          setChat(ack.chat ?? []);
          if (ack.iceServers) setIceServers(ack.iceServers);
          setReconnecting(false);
        });
      }
    }
    function onDisconnect(reason) {
      clearTypers();
      // Socket.IO's reason tells us WHY the line dropped:
      //  'io client disconnect' — we closed it (Leave, closing the tab)
      //  'io server disconnect' — the server closed it (removed, denied)
      //  anything else          — a network problem. Socket.IO is already
      //                           retrying; stay on the call screen.
      const meant = reason === 'io client disconnect' || reason === 'io server disconnect';
      if (!meant && ticketRef.current) {
        reconnectingRef.current = true;
        setReconnecting(true);
        // The server holds our seat for RECONNECT_GRACE_MS after IT notices
        // the drop (up to ~20 s after we do). If we still can't reach it by
        // then, the seat is gone anyway — stop and say so.
        clearTimeout(giveUpTimerRef.current);
        giveUpTimerRef.current = setTimeout(
          () => dropToLobbyRef.current(LOST_NOTE),
          RECONNECT_GRACE_MS + 20_000,
        );
        return;
      }
      // Removed or denied: no way back in. (When WE closed it — Leave — the
      // ticket is kept: it's the one-minute rejoin pass; handleLeave decides.)
      if (reason === 'io server disconnect') ticketRef.current = null;
      setJoined(false);
      setWaiting(false);
      setState(null);
      setChat([]);
    }
    function onAdmitted({ selfId: id, state: snap, chat: history, ticket }) {
      ticketRef.current = ticket ?? null;
      setSelfId(id);
      setState(snap);
      setChat(history ?? []);
      setWaiting(false);
      setJoined(true);
    }
    // Breakout rooms: the server moved us into another room (EVENTS.MOVED).
    // Same call screen — just a new room's people, chat and ticket.
    function onMoved({ selfId: id, state: snap, chat: history, ticket }) {
      ticketRef.current = ticket ?? null;
      setSelfId(id);
      setState(snap);
      setChat(history ?? []);
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
    socket.on(EVENTS.MOVED, onMoved);
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
      socket.off(EVENTS.MOVED, onMoved);
      socket.off(EVENTS.DENIED, onDenied);
      socket.off(EVENTS.CHAT_MESSAGE, onChatMessage);
      socket.off(EVENTS.CHAT_EDITED, onChatEdited);
      socket.off(EVENTS.CHAT_UNSENT, onChatUnsent);
      socket.off(EVENTS.CHAT_TYPING, onChatTyping);
    };
  }, []);

  function handleJoin(e, prefs) {
    e.preventDefault();
    // Already on its way — a second click would send a second join request,
    // which the server turns down ("already in a room").
    if (joinAttemptRef.current) return;
    setError(null);
    setMediaPrefs(prefs ?? null);
    setRemovedNote(null);
    setRejoined(false);
    if (!name.trim()) return;
    // No code typed -> this is a brand-new meeting with its own code.
    const id = roomId.trim() || newMeetingCode();
    setRoomId(id);

    // Reflect the room in the URL so it's shareable.
    const url = new URL(window.location.href);
    url.searchParams.set('room', id);
    window.history.replaceState({}, '', url);

    // Show "Joining…" straight away, and say so if it's slow. On Render's free
    // plan the server falls asleep after ~15 idle minutes and takes up to a
    // minute to wake — without this, the button looks dead and people click
    // again. If there's still no answer after JOIN_TIMEOUT_MS, give up
    // cleanly so they can try again.
    const attempt = {
      slow: setTimeout(() => setSlowJoin(true), SLOW_JOIN_MS),
      fail: setTimeout(() => {
        endJoinAttempt();
        socket.disconnect(); // drop the half-made connection; a retry starts fresh
        // Socket.IO keeps unsent messages and sends them on the next connect —
        // throw this join away, or the retry would arrive as a second join.
        socket.sendBuffer = [];
        setError('Couldn’t reach the server. Check your internet and try again.');
      }, JOIN_TIMEOUT_MS),
    };
    joinAttemptRef.current = attempt;
    setJoining(true);

    if (!socket.connected) socket.connect();
    socket.emit(
      EVENTS.JOIN_ROOM,
      {
        roomId: id,
        name: name.trim(),
        avatar,
        title: title.trim(),
        // A fixed room this device owns: its host key (roomNames.js).
        hostKey: hostKeyFor(id) ?? undefined,
      },
      (ack) => {
        // An answer to an attempt we already gave up on — ignore it.
        if (joinAttemptRef.current !== attempt) return;
        endJoinAttempt();
        if (ack?.ok) setIceServers(ack.iceServers ?? null);
        if (ack?.ok && ack.waiting) {
          // Locked room — sit in the lobby until a moderator admits us.
          // (`forHost`: a fixed room whose host hasn't arrived yet.)
          setSelfId(ack.selfId);
          setWaitingForHost(Boolean(ack.forHost));
          setWaiting(true);
          trackEvent('knocked'); // (analytics.js — no names, no room)
        } else if (ack?.ok) {
          trackEvent('joined meeting', { as: ack.state?.hostId === ack.selfId ? 'host' : 'guest' });
          ticketRef.current = ack.ticket ?? null; // our way back in after a drop
          setSelfId(ack.selfId);
          setState(ack.state);
          setChat(ack.chat ?? []);
          setJoined(true);
        } else {
          setError(ack?.error ?? 'join failed');
        }
      },
    );
  }

  // The join request got an answer (or timed out): stop the timers and put
  // the Join button back to normal.
  function endJoinAttempt() {
    const attempt = joinAttemptRef.current;
    if (attempt) {
      clearTimeout(attempt.slow);
      clearTimeout(attempt.fail);
    }
    joinAttemptRef.current = null;
    setJoining(false);
    setSlowJoin(false);
  }

  // Closing or refreshing the tab is leaving on purpose, like Google Meet:
  // close the connection ourselves so the server takes us out right away
  // (a connection that just vanishes would look like a network drop, and
  // everyone would see us "Reconnecting…" for a minute).
  useEffect(() => {
    const onPageHide = () => {
      if (socket.connected) socket.disconnect();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // Leave the call on purpose (the red button, "Leave" on the reconnect
  // banner, the floating window). Like Google Meet, you land on "You left the
  // meeting" with a Rejoin button for a minute — the server keeps a rejoin
  // pass for our ticket (see EVENTS.RESUME). `devices` is the mic / camera
  // on-off at the moment we left, so Rejoin brings them back the same way.
  // (Cancelling a knock in the waiting room has no ticket: straight home.)
  function handleLeave(devices) {
    clearTimeout(giveUpTimerRef.current);
    reconnectingRef.current = false;
    setReconnecting(false);
    const canRejoin = joined && Boolean(ticketRef.current);
    // Disconnecting the socket also unmounts <CallView/>, whose useCall cleanup
    // stops the camera and closes every peer connection.
    socket.disconnect();
    setJoined(false);
    setWaiting(false);
    setState(null);
    setSelfId(null);
    setChat([]);
    clearTypers();
    if (!canRejoin) {
      goHome();
      return;
    }
    // Remember mic / camera as they were (ignore a click event passed by a
    // plain onClick={onLeave}).
    if (typeof devices?.micOn === 'boolean') {
      setMediaPrefs((p) => ({ ...p, micOn: devices.micOn, camOn: devices.camOn }));
    }
    // Which meeting this was — shown with their review, if they write one.
    setLeftMeeting(state?.title || state?.roomId || roomId);
    // Recorded? The chat's "… started recording" notes carry the id.
    setLeftReport(devices?.report ?? null);
    setLeftRecording(
      state?.recording?.id ??
        chat.filter((m) => m.kind === 'note' && m.recording).at(-1)?.recording ??
        null,
    );
    setLeft(true);
  }

  // "Rejoin" on the You-left screen: show our ticket and go straight back in
  // with our old role. If the minute is up (or the server restarted), fall
  // back to the lobby with the name and meeting code still filled in.
  function handleRejoin() {
    const ticket = ticketRef.current;
    if (!ticket) {
      goHome();
      return;
    }
    setRejoining(true);
    if (!socket.connected) socket.connect();
    socket.emit(EVENTS.RESUME, { ticket }, (ack) => {
      setRejoining(false);
      setLeft(false);
      if (!ack?.ok) {
        dropToLobby(
          ack?.error === 'host-gone'
            ? // a group's permanent room closed: only its owner can reopen it
              'The meeting has ended. Join again to wait for the host.'
            : 'It’s been too long to rejoin automatically. Join again to go back in.',
        );
        return;
      }
      ticketRef.current = ack.ticket ?? null;
      setSelfId(ack.selfId);
      setState(ack.state);
      setChat(ack.chat ?? []);
      if (ack.iceServers) setIceServers(ack.iceServers);
      setRejoined(true);
      setJoined(true);
    });
  }

  // All the way out: the rejoin minute is over, or "Return to home screen".
  function goHome() {
    ticketRef.current = null;
    setLeft(false);
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
    // back to the app's home screen (not the landing page at /), dropping a
    // fixed room's short /name form too
    url.pathname = '/start';
    window.history.replaceState({}, '', url);
  }

  if (waiting) {
    return (
      <WaitingScreen
        roomId={roomId}
        forHost={waitingForHost}
        name={name}
        avatar={avatar}
        onCancel={handleLeave}
      />
    );
  }

  if (left) {
    return (
      <LeftScreen
        seconds={REJOIN_SECONDS}
        busy={rejoining}
        onRejoin={handleRejoin}
        onHome={goHome}
        name={name.trim()}
        meeting={leftMeeting}
        recordingId={leftRecording}
        report={leftReport}
      />
    );
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
        joining={joining}
        slowJoin={slowJoin}
      />
    );
  }

  return (
    <>
      <CallView
        state={state}
        chat={chat}
        typers={typers}
        selfId={selfId}
        onLeave={handleLeave}
        media={mediaPrefs}
        iceServers={iceServers}
        rejoined={rejoined}
      />
      {/* Our connection dropped: stay on the call, say so, offer Leave. */}
      {reconnecting && <ReconnectBanner onLeave={handleLeave} />}
    </>
  );
}

// --- the locked-room lobby -----------------------------------------------
// `forHost`: a fixed room whose host hasn't arrived — "Waiting for the host
// to start". (When they arrive, it's the usual knock: they let you in.)
// One layout for desktop and phone (index.css, "Waiting to be let in"): the
// Turnly mark top-left, then centred: your picture with soft rings going out
// from it (you're knocking), the title, a line saying what happens next, the
// meeting's code, three hopping dots, and Cancel.
function WaitingScreen({ roomId, forHost = false, name = '', avatar, onCancel }) {
  return (
    <main className="wait-screen" aria-live="polite">
      <header className="wait-brand">
        <img src="/turnly-mark-96.png" alt="" />
        <span>Turnly</span>
      </header>
      <div className="wait-center">
        <div className="wait-knock" aria-hidden="true">
          <i />
          <i />
          <i />
          <Avatar name={name.trim() || '?'} src={avatar} size={96} />
        </div>
        <h1>{forHost ? 'Almost there' : 'Knock knock'}</h1>
        <p className="wait-sub">
          {forHost
            ? 'The host hasn’t started this meeting yet. You’ll join as soon as they arrive.'
            : 'The host knows you’re here. You’ll be let in as soon as they say yes.'}
        </p>
        <div className="wait-meeting">
          <span className="wait-meeting-ic">
            <Cam />
          </span>
          <span>
            Meeting <code>{roomId}</code>
          </span>
        </div>
        <div className="wait-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="wait-hint">Keep this page open.</p>
        <button type="button" className="wait-cancel" onClick={onCancel}>
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
// (Exported for the landing page's live demo too — demo/DemoApp.jsx.)
export function CallView({ state, chat, typers, selfId, onLeave, media, iceServers, rejoined }) {
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
  // The side panel's tab: chat, questions or the poll.
  const [panelTab, setPanelTab] = useState('chat');
  // The meeting report pop-up (moderators).
  const [reportOpen, setReportOpen] = useState(false);
  const closeReport = useCallback(() => setReportOpen(false), []);
  // The breakout rooms pop-up (moderators).
  const [breakoutOpen, setBreakoutOpen] = useState(false);
  const closeBreakout = useCallback(() => setBreakoutOpen(false), []);
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
      // (not the header's "N participants" button — it toggles this itself)
      if (e.target.closest?.('.cs-people-pill')) return;
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
      // (nor the header's "N participants" button, which opens the panel)
      if (t.closest?.('.toasts, .img-viewer, .confirm-backdrop, .cs-people-pill')) return;
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
  // whose chat a moderator muted (CHAT_MUTE) — mine greys out my message box
  const chatMuted = state?.chatMuted ?? [];

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
    strongNoise,
    setStrongNoise,
    startShare,
    presentStream,
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
    // The server has Cloudflare's SFU set up: media goes through it (sfu.js).
    sfu: state?.sfu === true,
    sfuMedia: state?.media,
    // I'm the one recording: receive everyone at a decent size (sfu.js).
    recording: Boolean(state?.recording?.id) && state.recording.recorderId === selfId,
  });
  // Strong noise reduction is cleaning my mic (on by default — webrtc.js):
  // shows as a sparkle badge on the mic button.
  const noiseOn = strongNoiseSupported && strongNoise;
  // the control pill: its buttons grow as the mouse passes (useHoverGrow.js —
  // a ref that hooks itself up whenever the pill appears)
  const pillRef = useHoverGrow();

  // Leave the call, telling <App/> how the mic and camera were — so if you
  // hit Rejoin on the "You left the meeting" screen, they come back the same.
  // A host / co-host also takes the meeting report along (shown on the "You
  // left" screen — once they're gone they can't ask for it any more). At
  // most a moment's wait; without an answer they just leave.
  const leave = async () => {
    const report = isModerator ? await fetchReport(1500) : null;
    onLeave({ micOn, camOn, report });
  };

  // The floating mini-call shown while you're on another tab (Pip.jsx).
  const { pipWin } = usePip();

  const isHost = self?.role === ROLES.HOST;
  // A moderator is the host OR the appointed co-host — same control surface.
  const isModerator = isHost || self?.role === ROLES.COHOST;
  // Whoever starts a meeting (first in, so host, and alone) gets the invite
  // link straight away; anyone can reopen it from the Invite button.
  // (Not when coming back with Rejoin — the meeting isn't new to them.)
  // On their very first call, though, the step-by-step tour goes first and
  // the invite pops up when it's done (see the tour below).
  const startsMeeting = !rejoined && isHost && participants.length === 1;
  const inviteAfterTourRef = useRef(startsMeeting && !isMobile && !hasSeenTour('desktop'));
  const [inviteOpen, setInviteOpen] = useState(() => startsMeeting && !inviteAfterTourRef.current);
  const cohostId = state?.cohostId ?? null;
  const moderated = state?.mode === MODES.MODERATED;

  // Waiting room — people knocking to get in (moderator-only UI).
  const locked = state?.locked ?? false;
  const waiting = state?.waiting ?? [];

  // Ding-dong for each new person who knocks — only for whoever can let them
  // in (host / co-host), on phones and desktops alike.
  const heardKnocks = useRef(null);
  const waitingKey = waiting.map((w) => w.id).join(','); // changes only when the door list does
  useEffect(() => {
    const ids = waitingKey ? waitingKey.split(',') : [];
    if (heardKnocks.current === null) {
      heardKnocks.current = new Set(ids); // already waiting when the call opened
      return;
    }
    const fresh = ids.filter((id) => !heardKnocks.current.has(id));
    heardKnocks.current = new Set(ids);
    if (isModerator && fresh.length) playKnock();
  }, [waitingKey, isModerator]);

  // Phase 5 — the speaker queue, straight from the snapshot (socketIds, oldest
  // first). The server owns it; we only render it.
  const queue = state?.queue ?? [];
  // Open questions, most votes first (QuestionsPanel).
  const questions = state?.questions ?? [];
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
  // People whose connection dropped and who are reconnecting.
  const awayIds = state?.away ?? [];

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
      // A listener's own client silences its mic, but audio goes browser to
      // browser, so a tampered client could keep talking. Enforce it on OUR
      // side too: we never play a listener's audio. (This one flag covers the
      // desktop and the mobile layouts — MobileCall reuses these tiles.)
      muted: peerOf(id)?.role === ROLES.LISTENER,
      // Everyone else's mic: what they last reported via the server.
      micOff: !micOf(id),
      // Their connection dropped and the server is holding their seat while
      // they reconnect — the tile says "Reconnecting…".
      away: awayIds.includes(id),
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

  // --- recording the meeting (recorder.js, EVENTS.REC_*) ------------------
  // `recording` is on for everyone while the meeting is being recorded; one
  // browser — `recorderId`, picked by the server — does the recording.
  const recording = state?.recording?.id ? state.recording : null;
  const iRecord = Boolean(recording) && recording.recorderId === selfId;

  // --- live captions (captions.js, EVENTS.CAPTION*) ------------------------
  // `captionsWanted`: I switched captions on (the CC button) — tell the
  // server, which keeps it across reconnects. `captionsOn`: someone in the
  // room has them on — then, if I may speak and my mic is on, my browser
  // turns my speech into text for everyone (desktop only — see captions.js).
  const [captionsWanted, setCaptionsWanted] = useState(false);
  const captionsOn = state?.captionsOn === true;
  useEffect(() => {
    if (selfId) socket.emit(EVENTS.CAPTIONS_WANT, { on: captionsWanted });
  }, [selfId, captionsWanted]);
  const captionLines = useCaptionLines(captionsWanted);
  // (Never in the landing page's demo: speech recognition would listen to
  // the visitor's REAL microphone, which the demo must never touch.)
  useTranscriber(captionsOn && micOn && !isListener && canTranscribe && !isMobile && !IS_DEMO);

  // Tell the server if this is a laptop (a better recorder than a phone),
  // and whether this browser can record at all.
  useEffect(() => {
    if (selfId) socket.emit(EVENTS.DEVICE, { desktop: !isPhoneOrTablet(), canRecord: canRecord() });
  }, [selfId]);

  // What the recording shows: everyone's camera (or their initials), or the
  // screen share. Only people allowed to talk are heard — never a listener.
  useRecorder({
    id: recording?.id,
    part: recording?.part,
    active: iRecord,
    scene: {
      tiles: cameraTiles.map((t) => ({
        key: t.key,
        stream: t.stream,
        name: t.key === 'me' ? (self?.name ?? 'You') : (peerOf(t.key)?.name ?? 'Guest'),
        camOff: t.key === 'me' ? !camOn : !camOf(t.key),
        speaking: t.speaking,
        // My own tile is muted on MY screen (no echo), but my voice belongs
        // in the recording unless I'm a listener.
        audible: t.key === 'me' ? !isListener : !t.muted,
      })),
      screen: screenTiles[0] ? { key: screenTiles[0].key, stream: screenTiles[0].stream } : null,
    },
  });

  // Host / co-host: start or stop it (confirming first).
  async function startRecording() {
    const ok = await confirmDialog({
      title: 'Record this meeting?',
      message:
        'Everyone will see that it’s being recorded and can watch it afterwards. It’s deleted a day after the meeting ends.',
      confirmLabel: 'Start recording',
    });
    if (ok) emit(EVENTS.REC_START);
  }
  async function stopRecording() {
    const ok = await confirmDialog({
      title: 'Stop recording?',
      message: 'What’s been recorded so far stays available to everyone in the call.',
      confirmLabel: 'Stop recording',
      danger: true,
    });
    if (ok) emit(EVENTS.REC_STOP);
  }

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
  // Same confirm, for presenting photos / a PDF (phones). Returns whether it
  // went live; on "no" the caller drops its prepared stream.
  async function handlePresent(stream) {
    if (otherPresenterId) {
      const presenter = peerOf(otherPresenterId);
      const ok = await confirmDialog({
        title: `${presenter?.name ?? 'Someone'} is presenting`,
        message: 'Stop their share and present instead?',
        confirmLabel: 'Present instead',
        person: presenter,
      });
      if (!ok) return false;
    }
    return presentStream(stream);
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
  // Mute / unmute someone's chat (they can still read it). Easy to undo, so
  // no confirmation.
  const setChatMute = (targetId, muted) => emit(EVENTS.CHAT_MUTE, { targetId, muted });
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
      title: `Remove ${p.name} as cohost?`,
      message: 'They stay in the call.',
      confirmLabel: 'Remove cohost',
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

  // --- "Are you still there?" when you're alone --------------------------
  // Nobody else in the call (and nobody knocking at the door) for
  // ALONE_REMINDER_MS → ask. Someone arriving cancels it; "Stay" starts the
  // wait over (stayCount bumps the timer); no answer → <AloneReminder> leaves.
  const alone = participants.length === 1 && waiting.length === 0;
  const [askAlone, setAskAlone] = useState(false);
  const [stayCount, setStayCount] = useState(0);
  useEffect(() => {
    if (!alone) {
      setAskAlone(false);
      return undefined;
    }
    const t = setTimeout(() => setAskAlone(true), ALONE_REMINDER_MS);
    return () => clearTimeout(t);
  }, [alone, stayCount]);
  const aloneReminder = askAlone && (
    <AloneReminder
      seconds={ALONE_COUNTDOWN_S}
      onStay={() => {
        setAskAlone(false);
        setStayCount((n) => n + 1);
      }}
      onLeave={leave}
    />
  );

  // --- the step-by-step tour, desktop / tablet (Tour.jsx) -----------------
  // Phones have their own tour (MobileCall.jsx). Plays by itself the moment
  // someone is in their first call on this device (before the invite card,
  // which follows it); after that, only the "?" next to the theme button
  // plays it. Only the steps that apply to this person.
  const tour = useTour('desktop', !isMobile, () => {
    // The invite pop-up that was held back for the tour (first call only).
    if (inviteAfterTourRef.current) {
      inviteAfterTourRef.current = false;
      setInviteOpen(true);
    }
  });
  const canShareScreen = !isListener && Boolean(navigator.mediaDevices?.getDisplayMedia);
  const tourSteps = [
    {
      target: '.cs-share-btn',
      title: 'Invite people',
      text: 'Gets this meeting’s link, ready to copy and send to others.',
    },
    {
      target: '.cs-people-pill',
      title: 'Everyone in the meeting',
      text: isModerator
        ? 'See who’s here and who has a hand up. Host tools live here too: breakout rooms, the meeting report (who spoke, and for how long), and a ⋯ menu on each person to make them cohost, mute their chat or remove them.'
        : 'See who’s in the meeting, and who’s host.',
    },
    isHost && {
      target: '.cs-mode-badge',
      title: 'Open or Moderated',
      text: 'Open: everyone can talk. Moderated: people listen until you or your cohost give them the floor.',
    },
    isModerator && {
      target: '.cs-door-btn',
      title: 'The door',
      text: 'Locked: you let each new person in. Open: anyone with the link walks straight in.',
    },
    {
      // both device buttons, in one spotlight
      target: '.cs-controls-center > .dp',
      title: 'Camera and mic',
      text: `Turn your camera on or off, and ${
        isListener ? 'your mic (it’s off while you’re listening)' : 'mute or unmute yourself'
      }. The little arrows pick another camera or microphone${
        strongNoiseSupported
          ? '. The mic’s arrow also has noise reduction, on by default: the small sparkle on the mic.'
          : '.'
      }`,
    },
    !isModerator && {
      target: '.cs-controls-center button[aria-label$="hand"]',
      title: 'Raise your hand',
      text: 'In a moderated meeting, ask to speak. The host sees you in the queue.',
    },
    {
      target: '.cs-react-btn',
      title: 'Reactions',
      text: 'Send a quick 👍 👏 ❤️ 🎉 that floats up on everyone’s screen, without unmuting.',
    },
    canShareScreen && {
      target:
        '.cs-controls-center button[aria-label$="screen"], .cs-controls-center button[aria-label="Stop sharing"]',
      title: 'Share your screen',
      text: 'Show everyone your screen, a window or a browser tab.',
    },
    isModerator && {
      target: '.cs-rec-btn',
      title: 'Record',
      text: 'Records the meeting. Everyone sees it’s being recorded and can watch it afterwards, for a day.',
    },
    {
      target: '.cs-controls-center button[aria-label^="Switch to"]',
      title: 'Change the view',
      text: 'Switch between one big video and a grid of everyone.',
    },
    {
      target: '.cs-controls-center button[aria-label$="captions"]',
      title: 'Live captions',
      text: 'Shows what people say as text at the bottom of the call. Everyone sees a “Captions on” sign while they’re running.',
    },
    {
      target: '.cs-hangup',
      title: 'Leave',
      text: 'Leaves the call. Changed your mind? You get a minute to rejoin.',
    },
    {
      target: '.cs-chat-btn',
      title: 'Chat, questions and polls',
      text: isModerator
        ? 'Opens the side panel. Chat: photos and files too, and people who join late still see what was said. Questions: anyone can ask, everyone upvotes. Poll: ask everyone something and see the results live.'
        : 'Opens the side panel. Chat: photos and files too, and people who join late still see what was said. Questions: ask, and upvote the ones you want answered. Poll: vote when the host starts one.',
    },
    {
      target: '.tour-replay',
      title: 'That’s it!',
      text: 'Click ? any time to see this tour again. The button next to it switches between light and dark.',
    },
  ].filter(Boolean);

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
            // live captions (see the captions section above)
            captionsWanted,
            setCaptionsWanted,
            captionLines,
            captionsOn,
            onLeave: leave,
            rejoined,
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
            strongNoise,
            setStrongNoise,
            startShare: handleStartShare,
            presentStream: handlePresent,
            stopShare,
            mediaError,
            layout,
            toggleLayout,
            micOf,
            camOf,
            cohostId,
            recording,
            startRecording,
            stopRecording,
            openBreakouts: () => setBreakoutOpen(true),
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
              setChatMute,
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
        {aloneReminder}
        <ReactionsLayer />
        {breakoutOpen && <BreakoutPanel state={state} onClose={closeBreakout} />}
      </>
    );
  }

  return (
    <main className="callscreen">
      {/* The top bar: the white Turnly mark with the meeting's name beside
            it, then any status chips (recording, captions, breakouts) — and
            on the right, soft rounded buttons: room mode (host), "N
            participants", Share link, light / dark, the tour, and you. */}
      <header className="cs-topbar">
        <div className="cs-title-row">
          <img className="cs-mark" src="/turnly-mark-96.png" alt="Turnly" />
          <h1>{state?.title || state?.roomId}</h1>
          {/* "● Recording 12:34" for everyone while it's being recorded */}
          {recording && <RecBadge recording={recording} />}
          {/* everyone sees when captions are on: speech is being turned
                into text (by the speakers' browsers — captions.js) */}
          {captionsOn && (
            <span className="cs-cc-badge" title="Live captions are on in this meeting">
              <CcIcon /> Captions on
            </span>
          )}
          {/* breakout rooms: where you are / that they're running */}
          <BreakoutBanner
            state={state}
            onManage={isModerator ? () => setBreakoutOpen(true) : undefined}
          />
        </div>

        <div className="cs-top-right">
          {isHost && (
            <ModeSwitch
              moderated={moderated}
              onToggle={() => changeMode(moderated ? MODES.OPEN : MODES.MODERATED)}
            />
          )}
          {/* "N participants ▾" with the first few faces: opens the chat
                panel's people list (and closes it again) */}
          <button
            type="button"
            className={`cs-top-btn cs-people-pill${peopleOpen ? ' on' : ''}`}
            onClick={() => {
              if (peopleOpen) people.hide();
              else {
                panel.show();
                people.show();
              }
            }}
            aria-expanded={peopleOpen}
            title="See everyone in the meeting"
          >
            <span className="cs-face-stack" aria-hidden="true">
              {participants.slice(0, 4).map((p) => (
                <Avatar key={p.id} name={p.name} src={p.avatar} size={24} />
              ))}
            </span>
            {participants.length}
            {/* (the word hides when the call area is narrow — index.css) */}
            <span className="cs-top-label"> participant{participants.length === 1 ? '' : 's'}</span>
            <ChevronDown className="cs-top-chev" aria-hidden="true" />
          </button>
          {/* the invite link pop-up (InviteCard) — what "Invite" used to be */}
          <button
            type="button"
            // cs-share-btn: the tour's "Invite people" step points here
            className={`cs-top-btn cs-share-btn${inviteOpen ? ' on' : ''}`}
            onClick={() => setInviteOpen((v) => !v)}
            aria-expanded={inviteOpen}
            title="Get the invite link"
          >
            <LinkIcon />
            <span className="cs-top-label">Share link</span>
          </button>
          {/* light / dark switch */}
          <ThemeToggle />
          {/* replays the step-by-step tour */}
          <TourButton onClick={tour.start} />
          {/* you */}
          <span className="cs-me" title={`You (${self?.name ?? 'you'})`}>
            <Avatar name={self?.name ?? ''} src={self?.avatar} size={36} />
          </span>
        </div>

        {/* someone knocking: the pill slides down from the top (JoinRequestPill.jsx) */}
        <JoinRequestPill
          knocker={knocker}
          extra={Math.max(0, waiting.length - 1)}
          onAdmit={admit}
          onDeny={deny}
        />
      </header>

      {/* Below the header: the call (video + controls) on the left, and the
          chat as a card on the right, under the header. */}
      <div className="cs-main-row">
        <div className="cs-stage-col">
          {mediaError && <p className="err">{mediaError}</p>}

          <div className={`cs-body${presenting ? ' presenting' : ''}`}>
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
                      away={t.away}
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
                      away={t.away}
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
                    away={spotlight.away}
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
                          away={t.away}
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
            {/* Moderated room: who's next in line for the floor. */}
            <NextUp
              queue={queue}
              participants={participants}
              selfId={selfId}
              moderated={moderated}
            />

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

          {/* Live captions, between the video and the controls (never over
            anyone's face). Only while I have them on. */}
          {captionsWanted && <CaptionsBar lines={captionLines} selfId={selfId} />}

          <footer className="cs-controls">
            {/* Door lock, bottom-left — the mirror of the chat button. Moderators
              only: locked = newcomers wait to be admitted. */}
            {isModerator && (
              <button
                className={`cs-door-btn${locked ? ' on' : ''}`}
                onClick={toggleLock}
                aria-label={locked ? 'Door locked. Click to open' : 'Door open. Click to lock'}
                title={
                  locked
                    ? 'Door locked: new people must be admitted'
                    : 'Door open: anyone with the link can join'
                }
              >
                {locked ? <Lock /> : <Unlock />}
              </button>
            )}
            {/* The glass pill in the middle (like the landing page's dock):
              camera, mic │ the meeting's actions │ Leave. Buttons grow a
              little as the mouse passes over them (useHoverGrow.js). */}
            <div className="cs-controls-center" ref={pillRef}>
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
              <DevicePicker
                kind="audio"
                current={devices.audio}
                onSwitch={switchDevice}
                extra={
                  strongNoiseSupported && <NoiseToggle on={strongNoise} onChange={setStrongNoise} />
                }
              >
                <button
                  // cs-mic-btn: holds the noise badge in its corner (index.css)
                  className="cs-mic-btn"
                  onClick={toggleMic}
                  disabled={isListener}
                  aria-label={`${micOn ? 'Mute' : 'Unmute'}${noiseOn ? ' · Noise reduction on' : ''}`}
                  title={`${
                    isListener ? 'Raise your hand to ask for the floor' : micOn ? 'Mute' : 'Unmute'
                  }${noiseOn ? ' · Noise reduction on' : ''}`}
                >
                  {micOn && !isListener ? <Mic /> : <MicOff />}
                  {/* the "noise reduction is on" sparkle (NoiseToggle.jsx) */}
                  {noiseOn && <NoiseBadge />}
                </button>
              </DevicePicker>
              {/* a thin line between "your camera and mic" and the meeting's
                actions */}
              <span className="cs-sep" aria-hidden="true" />
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
              {/* 👍 👏 🙏 … for everyone, without unmuting */}
              <ReactionButton className="cs-react-btn" />
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
              {/* Host / co-host: record the meeting (red while recording). */}
              {isModerator && (
                <button
                  className={`cs-rec-btn${recording ? ' on' : ''}`}
                  onClick={recording ? stopRecording : startRecording}
                  aria-label={recording ? 'Stop recording' : 'Record the meeting'}
                  title={recording ? 'Stop recording' : 'Record the meeting'}
                >
                  {recording ? <StopRecordIcon /> : <RecordIcon />}
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
              {/* live captions on / off, for me */}
              <button
                className={captionsWanted ? 'on' : ''}
                onClick={() => setCaptionsWanted((v) => !v)}
                aria-pressed={captionsWanted}
                aria-label={captionsWanted ? 'Hide captions' : 'Show captions'}
                title={captionsWanted ? 'Hide captions' : 'Show captions'}
              >
                <CcIcon />
              </button>
              {/* Leave: the pill's one big round button, at its end (red) */}
              <button
                className="cs-hangup"
                onClick={leave}
                aria-label="Leave call"
                title="Leave call"
              >
                <Phone />
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
            <InviteCard
              roomId={state.roomId}
              locked={locked}
              onClose={() => setInviteOpen(false)}
            />
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
                onLeave: leave,
              }}
              events={{ chat, queue, waiting, participants, selfId, isModerator, admit, deny }}
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
          {aloneReminder}
          {tour.running && <Tour steps={tourSteps} onClose={tour.stop} />}
        </div>

        {/* Right column: the chat panel. Top to bottom: ✕ and a centred
          "Chat"; the people list's pop-up (opened from the header's "N
          participants" button); the messages and composer (ChatPanel). */}
        {panel.open && (
          <aside
            ref={panelRef}
            // `.closing` swaps the slide-in for the slide-out; when that ends,
            // onExitEnd removes the panel for real.
            className={`cs-panel${panel.closing ? ' closing' : ''}`}
            onAnimationEnd={panel.onExitEnd}
          >
            {/* ✕ on the left, "Chat" centred */}
            <div className="cp-head">
              <button
                className="cp-close"
                onClick={panel.hide}
                aria-label="Close chat"
                title="Close chat"
              >
                <X />
              </button>
              <h2 className="cp-title">Chat</h2>
            </div>

            {/* Holds the people list's pop-up (participants + moderation, door
              lock, pass-the-mic, raised hands) just under the title. It's
              opened from the header's "N participants" button. */}
            <div className="cp-people-row" ref={peopleRef}>
              {people.open && (
                <div
                  className={`cp-people-pop${people.closing ? ' closing' : ''}`}
                  onAnimationEnd={people.onExitEnd}
                >
                  {isListener && (
                    <p className="pp-note">
                      🎧 Listening only &mdash;{' '}
                      {handRaised
                        ? `you're #${myQueuePos + 1} in line for the floor.`
                        : 'raise your hand to ask for the floor.'}
                    </p>
                  )}

                  {/* Host tools: quiet rows — icon tile, name, one grey line, › */}
                  {isModerator && (
                    <section className="pp-sec">
                      <h3 className="pp-sec-title">Host tools</h3>
                      {!state?.breakout && (
                        <button
                          type="button"
                          className="pp-tool"
                          onClick={() => {
                            people.hide();
                            setBreakoutOpen(true);
                          }}
                        >
                          <span className="pp-tile">
                            <GridView />
                          </span>
                          <span className="pp-tool-text">
                            <b>Breakout rooms</b>
                            <small>Split into small groups</small>
                          </span>
                          <ChevronRight className="pp-chev" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="pp-tool"
                        onClick={() => {
                          people.hide();
                          setReportOpen(true);
                        }}
                      >
                        <span className="pp-tile">
                          <BarChart />
                        </span>
                        <span className="pp-tool-text">
                          <b>Meeting report</b>
                          <small>Who spoke, and for how long</small>
                        </span>
                        <ChevronRight className="pp-chev" />
                      </button>
                    </section>
                  )}

                  {/* Raised hands (moderated rooms): Grant, and a ⋯ menu to
                      reorder the line or dismiss someone's hand */}
                  {isModerator && moderated && (
                    <section className="pp-sec">
                      <h3 className="pp-sec-title">
                        Raised hands <b>{queued.length}</b>
                        {grantedSpeakers.length > 0 && (
                          <button type="button" className="pp-link" onClick={clearFloor}>
                            Clear floor
                          </button>
                        )}
                      </h3>
                      {queued.length === 0 ? (
                        <p className="pp-empty">
                          No one&apos;s waiting. Listeners can raise a hand.
                        </p>
                      ) : (
                        queued.map((p, i) => (
                          <div className="pp-person" key={p.id}>
                            <Avatar name={p.name} src={p.avatar} size={32} />
                            <span className="pp-who">
                              <b>{p.name}</b>
                              <small>{i === 0 ? 'Next in line' : `#${i + 1} in line`}</small>
                            </span>
                            <button
                              type="button"
                              className="pp-btn solid"
                              onClick={() => grantFloor(p.id)}
                            >
                              Grant
                            </button>
                            <PersonMenu
                              label={`More for ${p.name}`}
                              items={[
                                i > 0 && {
                                  label: 'Move up',
                                  icon: <ArrowUp />,
                                  onClick: () => moveInQueue(p.id, -1),
                                },
                                i < queued.length - 1 && {
                                  label: 'Move down',
                                  icon: <ArrowDown />,
                                  onClick: () => moveInQueue(p.id, +1),
                                },
                                null,
                                {
                                  label: 'Dismiss hand',
                                  icon: <X />,
                                  onClick: () => dismissHand(p.id),
                                },
                              ]}
                            />
                          </div>
                        ))
                      )}
                    </section>
                  )}

                  {/* Everyone: picture, name, a grey line for anything worth
                      knowing, a Host / Cohost chip. Grant / Revoke (moderated)
                      or Mute (open) stay on the row; the rest is in ⋯. */}
                  <section className="pp-sec">
                    <h3 className="pp-sec-title">
                      In the meeting <b>{participants.length}</b>
                    </h3>
                    {ordered.map((p) => {
                      const canMod = isModerator && p.id !== selfId && p.role !== ROLES.HOST;
                      const hostControls = isHost && p.id !== selfId && p.role !== ROLES.HOST;
                      const chatOff = chatMuted.includes(p.id);
                      const note = [
                        moderated && p.role === ROLES.SPEAKER && 'Has the floor',
                        moderated && p.role === ROLES.LISTENER && 'Listening',
                        chatOff && 'Chat muted',
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <div className="pp-person" key={p.id}>
                          <Avatar name={p.name} src={p.avatar} size={32} />
                          <span className="pp-who">
                            <b>
                              {p.name}
                              {p.id === selfId && <em> (you)</em>}
                            </b>
                            {note && <small>{note}</small>}
                          </span>
                          {(p.role === ROLES.HOST || p.role === ROLES.COHOST) && (
                            <span className={`pp-chip ${p.role}`}>
                              {p.role === ROLES.HOST ? 'Host' : 'Cohost'}
                            </span>
                          )}
                          {canMod && moderated && p.role === ROLES.LISTENER && (
                            <button
                              type="button"
                              className="pp-btn"
                              onClick={() => grantFloor(p.id)}
                            >
                              Grant
                            </button>
                          )}
                          {canMod && moderated && p.role === ROLES.SPEAKER && (
                            <button
                              type="button"
                              className="pp-btn"
                              onClick={() => revokeFloor(p.id)}
                            >
                              Revoke
                            </button>
                          )}
                          {/* Moderated rooms run the mic through Grant / Revoke
                            (listeners are silent anyway), so no Mute there. */}
                          {canMod && !moderated && (
                            <button
                              type="button"
                              className="pp-icon"
                              onClick={() => forceMute(p.id)}
                              aria-label={`Mute ${p.name}`}
                              title="Mute"
                            >
                              <Mic />
                            </button>
                          )}
                          {canMod && (
                            <PersonMenu
                              label={`More for ${p.name}`}
                              items={[
                                hostControls && {
                                  label: p.id === cohostId ? 'Remove cohost' : 'Make cohost',
                                  icon: <Star />,
                                  onClick: () =>
                                    p.id === cohostId ? dropCohost(p) : makeCohost(p),
                                },
                                // their chat: muted = they can read, not post
                                // (never the co-host — a moderator)
                                p.id !== cohostId && {
                                  label: chatOff ? 'Unmute chat' : 'Mute chat',
                                  icon: <ChatBubble />,
                                  onClick: () => setChatMute(p.id, !chatOff),
                                },
                                null,
                                {
                                  label: 'Remove from meeting',
                                  icon: <UserX />,
                                  onClick: () => removeParticipant(p),
                                  danger: true,
                                },
                              ]}
                            />
                          )}
                        </div>
                      );
                    })}
                  </section>
                </div>
              )}
            </div>

            {/* Chat, questions and polls share the panel. */}
            <div
              className="cp-tabs"
              role="tablist"
              // the sliding highlight (see .cp-tabs::before): 3 options, which is on
              style={{ '--n': 3, '--i': ['chat', 'qa', 'poll'].indexOf(panelTab) }}
            >
              {[
                ['chat', 'Chat', 0],
                ['qa', 'Questions', questions.length],
                ['poll', 'Poll', state?.poll?.open ? '•' : 0],
              ].map(([key, label, badge]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={panelTab === key}
                  className={`cp-tab${panelTab === key ? ' on' : ''}`}
                  onClick={() => setPanelTab(key)}
                >
                  {label}
                  {badge ? <b className="cp-tab-badge">{badge}</b> : null}
                </button>
              ))}
            </div>
            {/* slides in from the side you switched to (TabSwap) */}
            <TabSwap tab={panelTab} order={['chat', 'qa', 'poll']} className="cp-swap">
              {panelTab === 'chat' && (
                <ChatPanel
                  messages={chat}
                  typers={typers}
                  selfId={selfId}
                  participants={participants}
                  onOpenQuestions={() => setPanelTab('qa')}
                  canModerate={isModerator}
                  muted={chatMuted.includes(selfId)}
                />
              )}
              {panelTab === 'qa' && (
                <div className="cp-tabbody">
                  <QuestionsPanel
                    questions={questions}
                    participants={participants}
                    selfId={selfId}
                    isModerator={isModerator}
                    moderated={moderated}
                  />
                </div>
              )}
              {panelTab === 'poll' && (
                <div className="cp-tabbody">
                  <PollPanel poll={state?.poll ?? null} isModerator={isModerator} />
                </div>
              )}
            </TabSwap>
          </aside>
        )}
      </div>
      {reportOpen && <ReportDialog onClose={closeReport} />}
      {breakoutOpen && <BreakoutPanel state={state} onClose={closeBreakout} />}
      {/* 👍 👏 🙏 … floating up from the bottom-left */}
      <ReactionsLayer />
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
      aria-label={`Room is ${moderated ? 'moderated' : 'open'}. Click to switch`}
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

// Everyone's camera beside a screen share: a column on the right, scrolling
// up and down when there are more than fit. The ▲ and ▼ buttons move one
// tile at a time and each only shows while there's more that way. (On a
// narrow window the CSS turns the column into a row under the share — the
// same buttons then work sideways.)
function SideStrip({ tiles, sinkId }) {
  const listRef = useRef(null);
  const [canLeft, setCanLeft] = useState(false); // more above (or to the left)
  const [canRight, setCanRight] = useState(false); // more below (or to the right)

  // Is the list laid out sideways right now (narrow window)?
  const sideways = (el) => getComputedStyle(el).flexDirection === 'row';

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Anything scrolled out of view at either end?
    const check = () => {
      if (sideways(el)) {
        setCanLeft(el.scrollLeft > 2);
        setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
      } else {
        setCanLeft(el.scrollTop > 2);
        setCanRight(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
      }
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, [tiles.length]);

  // Move one tile back (-1) or on (+1).
  function page(dir) {
    const el = listRef.current;
    const tile = el?.firstElementChild;
    if (!tile) return;
    const box = tile.getBoundingClientRect();
    const gaps = getComputedStyle(el);
    if (sideways(el)) {
      el.scrollBy({
        left: dir * (box.width + parseFloat(gaps.columnGap || 0)),
        behavior: 'smooth',
      });
    } else {
      el.scrollBy({ top: dir * (box.height + parseFloat(gaps.rowGap || 0)), behavior: 'smooth' });
    }
  }

  return (
    <div className="cs-side">
      <button
        className={`cs-side-more cs-side-prev${canLeft ? '' : ' hidden'}`}
        onClick={() => page(-1)}
        aria-label="Previous people"
        title="Previous people"
        tabIndex={canLeft ? 0 : -1}
      >
        <ChevronDown />
      </button>
      <div className="cs-side-list" ref={listRef}>
        {tiles.map((t) => (
          <div key={t.key} className={`cs-side-tile${t.speaking ? ' speaking' : ''}`}>
            <VideoTile
              sinkId={sinkId}
              stream={t.stream}
              label={t.label}
              muted={t.muted}
              away={t.away}
              mirror={t.mirror}
              micOff={t.micOff}
            />
          </div>
        ))}
      </div>
      <button
        className={`cs-side-more cs-side-next${canRight ? '' : ' hidden'}`}
        onClick={() => page(1)}
        aria-label="More people"
        title="More people"
        tabIndex={canRight ? 0 : -1}
      >
        <ChevronDown />
      </button>
    </div>
  );
}
