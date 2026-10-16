// The in-call screen on phones (≤560px), from the mobile designs.
//
// Two layouts, swapped by the two-monitors button under the meeting name:
//   spotlight — one person (or a screen share) fills the whole phone, everyone
//               else stacks in a column of thumbnails on the right
//   grid      — everyone in a three-column grid on a dark purple page
// Both keep the same top bar (host, meeting name, Open / Moderated, door lock,
// "X want to join"), a TikTok-style chat feed bottom-left, and the bottom bar:
// people · "Add comment…" · camera · mic · share screen · leave.
//
// Press and hold the camera or mic button to pick another camera / mic.
//
// All the call logic lives in <CallView/> (App.jsx); this file only draws it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EVENTS, MODES, ROLES } from '@listen/shared';
import { socket } from './socket.js';
import Avatar from './Avatar.jsx';
import VideoTile from './VideoTile.jsx';
import ImageViewer from './ImageViewer.jsx';
import {
  Cam,
  Check,
  Copy,
  FileDoc,
  Hand,
  Lock,
  Unlock,
  ImageIcon,
  MicOff,
  Paperclip,
  Pencil,
  RecordIcon,
  StopRecordIcon,
  Trash,
  X,
} from './icons.jsx';
import { downloadUrl, sendChatFile } from './chatFiles.js';
import { loadDeck, startPainter } from './presenter.js';
import { useVideoPip } from './useVideoPip.js';
import { inviteLink, recordingLink } from './meeting.js';
import { confirmDialog } from './ConfirmDialog.jsx';
import Tour from './Tour.jsx';
import { hasSeenTour, useTour } from './useTour.js';
import TourButton from './TourButton.jsx';
import RecBadge from './RecBadge.jsx';
import NextUp from './NextUp.jsx';
import { ReactionButton } from './Reactions.jsx';
import NoiseToggle from './NoiseToggle.jsx';
import { BreakoutBanner } from './Breakouts.jsx';
import TabSwap from './TabSwap.jsx';
import { strongNoiseSupported } from './webrtc.js';
import QuestionsPanel from './QuestionsPanel.jsx';
import PollPanel from './PollPanel.jsx';
import { ReportDialog } from './MeetingReport.jsx';

const ROLE_LABEL = { host: 'Host', cohost: 'Cohost', speaker: 'Speaker', listener: 'Listener' };
const ROLE_RANK = { host: 0, cohost: 1, speaker: 2, listener: 3 };

export default function MobileCall({ call }) {
  // The meeting report pop-up (moderators, from the people sheet).
  const [reportOpen, setReportOpen] = useState(false);
  const closeReport = useCallback(() => setReportOpen(false), []);
  const {
    state,
    chat,
    typers,
    selfId,
    onLeave,
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
    startShare,
    presentStream,
    stopShare,
    mediaError,
    layout,
    toggleLayout,
    camOf,
    cohostId,
    recording,
    startRecording,
    stopRecording,
    openBreakouts,
    act,
  } = call;

  const host = participants.find((p) => p.role === ROLES.HOST);
  const peerOf = (id) => participants.find((p) => p.id === id);
  // whose chat a moderator muted (CHAT_MUTE)
  const chatMuted = state?.chatMuted ?? [];

  // Each camera tile, plus what we need to draw an avatar while its camera is off.
  const tiles = cameraTiles.map((t) => {
    const person = t.key === 'me' ? self : peerOf(t.key);
    return {
      ...t,
      id: t.key === 'me' ? selfId : t.key,
      name: t.key === 'me' ? 'You' : (person?.name ?? 'Guest'),
      avatar: person?.avatar,
      camOff: t.key === 'me' ? !camOn : !camOf(t.key),
      role: person?.role,
    };
  });
  const selfTile = tiles.find((t) => t.key === 'me');
  const others = tiles.filter((t) => t.key !== 'me');

  // Spotlight: a screen share, else whoever YOU picked (tap a thumbnail), else
  // the first other person, else you. It never jumps to whoever's talking —
  // each viewer chooses their own big screen; the green ring on a thumbnail
  // shows who's speaking. If your pick leaves, it falls back to the default.
  const [pinnedKey, setPinnedKey] = useState(null);
  const pinned = tiles.find((t) => t.key === pinnedKey);
  const spotlight = presenting ? screenTiles[0] : (pinned ?? others[0] ?? selfTile);
  const strip = presenting ? tiles : tiles.filter((t) => t !== spotlight);

  const [sheet, setSheet] = useState(false); // people sheet
  // Closing the people sheet happens in two steps, so it can slide away
  // instead of vanishing: `sheetClosing` plays the slide-down (CSS), and
  // when that ends the sheet is actually removed (closeSheetNow).
  const [sheetClosing, setSheetClosing] = useState(false);
  // Which tab the sheet opens on (a question note's "View" opens Questions).
  const [sheetTab, setSheetTab] = useState('people');
  const openSheet = (tab = 'people') => {
    setSheetTab(typeof tab === 'string' ? tab : 'people');
    setSheet(true);
    setSheetClosing(false); // reopening mid-slide-out cancels it
  };
  const closeSheet = () => setSheetClosing(true);
  const closeSheetNow = () => {
    setSheet(false);
    setSheetClosing(false);
  };
  // Safety net: browsers pause animations in a background tab (and skip them
  // for "reduce motion"), so the slide's end might never be reported. Remove
  // the sheet anyway, a moment after the slide would have finished.
  useEffect(() => {
    if (!sheetClosing) return undefined;
    const t = setTimeout(() => {
      setSheet(false);
      setSheetClosing(false);
    }, 400);
    return () => clearTimeout(t);
  }, [sheetClosing]);
  const [deviceMenu, setDeviceMenu] = useState(null); // 'video' | 'audio' | null
  // The ⋮ control dial (camera, mic, share, leave) in the bottom-right corner.
  const [dialOpen, setDialOpen] = useState(false);
  const [picked, setPicked] = useState(null); // grid tile showing mute / remove
  const [msgMenu, setMsgMenu] = useState(null); // my message being held: edit / delete
  const [viewing, setViewing] = useState(null); // chat image open full screen: { src, name }
  const [editing, setEditing] = useState(null); // my message being edited
  // The invite pop-up: opens by itself for whoever starts the meeting (alone
  // in it), and again from the meeting name or the people sheet.
  // (Not when coming back with Rejoin — the meeting isn't new to them.)
  // On the very first call, the step-by-step tour goes first and the invite
  // pops up when it's done (see the tour further down).
  const startsMeeting = !rejoined && isHost && participants.length === 1;
  const inviteAfterTourRef = useRef(startsMeeting && !hasSeenTour('phone'));
  const [inviteOpen, setInviteOpen] = useState(() => startsMeeting && !inviteAfterTourRef.current);

  const knocker = isModerator ? waiting[0] : null;

  // Full-screen view while someone presents: the shared screen sits between
  // the header and the row of people instead of under them, so we need the
  // header's height (it changes with the join notice, long names, …).
  const mainRef = useRef(null);
  const headRef = useRef(null);
  useLayoutEffect(() => {
    const head = headRef.current;
    const main = mainRef.current;
    if (!head || !main) return undefined;
    const set = () => main.style.setProperty('--mc-head', `${head.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);
  // …and where the people row actually starts, so the presentation ends just
  // above it (measured, not guessed — phone toolbars change the height).
  const stripRef = useRef(null);
  const stackPresenting = layout !== 'grid' && presenting; // (`grid` is defined further down)
  useLayoutEffect(() => {
    const main = mainRef.current;
    const strip = stripRef.current;
    if (!stackPresenting || !main || !strip) return undefined;
    const feed = main.querySelector('.mc-feedwrap');
    const set = () => {
      const m = main.getBoundingClientRect();
      // the row sits just above the chat (whose position depends on the bar,
      // which is taller on iPhones with a home bar) …
      if (feed) {
        const f = feed.getBoundingClientRect();
        main.style.setProperty('--mc-row-bottom', `${Math.max(0, m.bottom - f.top + 6)}px`);
      }
      // … and the presentation ends just above the row
      const st = strip.getBoundingClientRect();
      main.style.setProperty('--mc-stage-bottom', `${Math.max(0, m.bottom - st.top + 6)}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(main);
    ro.observe(strip);
    if (feed) ro.observe(feed);
    return () => ro.disconnect();
  }, [stackPresenting, strip.length]);

  // Grid view: columns by headcount (4 -> 2 x 2, 5+ -> 3 across), and tiles
  // as big as the space between the header and the chat allows.
  // At most 3 x 3. With more than nine people, the ninth tile becomes "+N"
  // (tap it for the people list). Whoever is talking always gets a visible
  // tile; everyone else hidden behind "+N" is still heard (see mc-offstage).
  const GRID_MAX = 9;
  const overflow = !presenting && tiles.length > GRID_MAX;
  let gridShown = tiles;
  let gridHidden = [];
  if (overflow) {
    gridShown = tiles.slice(0, GRID_MAX - 1);
    gridHidden = tiles.slice(GRID_MAX - 1);
    const talker = gridHidden.find((t) => t.speaking);
    if (talker) {
      gridHidden = gridHidden.filter((t) => t !== talker).concat(gridShown[gridShown.length - 1]);
      gridShown = [...gridShown.slice(0, -1), talker];
    }
  }
  const gridCount = overflow ? GRID_MAX : gridShown.length;
  const gridCols = gridCount <= 1 ? 1 : gridCount === 4 ? 2 : Math.min(3, gridCount);
  const gridRows = Math.ceil(gridCount / gridCols);
  const gridAreaRef = useRef(null);
  const [gridBox, setGridBox] = useState(null);
  useLayoutEffect(() => {
    const el = gridAreaRef.current;
    if (!el) return undefined;
    const measure = () => setGridBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout, presenting]);
  const GAP = 2;
  const TILE_RATIO = 247 / 335; // width / height, from the design
  const tileW = gridBox
    ? Math.floor(
        Math.min(
          (gridBox.w - GAP * (gridCols - 1)) / gridCols,
          ((gridBox.h - GAP * (gridRows - 1)) / gridRows) * TILE_RATIO,
        ),
      )
    : null;

  // iPhone Safari's floating toolbar and the keyboard both change what's
  // visible; keep the call screen exactly over the visible part.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    // When the keyboard opens, iPhone Safari shrinks the visible area AND
    // scrolls the page up — so follow both its height and where it starts.
    const root = document.documentElement;
    const set = () => {
      root.style.setProperty('--mc-vh', `${vv.height}px`);
      root.style.setProperty('--mc-vtop', `${vv.offsetTop}px`);
    };
    set();
    vv.addEventListener('resize', set);
    vv.addEventListener('scroll', set);
    return () => {
      vv.removeEventListener('resize', set);
      vv.removeEventListener('scroll', set);
      root.style.removeProperty('--mc-vh');
      root.style.removeProperty('--mc-vtop');
    };
  }, []);

  const grid = layout === 'grid';

  // "The big video": whoever is on your big screen, or the screen being presented.
  const findBigVideo = () => {
    if (!grid) return document.querySelector('.mc-stage video');
    if (presenting) return document.querySelector('.mc-screen video');
    const key = CSS.escape(String(spotlight?.key ?? ''));
    return document.querySelector(`.mc-gtile[data-key="${key}"] video`);
  };

  // Floating video: automatically when you leave the browser where the phone
  // allows it (desktop Chrome today), or from the pop-out button.
  const pip = useVideoPip(findBigVideo, `${grid}|${presenting}|${spotlight?.key}`);
  function popOut() {
    pip.enter();
    setTimeout(() => {
      if (!pip.isFloatingNow()) flashError('This browser won\u2019t float a live call video.');
    }, 1500);
  }

  // Double-tap the big video: full screen. On Android, pressing home while a
  // video is full screen floats it automatically.
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  function goFullscreen() {
    const v = findBigVideo();
    if (!v) return;
    v.play?.()?.catch?.(() => {});
    if (v.requestFullscreen) v.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone
  }
  const onBigTap = (e) => {
    const now = Date.now();
    const p = lastTap.current;
    const near = Math.hypot(e.clientX - p.x, e.clientY - p.y) < 30;
    if (now - p.t < 320 && near) {
      lastTap.current = { t: 0, x: 0, y: 0 };
      goFullscreen();
    } else {
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
  };
  const badge = isModerator ? waiting.length + (moderated ? queue.length : 0) : 0;
  // Share button: phones can't capture the screen (no getDisplayMedia), so it
  // opens "Present to everyone" — photos or a PDF, streamed like a screen
  // share (presenter.js). Where the browser can, "Share my screen" is there too.
  const showShare = !isListener;
  const shareSupported = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const [presentMenu, setPresentMenu] = useState(false);
  const [presentation, setPresentation] = useState(null); // { deck, painter, index }
  const [presentBusy, setPresentBusy] = useState(false);
  const [presentError, setPresentError] = useState(null);
  const photosRef = useRef(null);
  const pdfRef = useRef(null);

  // The leave button sits right next to the others — easy to hit by mistake,
  // so ask first.
  async function confirmLeave() {
    const others = participants.length - 1;
    const ok = await confirmDialog({
      title: 'Leave the call?',
      message:
        isHost && others > 0
          ? 'You’re the host. Someone else takes over unless you rejoin within a minute.'
          : 'You’ll have a minute to rejoin.',
      confirmLabel: 'Leave',
      cancelLabel: 'Stay',
      danger: true,
    });
    if (ok) onLeave();
  }

  function flashError(msg) {
    setPresentError(msg);
    setTimeout(() => setPresentError(null), 4000);
  }

  async function startPresenting(files) {
    if (!files?.length) return;
    setPresentBusy(true);
    let deck = null;
    let painter = null;
    try {
      deck = await loadDeck(files);
      painter = startPainter();
      painter.show(await deck.page(0));
      if (!(await presentStream(painter.stream))) throw new Error('cancelled');
      setPresentation({ deck, painter, index: 0 });
    } catch (err) {
      painter?.stop();
      deck?.close();
      if (err?.message !== 'cancelled') flashError(err?.message || 'Could not open that file.');
    } finally {
      setPresentBusy(false);
    }
  }

  async function goToPage(i) {
    if (!presentation) return;
    const { deck, painter } = presentation;
    if (i < 0 || i >= deck.count) return;
    setPresentation((p) => p && { ...p, index: i });
    painter.show(await deck.page(i));
  }

  // The share ended — Stop, someone else took over, or I lost the floor —
  // so tidy up the canvas and the file.
  const presentationRef = useRef(null);
  presentationRef.current = presentation;
  useEffect(() => {
    if (!sharingScreen && presentationRef.current) {
      const { deck, painter } = presentationRef.current;
      painter.stop();
      deck.close();
      setPresentation(null);
    }
  }, [sharingScreen]);
  // ...and when leaving the call mid-presentation.
  useEffect(
    () => () => {
      presentationRef.current?.painter.stop();
      presentationRef.current?.deck.close();
    },
    [],
  );

  // Swipe the big screen left / right to flip pages while presenting.
  const swipe = useRef(null);
  const swipeHandlers = presentation
    ? {
        onPointerDown: (e) => (swipe.current = e.clientX),
        onPointerUp: (e) => {
          if (swipe.current === null) return;
          const dx = e.clientX - swipe.current;
          swipe.current = null;
          if (Math.abs(dx) > 50) goToPage(presentation.index + (dx < 0 ? 1 : -1));
        },
      }
    : {};

  // --- the step-by-step tour of this screen (Tour.jsx) --------------------
  // Plays by itself the moment someone is in their first call on this phone
  // (before the invite pop-up, which follows it); after that, only the "?"
  // in the top bar plays it. Only the steps that apply
  // to this person are listed — a listener has no Share button, only
  // moderators have the room switches, and so on. The dial steps open the ⋮
  // dial so its controls can be shown; the steps either side close it again.
  const tour = useTour('phone', true, () => {
    // The invite pop-up that was held back for the tour (first call only).
    if (inviteAfterTourRef.current) {
      inviteAfterTourRef.current = false;
      setInviteOpen(true);
    }
  });
  const closeDial = () => setDialOpen(false);
  const openDial = () => setDialOpen(true);
  const tourSteps = [
    {
      target: '.mc-title-btn',
      title: 'Your meeting',
      text: 'Tap the meeting name any time to copy or share the invite link.',
      before: closeDial,
    },
    isModerator && {
      target: '.mc-mode',
      title: 'Open or Moderated',
      text: 'Open: everyone can talk. Moderated: people listen until you give them the floor.',
    },
    isModerator && {
      target: '.mc-lock',
      title: 'The door',
      text: 'Locked: you let each new person in. Open: anyone with the link walks straight in.',
    },
    !isModerator && {
      target: '.mc-tophand',
      title: 'Raise your hand',
      text: 'In a moderated meeting, tap here to ask to speak. The host sees you in the queue.',
    },
    {
      target: '.mc-layout',
      title: 'Change the view',
      text: 'Switch between one big video and a grid of everyone.',
    },
    pip.supported && {
      target: '.mc-popout',
      title: 'Keep the call floating',
      text: 'Going to another app? Tap this first and the video keeps playing in a small window.',
    },
    isModerator && {
      target: '.mc-rec',
      title: 'Record',
      text: 'Records the meeting. Everyone sees it’s being recorded and can watch it afterwards, for a day.',
    },
    {
      target: '.mc-people',
      title: 'People',
      text: isModerator
        ? 'Everyone in the call, who’s knocking, raised hands, and your host controls.'
        : 'See everyone in the call and get the invite link.',
    },
    {
      target: '.mc-comment',
      title: 'Chat',
      text: 'Message everyone here. Use 📎 for photos and files. Press and hold your own message to edit or delete it.',
      before: closeDial,
    },
    {
      target: '.mc-dial-toggle',
      title: 'Your controls',
      text: 'Camera, mic, sharing and leaving are tucked in here. Tap to open, tap anywhere else to close.',
      before: closeDial,
    },
    {
      target: '.mc-dial-item .mc-leave',
      title: 'Leave',
      text: 'Leaves the call. Changed your mind? You get a minute to rejoin.',
      before: openDial,
    },
    {
      target: '.mc-dial-item .mc-cam',
      title: 'Camera',
      text: 'Turns your camera on or off. Press and hold to switch to another camera.',
      before: openDial,
    },
    {
      target: '.mc-dial-item .mc-mic',
      title: 'Microphone',
      text: isListener
        ? 'Your mic is off while you’re listening. Raise your hand to ask for the floor.'
        : 'Mutes or unmutes you. Press and hold to pick another microphone.',
      before: openDial,
    },
    showShare && {
      target: '.mc-dial-item .mc-cast',
      title: 'Present',
      text: 'Show everyone photos or a PDF (or your screen, where your phone allows it).',
      before: openDial,
    },
    !grid && {
      target: '.mc-stage',
      title: 'The big video',
      text: 'Double-tap it for full screen. Tap someone on the side to put them here.',
      before: closeDial,
    },
    {
      target: '.tour-replay',
      title: 'That’s it!',
      text: 'Tap ? any time to see this tour again.',
      before: closeDial,
    },
  ].filter(Boolean);

  return (
    <main
      ref={mainRef}
      className={`mc${grid ? ' mc-grid' : ''}${isModerator ? '' : ' mc-member'}${!grid && presenting ? ' mc-presenting' : ''}`}
    >
      {/* Spotlight: the big video behind everything. */}
      {!grid && spotlight && (
        <div
          className="mc-stage"
          {...swipeHandlers}
          onPointerUp={(e) => {
            swipeHandlers.onPointerUp?.(e);
            onBigTap(e);
          }}
        >
          <Tile tile={spotlight} sinkId={media?.speakerId} screen={presenting} />
        </div>
      )}

      <header className="mc-top" ref={headRef}>
        <div className="mc-title">
          <button
            type="button"
            className="mc-title-btn"
            onClick={() => setInviteOpen(true)}
            aria-label="Invite people"
          >
            {host && <Avatar name={host.name} src={host.avatar} size={40} />}
            <span className="mc-title-text">
              <h1>{state?.title || state?.roomId}</h1>
            </span>
          </button>
          {isModerator ? (
            <button
              type="button"
              className={`mc-mode${moderated ? ' is-mod' : ''}`}
              onClick={() => act.changeMode(moderated ? MODES.OPEN : MODES.MODERATED)}
              aria-label={moderated ? 'Moderated. Tap to open the room' : 'Open. Tap to moderate'}
            >
              <SwapLabel on={moderated} off="Open" onLabel="Moderated" />
            </button>
          ) : (
            // Members: raise hand (moderated rooms, while listening) and the
            // layout swap, both up here — no room controls.
            <>
              <button
                type="button"
                className={`mc-tophand${handRaised ? ' on' : ''}`}
                onClick={handRaised ? act.lowerHand : act.raiseHand}
                disabled={!isListener}
                aria-label={
                  !isListener
                    ? moderated
                      ? 'You have the floor'
                      : 'Raising a hand is for moderated rooms'
                    : handRaised
                      ? `Lower hand (#${myQueuePos + 1} in line)`
                      : 'Raise hand'
                }
              >
                <Hand />
                {handRaised && <b className="mc-badge">{myQueuePos + 1}</b>}
              </button>
              <button
                type="button"
                className="mc-layout"
                onClick={toggleLayout}
                aria-label={grid ? 'Switch to spotlight view' : 'Switch to grid view'}
              >
                <SwapScreens />
              </button>
              {pip.supported && (
                <button
                  type="button"
                  className={`mc-popout${pip.active ? ' on' : ''}`}
                  onClick={pip.active ? pip.exit : popOut}
                  aria-label={pip.active ? 'Bring the video back' : 'Pop out a floating video'}
                >
                  <PopOutIcon />
                </button>
              )}
              <TourButton onClick={tour.start} />
              {/* (just the dot: this row is already full) */}
              {recording && <RecBadge recording={recording} dotOnly />}
            </>
          )}
          {isModerator && (
            <button
              type="button"
              className={`mc-lock${locked ? '' : ' is-open'}`}
              onClick={act.toggleLock}
              aria-label={locked ? 'Door locked. Tap to open' : 'Door open. Tap to lock'}
            >
              <span className="mc-lock-icon" aria-hidden="true">
                {locked ? <Lock /> : <Unlock />}
              </span>
              <SwapLabel on={!locked} off="locked" onLabel="unlocked" />
            </button>
          )}
        </div>

        {isModerator && (
          <div className="mc-row2">
            <button
              type="button"
              className="mc-layout"
              onClick={toggleLayout}
              aria-label={grid ? 'Switch to spotlight view' : 'Switch to grid view'}
            >
              <SwapScreens />
            </button>
            {pip.supported && (
              <button
                type="button"
                className={`mc-popout${pip.active ? ' on' : ''}`}
                onClick={pip.active ? pip.exit : popOut}
                aria-label={pip.active ? 'Bring the video back' : 'Pop out a floating video'}
              >
                <PopOutIcon />
              </button>
            )}
            <TourButton onClick={tour.start} />
            {/* Record / stop, and "● 12:34" while recording. */}
            <button
              type="button"
              className={`mc-rec${recording ? ' on' : ''}`}
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? 'Stop recording' : 'Record the meeting'}
            >
              {recording ? <StopRecordIcon /> : <RecordIcon />}
            </button>
            {recording && <RecBadge recording={recording} compact />}
            <KnockNotice
              knocker={knocker}
              extra={Math.max(0, waiting.length - 1)}
              onAdmit={act.admit}
              onDeny={act.deny}
            />
          </div>
        )}
        {mediaError && <p className="mc-status err">{mediaError}</p>}
      </header>

      {grid ? (
        <section className={`mc-gridwrap${presenting ? ' presenting' : ''}`}>
          {presenting && (
            <div className="mc-screen" onPointerUp={onBigTap}>
              <Tile tile={screenTiles[0]} sinkId={media?.speakerId} screen />
            </div>
          )}
          <div className="mc-gridarea" ref={gridAreaRef}>
            {/* While someone presents, people become a sideways-scrolling row
                under the screen: four at a time, swipe for the rest. */}
            <div
              className={`mc-gridtiles${presenting ? ' scroll' : ''}${presenting && tiles.length > 4 ? ' more' : ''}`}
              onScroll={(e) => {
                const el = e.currentTarget;
                el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
              }}
              style={!presenting && tileW ? { '--tile-w': `${Math.max(60, tileW)}px` } : undefined}
            >
              {(presenting ? tiles : gridShown).map((t) => {
                const canMod =
                  isModerator && t.key !== 'me' && t.role !== ROLES.HOST && t.id !== selfId;
                const open = canMod && picked === t.key;
                return (
                  <div
                    key={t.key}
                    data-key={t.key}
                    className={`mc-gtile${t.speaking ? ' speaking' : ''}`}
                    onClick={canMod ? () => setPicked(open ? null : t.key) : undefined}
                  >
                    <Tile tile={t} sinkId={media?.speakerId} />
                    <span className="mc-gname">{t.name}</span>
                    {t.micOff && !open && (
                      <span className="mc-gmuted" aria-label="muted">
                        <MicOff />
                      </span>
                    )}
                    {open && (
                      <div className="mc-gactions">
                        {/* No Mute in a moderated room (Grant / Revoke runs the mic). */}
                        {!moderated && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              act.forceMute(t.id);
                              setPicked(null);
                            }}
                            aria-label={`Mute ${t.name}`}
                          >
                            <MicOff />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPicked(null);
                            act.removeParticipant(peerOf(t.id));
                          }}
                          aria-label={`Remove ${t.name}`}
                        >
                          <X />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {overflow && (
                <button
                  type="button"
                  className="mc-gtile mc-gmore"
                  onClick={openSheet}
                  aria-label={`${gridHidden.length} more people. Show everyone`}
                >
                  <span className="mc-gmore-faces" aria-hidden="true">
                    {gridHidden.slice(0, 3).map((t) => (
                      <Avatar key={t.key} name={t.name} src={t.avatar} size={34} />
                    ))}
                  </span>
                  <b>+{gridHidden.length}</b>
                </button>
              )}
            </div>
          </div>
          {/* People behind "+N": their video isn't shown, but it keeps playing
              off-screen so their audio is still heard. */}
          {overflow && (
            <div className="mc-offstage" aria-hidden="true">
              {gridHidden.map((t) => (
                <Tile key={t.key} tile={t} sinkId={media?.speakerId} />
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className="mc-spacer" />
      )}

      {/* Spotlight: everyone else, stacked on the right. Tap one to put them big. */}
      {!grid && strip.length > 0 && (
        <div
          ref={stripRef}
          className={`mc-strip${presenting ? ' row' : ''}${presenting && strip.length > 4 ? ' more' : ''}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
          }}
        >
          {strip.map((t) => (
            <button
              type="button"
              key={t.key}
              className={`mc-thumb${t.speaking ? ' speaking' : ''}`}
              onClick={() => !presenting && setPinnedKey(t.key)}
              aria-label={`Show ${t.name} big`}
            >
              <Tile tile={t} sinkId={media?.speakerId} />
            </button>
          ))}
        </div>
      )}

      <ChatFeed
        chat={chat}
        typers={typers}
        selfId={selfId}
        participants={participants}
        narrow={!grid && !presenting}
        held={msgMenu?.id}
        onHold={setMsgMenu}
        onView={setViewing}
        onOpenQuestions={() => openSheet('qa')}
        canModerate={isModerator}
      />

      {presentation && (
        <div className="mc-present-bar" role="toolbar" aria-label="Presentation">
          <button
            type="button"
            onClick={() => goToPage(presentation.index - 1)}
            disabled={presentation.index === 0}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span>
            {presentation.index + 1} / {presentation.deck.count}
          </span>
          <button
            type="button"
            onClick={() => goToPage(presentation.index + 1)}
            disabled={presentation.index >= presentation.deck.count - 1}
            aria-label="Next page"
          >
            ›
          </button>
          <button type="button" className="mc-present-stop" onClick={stopShare}>
            Stop
          </button>
        </div>
      )}
      {presentError && <p className="mc-toast">{presentError}</p>}

      {/* Moderated room: who's next in line for the floor. */}
      <div className="mc-nextup">
        <BreakoutBanner state={state} onManage={isModerator ? openBreakouts : undefined} />
        <NextUp queue={queue} participants={participants} selfId={selfId} moderated={moderated} />
      </div>

      {canPassMic && (
        <button
          type="button"
          className={`mc-pass${presentation ? ' raised' : ''}`}
          onClick={act.passMic}
        >
          🎤 Pass the mic
        </button>
      )}

      <footer className="mc-bar">
        <button
          type="button"
          className="mc-people"
          onClick={openSheet}
          aria-label="People and room controls"
        >
          <PeopleIcon />
          {badge > 0 && <b className="mc-badge">{badge}</b>}
        </button>

        <Composer muted={chatMuted.includes(selfId)} />

        <ControlDial
          open={dialOpen}
          onToggle={() => setDialOpen((o) => !o)}
          onClose={() => setDialOpen(false)}
          micOff={!micOn && !isListener}
          items={[
            // In order around the arc, top first (see ControlDial).
            {
              key: 'leave',
              node: (
                <button
                  type="button"
                  className="mc-btn mc-leave"
                  onClick={() => {
                    setDialOpen(false);
                    confirmLeave();
                  }}
                  aria-label="Leave call"
                >
                  <PowerIcon />
                </button>
              ),
            },
            {
              key: 'cam',
              node: (
                <HoldButton
                  className={`mc-btn mc-cam${camOn ? '' : ' off'}`}
                  label={camOn ? 'Turn camera off (hold for more cameras)' : 'Turn camera on'}
                  onTap={toggleCam}
                  onHold={() => {
                    setDialOpen(false);
                    setDeviceMenu('video');
                  }}
                >
                  <CamFilled off={!camOn} />
                </HoldButton>
              ),
            },
            {
              // A listener's mic stays here, greyed out — the ✋ up top asks
              // for the floor.
              key: 'mic',
              node: (
                <HoldButton
                  className={`mc-btn mc-mic${micOn && !isListener ? '' : ' off'}${isListener ? ' locked' : ''}`}
                  label={
                    isListener
                      ? 'Listening only. Raise your hand to speak'
                      : micOn
                        ? 'Mute (hold for more microphones)'
                        : 'Unmute'
                  }
                  onTap={toggleMic}
                  onHold={() => {
                    setDialOpen(false);
                    setDeviceMenu('audio');
                  }}
                >
                  <MicFilled off={!micOn || isListener} />
                </HoldButton>
              ),
            },
            showShare && {
              key: 'share',
              node: (
                <button
                  type="button"
                  className={`mc-btn mc-cast${sharingScreen ? ' on' : ''}${presentBusy ? ' busy' : ''}`}
                  onClick={() => {
                    setDialOpen(false);
                    if (sharingScreen) stopShare();
                    else setPresentMenu(true);
                  }}
                  disabled={presentBusy}
                  aria-label={sharingScreen ? 'Stop presenting' : 'Present to everyone'}
                >
                  <CastIcon />
                </button>
              ),
            },
          ].filter(Boolean)}
        />
      </footer>

      {presentMenu && (
        <div className="mc-backdrop" onClick={() => setPresentMenu(false)}>
          <div className="mc-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <p className="mc-menu-title">Present to everyone</p>
            {shareSupported && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setPresentMenu(false);
                  startShare();
                }}
              >
                <span>Share my screen</span>
                <CastIcon />
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                photosRef.current?.click();
                setPresentMenu(false);
              }}
            >
              <span>Photos</span>
              <ImageIcon />
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                pdfRef.current?.click();
                setPresentMenu(false);
              }}
            >
              <span>PDF document</span>
              <FileDoc />
            </button>
            <p className="mc-menu-note">
              {shareSupported
                ? 'Slides or Word files? Save them as a PDF first.'
                : 'Phones can’t share the whole screen, but you can show photos or a PDF, then swipe the big screen to flip pages. Slides or Word files? Save them as a PDF first.'}
            </p>
          </div>
        </div>
      )}
      <input
        ref={photosRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          startPresenting(files);
        }}
      />
      <input
        ref={pdfRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          startPresenting(files);
        }}
      />

      {msgMenu && (
        <div className="mc-backdrop" onClick={() => setMsgMenu(null)}>
          <div className="mc-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <p className="mc-menu-title mc-menu-quote">
              {msgMenu.kind === 'file' ? `📎 ${msgMenu.file?.name ?? 'Attachment'}` : msgMenu.text}
            </p>
            {msgMenu.from === selfId && msgMenu.kind !== 'sticker' && msgMenu.kind !== 'file' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setEditing(msgMenu);
                  setMsgMenu(null);
                }}
              >
                <span>Edit</span>
                <Pencil />
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={async () => {
                const m = msgMenu;
                setMsgMenu(null);
                const mine = m.from === selfId;
                const ok = await confirmDialog({
                  title: mine ? 'Delete this message?' : `Delete ${m.name}’s message?`,
                  message: 'It will be removed for everyone.',
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (!ok) return;
                // your own: unsend; someone else's: a moderator's delete
                // (the server checks you're allowed)
                socket.emit(mine ? EVENTS.CHAT_UNSEND : EVENTS.CHAT_DELETE, { id: m.id }, () => {});
              }}
            >
              <span>Delete</span>
              <Trash />
            </button>
          </div>
        </div>
      )}

      {editing && <EditMessage m={editing} onClose={() => setEditing(null)} />}

      {deviceMenu && (
        <DeviceMenu
          kind={deviceMenu}
          current={devices[deviceMenu]}
          onPick={(id) => switchDevice(deviceMenu, id)}
          onClose={() => setDeviceMenu(null)}
          extra={
            deviceMenu === 'audio' &&
            strongNoiseSupported && <NoiseToggle on={strongNoise} onChange={setStrongNoise} />
          }
        />
      )}

      {sheet && (
        <PeopleSheet
          closing={sheetClosing}
          onClose={closeSheet}
          onClosed={closeSheetNow}
          onInvite={() => {
            // Straight to the invite pop-up, which slides up in its place.
            closeSheetNow();
            setInviteOpen(true);
          }}
          {...{
            participants,
            selfId,
            isHost,
            isModerator,
            moderated,
            waiting,
            queued,
            isListener,
            handRaised,
            myQueuePos,
            cohostId,
            chatMuted,
            act,
            initialTab: sheetTab,
            questions: state?.questions ?? [],
            poll: state?.poll ?? null,
            onReport: () => {
              closeSheetNow();
              setReportOpen(true);
            },
            onBreakouts: state?.breakout
              ? null
              : () => {
                  closeSheetNow();
                  openBreakouts();
                },
          }}
        />
      )}
      {reportOpen && <ReportDialog onClose={closeReport} />}
      {viewing && (
        <ImageViewer src={viewing.src} alt={viewing.name} onClose={() => setViewing(null)} />
      )}

      {inviteOpen && state?.roomId && (
        <InviteSheet
          roomId={state.roomId}
          title={state.title}
          locked={locked}
          onClose={() => setInviteOpen(false)}
        />
      )}

      {tour.running && (
        <Tour
          steps={tourSteps}
          onClose={() => {
            closeDial();
            tour.stop();
          }}
        />
      )}
    </main>
  );
}

// "Your meeting is ready": the invite link with Copy, and Share — the phone's
// own share sheet (WhatsApp, Messages, email…) where the browser has one.
function InviteSheet({ roomId, title, locked, onClose }) {
  const link = inviteLink(roomId);
  const inputRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === 'function';
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // clipboard blocked (plain http): select it so a long-press copy works
      inputRef.current?.select();
      if (!document.execCommand('copy')) return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  async function share() {
    try {
      await navigator.share({
        title: title || 'Turnly meeting',
        text: title ? `Join "${title}" on Turnly` : 'Join my meeting on Turnly',
        url: link,
      });
    } catch {
      // closed the share sheet — nothing to do
    }
  }
  return (
    <div className="mc-backdrop" onClick={onClose}>
      <div
        className="mc-menu mc-invite-sheet"
        role="dialog"
        aria-label="Invite people"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mc-sheet-head">
          <h2>Your meeting is ready</h2>
          <button type="button" className="mc-sheet-x" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <p className="mc-note">Share this link with the people you want to join you.</p>
        <div className="mc-invite-link">
          <input
            ref={inputRef}
            value={link}
            readOnly
            onFocus={(e) => e.target.select()}
            aria-label="Invite link"
          />
          <button type="button" className={copied ? 'on' : ''} onClick={copy}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {canShare && (
          <button type="button" className="mc-invite" onClick={share}>
            <ShareIcon />
            Share invite
          </button>
        )}
        {locked && (
          <p className="mc-menu-note">
            The door is locked, so you&rsquo;ll let each person in as they arrive.
          </p>
        )}
      </div>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

// Two words in one spot: the current one slides in while the other slides
// out, and the box glides to the new word's width (the pill's colour change
// is CSS on the button around it).
function SwapLabel({ on, off, onLabel }) {
  const offRef = useRef(null);
  const onRef = useRef(null);
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = on ? onRef.current : offRef.current;
      if (el) setWidth(el.offsetWidth);
    };
    measure();
    // The web font can land after the first measure and widen the word.
    document.fonts?.ready.then(measure);
  }, [on, off, onLabel]);
  return (
    <span className="mc-swap" style={width ? { width } : undefined}>
      <span ref={offRef} className={on ? 'out' : 'in'} aria-hidden={on}>
        {off}
      </span>
      <span ref={onRef} className={on ? 'in' : 'out'} aria-hidden={!on}>
        {onLabel}
      </span>
    </span>
  );
}

// "<name> want to join" with accept / decline. Slides in from the right; when
// the knock is answered (or the person gives up) it slides back out before it
// goes. A new person knocking slides in fresh.
function KnockNotice({ knocker, extra, onAdmit, onDeny }) {
  const [shown, setShown] = useState(knocker); // what's on screen right now
  const [leaving, setLeaving] = useState(false);
  if (knocker && (knocker.id !== shown?.id || leaving)) {
    setShown(knocker);
    setLeaving(false);
  } else if (!knocker && shown && !leaving) {
    setLeaving(true);
  }
  if (!shown) return null;
  return (
    <div
      key={shown.id}
      className={`mc-knock${leaving ? ' leaving' : ''}`}
      role="status"
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget) {
          setShown(null);
          setLeaving(false);
        }
      }}
    >
      <span className="mc-knock-text">
        <b>{shown.name}</b> want to join
        {extra > 0 && !leaving && <em> +{extra}</em>}
      </span>
      <button
        type="button"
        className="mc-knock-yes"
        onClick={() => onAdmit(shown.id)}
        disabled={leaving}
        aria-label={`Let ${shown.name} in`}
      >
        <AcceptCall />
      </button>
      <button
        type="button"
        className="mc-knock-no"
        onClick={() => onDeny(shown.id)}
        disabled={leaving}
        aria-label={`Turn ${shown.name} away`}
      >
        <PhoneGlyph />
      </button>
    </div>
  );
}

// A video with the person's avatar over it while their camera is off. The
// <video> always stays mounted — it's also what plays their audio.
function Tile({ tile, sinkId, screen = false }) {
  return (
    <div className="mc-tile">
      <VideoTile
        sinkId={sinkId}
        stream={tile.stream}
        label={tile.label}
        muted={tile.muted}
        mirror={tile.mirror}
        screen={screen}
        away={tile.away}
      />
      {!screen && tile.camOff && (
        <div className="mc-camoff">
          <Avatar name={tile.name} src={tile.avatar} size={56} />
        </div>
      )}
    </div>
  );
}

// The ⋮ button in the bottom-right corner and the call controls it fans out.
//
// Tap ⋮: the controls pop out ONE AFTER ANOTHER along a quarter circle around
// the button — the first item straight above it, the last off to its left —
// over a dark blurred glow that makes them stand out from the video. The ⋮
// turns into ✕. Tap ✕, tap anywhere else, or press Esc: they tuck back in,
// in reverse order.
//
// The controls stay mounted while closed (just shrunk away, invisible and
// untappable), so closing can animate too. Their positions are worked out
// here from the arc; the timing lives in the CSS (--i = pop-out order,
// --ri = the reverse, for closing).
//
// While closed you can't see the mic button, so a muted mic shows as a small
// red badge on ⋮ itself.
const DIAL_RADIUS = 150; // px from the ⋮ button's centre to each control's centre
const DIAL_FIRST_DEG = 90; // first control: straight up
const DIAL_STEP_DEG = 28; // each next one this much further round to the left

function ControlDial({ open, onToggle, onClose, micOff, items }) {
  // Esc closes it, like the other menus.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const n = items.length;
  return (
    <div className={`mc-dial${open ? ' open' : ''}`}>
      {/* Invisible full-screen layer under the controls: a tap anywhere
          else lands here and closes the dial. */}
      <div className="mc-dial-scrim" onClick={onClose} aria-hidden="true" />
      {/* The dark blurred glow spreading out from the corner. */}
      <div className="mc-dial-glow" aria-hidden="true" />

      {items.map((item, i) => {
        // Angle round the circle (0° = right, 90° = up), then x/y on screen
        // (screen y grows downwards, hence the minus).
        const rad = ((DIAL_FIRST_DEG + i * DIAL_STEP_DEG) * Math.PI) / 180;
        const x = Math.round(Math.cos(rad) * DIAL_RADIUS);
        const y = Math.round(-Math.sin(rad) * DIAL_RADIUS);
        return (
          <div
            key={item.key}
            className="mc-dial-item"
            style={{ '--x': `${x}px`, '--y': `${y}px`, '--i': i, '--ri': n - 1 - i }}
            // While closed: invisible AND out of reach (no taps, no keyboard).
            {...(open ? {} : { inert: '' })}
          >
            {item.node}
          </div>
        );
      })}

      <button
        type="button"
        className="mc-dial-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Close call controls' : 'Call controls: camera, mic, share, leave'}
      >
        <span className="mc-dial-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <X className="mc-dial-x" aria-hidden="true" />
        {micOff && !open && (
          <span className="mc-dial-muted" aria-label="Your mic is off">
            <MicOff />
          </span>
        )}
      </button>
    </div>
  );
}

// Tap = onTap; press and hold (half a second) = onHold.
function HoldButton({ className, label, onTap, onHold, children }) {
  const timer = useRef(null);
  const held = useRef(false);
  const start = () => {
    held.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      held.current = true;
      navigator.vibrate?.(15);
      onHold();
    }, 500);
  };
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (held.current) held.current = false;
        else onTap();
      }}
    >
      {children}
    </button>
  );
}

// The list that pops up after a long press: every camera (or mic) the phone
// reports, with a check on the one in use.
// `extra`: shown under the list (the mic's noise-reduction switch).
function DeviceMenu({ kind, current, onPick, onClose, extra = null }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    const want = kind === 'video' ? 'videoinput' : 'audioinput';
    function refresh() {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setList(all.filter((d) => d.kind === want)));
    }
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [kind]);
  const noun = kind === 'video' ? 'camera' : 'microphone';
  return (
    <div className="mc-backdrop" onClick={onClose}>
      <div className="mc-menu" role="listbox" onClick={(e) => e.stopPropagation()}>
        <p className="mc-menu-title">Choose {noun}</p>
        {list?.map((d, i) => (
          <button
            type="button"
            key={d.deviceId}
            role="option"
            aria-selected={d.deviceId === current}
            className={d.deviceId === current ? 'on' : ''}
            onClick={() => {
              onPick(d.deviceId);
              onClose();
            }}
          >
            <span>{d.label || `${noun[0].toUpperCase()}${noun.slice(1)} ${i + 1}`}</span>
            {d.deviceId === current && <Check />}
          </button>
        ))}
        {list && list.length < 2 && <p className="mc-menu-note">No other {noun} found.</p>}
        {extra}
      </div>
    </div>
  );
}

// "Add comment…" — sends a text message to the room chat. The 📎 inside the
// field sends a photo (library or camera) or any file. `muted`: a moderator
// muted my chat — the field greys out and says so.
function Composer({ muted = false }) {
  const [text, setText] = useState('');
  const [attachMenu, setAttachMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const photoRef = useRef(null);
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  function sendFile(file) {
    if (!file) return;
    setSending(true);
    setAttachError(null);
    sendChatFile(file).then((err) => {
      setSending(false);
      if (err) {
        setAttachError(err);
        setTimeout(() => setAttachError(null), 4000);
      }
    });
  }
  function onPick(e) {
    const [file] = e.target.files ?? [];
    e.target.value = ''; // the same file can be picked again
    sendFile(file);
  }
  // open one of the hidden pickers and close the menu
  const choose = (ref) => {
    ref.current?.click();
    setAttachMenu(false);
  };
  const typing = useRef({ active: false, last: 0, idle: null });
  const stopTyping = () => {
    const t = typing.current;
    clearTimeout(t.idle);
    if (t.active) {
      t.active = false;
      socket.emit(EVENTS.CHAT_TYPING, { typing: false });
    }
  };
  useEffect(() => stopTyping, []);
  function onChange(e) {
    setText(e.target.value);
    const t = typing.current;
    if (!e.target.value.trim()) return stopTyping();
    if (!t.active || Date.now() - t.last > 3000) {
      t.active = true;
      t.last = Date.now();
      socket.emit(EVENTS.CHAT_TYPING, { typing: true });
    }
    clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, 3500);
  }
  function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    socket.emit(EVENTS.CHAT_SEND, { text: body }, (ack) => {
      if (!ack?.ok) console.warn('[chat-send] rejected:', ack?.error);
    });
    setText('');
    stopTyping();
  }
  return (
    <form className={`mc-comment${muted ? ' muted' : ''}`} onSubmit={send}>
      <input
        value={text}
        onChange={onChange}
        onBlur={stopTyping}
        // muted by a moderator: can't type (reactions below still work —
        // they aren't chat)
        disabled={muted}
        placeholder={muted ? 'The host muted your chat' : 'Add comment...'}
        aria-label="Add comment"
        maxLength={2000}
        enterKeyHint="send"
        onPaste={(e) => {
          const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file');
          if (item) {
            e.preventDefault();
            sendFile(item.getAsFile());
          }
        }}
      />
      <button
        type="button"
        className={`mc-attach${sending ? ' busy' : ''}`}
        onClick={() => setAttachMenu(true)}
        disabled={sending || muted}
        aria-label={sending ? 'Sending…' : 'Send a photo or file'}
      >
        <Paperclip />
      </button>
      {/* 👍 👏 🙏 … for everyone, without unmuting */}
      <ReactionButton className="mc-attach mc-react" />
      <input ref={photoRef} type="file" accept="image/*" hidden onChange={onPick} />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={onPick}
      />
      <input ref={fileRef} type="file" hidden onChange={onPick} />
      {attachError && <p className="mc-attach-err">{attachError}</p>}

      {attachMenu && (
        <div className="mc-backdrop" onClick={() => setAttachMenu(false)}>
          <div className="mc-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <p className="mc-menu-title">Send to the chat</p>
            <button type="button" role="menuitem" onClick={() => choose(photoRef)}>
              <span>Photo library</span>
              <ImageIcon />
            </button>
            <button type="button" role="menuitem" onClick={() => choose(cameraRef)}>
              <span>Take a photo</span>
              <Cam />
            </button>
            <button type="button" role="menuitem" onClick={() => choose(fileRef)}>
              <span>File</span>
              <FileDoc />
            </button>
            <p className="mc-menu-note">Up to 5 MB. Photos are resized before sending.</p>
          </div>
        </div>
      )}
    </form>
  );
}

// TikTok-Live-style feed: avatar, name, message — plus "X joined via share
// invitation" lines for people who arrive after you.
//
// The newest 3–4 lines sit at the bottom at full strength; a mask on the
// scroller fades everything above them into nothing as it rises. Nothing is
// dropped — scroll up and the faded history is all there. While you're
// reading back, new messages don't yank you down; a "New messages" pill
// counts them and takes you back to the live edge.
function ChatFeed({
  chat,
  typers,
  selfId,
  participants,
  narrow,
  held,
  onHold,
  onView,
  onOpenQuestions,
  canModerate = false, // a moderator can hold anyone's message to delete it
}) {
  const [joins, setJoins] = useState([]);
  const seen = useRef(null);
  useEffect(() => {
    const ids = participants.map((p) => p.id);
    if (seen.current === null) {
      seen.current = new Set(ids); // already here when we joined: no line
      return;
    }
    const fresh = participants.filter((p) => !seen.current.has(p.id) && p.id !== selfId);
    ids.forEach((id) => seen.current.add(id));
    if (fresh.length) {
      const now = Date.now();
      setJoins((j) => [
        ...j,
        ...fresh.map((p) => ({ id: `join-${p.id}-${now}`, kind: 'join', name: p.name, ts: now })),
      ]);
    }
  }, [participants, selfId]);

  const items = [...chat.filter((m) => !m.unsent), ...joins].sort((a, b) => a.ts - b.ts);

  const avatarOf = (m) => participants.find((p) => p.id === m.from)?.avatar;
  const typing = Object.entries(typers ?? {})
    .filter(([id]) => id !== selfId)
    .map(([, name]) => name);

  // Lines already here on the first render don't animate in — only live ones.
  const initialIds = useRef(null);
  if (initialIds.current === null) initialIds.current = new Set(items.map((m) => m.id));

  const hold = useRef({ timer: null, start: null }); // press-and-hold on my messages
  const scroller = useRef(null);
  const atBottom = useRef(true); // following the live edge?
  const autoScrolling = useRef(false); // our own smooth scroll is in flight
  const prevCount = useRef(null);
  const [browsing, setBrowsing] = useState(false);
  const [unseen, setUnseen] = useState(0);

  function toBottom(smooth) {
    const el = scroller.current;
    if (!el) return;
    autoScrolling.current = smooth;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottom.current = true;
    setBrowsing(false);
    setUnseen(0);
  }

  function onScroll() {
    const el = scroller.current;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (near) {
      autoScrolling.current = false;
      atBottom.current = true;
      setBrowsing(false);
      setUnseen(0);
    } else if (!autoScrolling.current) {
      // The person scrolled up themselves: let them read.
      atBottom.current = false;
      setBrowsing(true);
    }
  }
  // A finger or wheel on the feed always wins over our smooth scroll.
  const userGrab = () => {
    autoScrolling.current = false;
  };

  const count = items.length;
  const last = items[count - 1];
  const typingKey = typing.join('|');
  useLayoutEffect(() => {
    if (prevCount.current === null) {
      prevCount.current = count;
      toBottom(false); // open at the live edge, no animation
      return;
    }
    const added = count - prevCount.current;
    prevCount.current = count;
    if (atBottom.current || (added > 0 && last?.from === selfId)) toBottom(true);
    else if (added > 0) setUnseen((n) => n + added);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, typingKey]);

  return (
    <section className={`mc-feedwrap${narrow ? ' narrow' : ''}`}>
      <div
        ref={scroller}
        className={`mc-feed${browsing ? ' browsing' : ''}`}
        onScroll={onScroll}
        onTouchStart={userGrab}
        onWheel={userGrab}
        aria-live="polite"
      >
        {items.map((m) => {
          const enter = initialIds.current.has(m.id) ? '' : ' mc-in';
          if (m.kind === 'note') {
            // From Listen itself: "Sam started recording · Open recording".
            return (
              <p key={m.id} className={`mc-join mc-sysnote${enter}`}>
                {m.recording && <span className="rec-dot" aria-hidden="true" />}
                {m.text}
                {m.recording && (
                  <a href={recordingLink(m.recording)} target="_blank" rel="noreferrer">
                    Open recording
                  </a>
                )}
                {m.question && (
                  <button type="button" className="cp-note-link" onClick={onOpenQuestions}>
                    View
                  </button>
                )}
              </p>
            );
          }
          return m.kind === 'join' ? (
            <p key={m.id} className={`mc-join${enter}`}>
              <b>{m.name}</b> joined via share invitation
            </p>
          ) : (
            <div
              key={m.id}
              className={`mc-msg${enter}${held === m.id ? ' held' : ''}`}
              // hold a message for its menu: your own (edit / delete), or —
              // for a moderator — anyone's (delete)
              {...(m.from === selfId || canModerate ? holdHandlers(hold, () => onHold(m)) : {})}
            >
              <Avatar name={m.name} src={avatarOf(m)} size={32} />
              <div>
                <b>{m.from === selfId ? 'You' : m.name}</b>
                <MessageBody m={m} onView={onView} />
                {m.editedAt && <small className="mc-edited">edited</small>}
              </div>
            </div>
          );
        })}
        {typing.length > 0 && (
          <p className="mc-typing mc-in">
            {typing.slice(0, 2).join(', ')}
            {typing.length > 2 ? ` +${typing.length - 2}` : ''} typing…
          </p>
        )}
      </div>
      {browsing && unseen > 0 && (
        <button type="button" className="mc-newmsgs" onClick={() => toBottom(true)}>
          {unseen} new message{unseen > 1 ? 's' : ''} ↓
        </button>
      )}
    </section>
  );
}

// Press-and-hold on one of my messages (half a second). Moving the finger —
// i.e. scrolling the feed — cancels it.
// `hold` is a ref so the timer survives a re-render mid-press.
function holdHandlers(hold, onHold) {
  const h = hold.current;
  const cancel = () => clearTimeout(h.timer);
  return {
    onPointerDown: (e) => {
      h.start = { x: e.clientX, y: e.clientY };
      h.fired = false;
      cancel();
      h.timer = setTimeout(() => {
        h.fired = true;
        navigator.vibrate?.(15);
        onHold();
      }, 500);
    },
    onPointerMove: (e) => {
      if (h.start && Math.hypot(e.clientX - h.start.x, e.clientY - h.start.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e) => e.preventDefault(),
    // The finger lifting after a hold fires a click — don't let it also open
    // the image underneath.
    onClickCapture: (e) => {
      if (h.fired) {
        h.fired = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };
}

// Bottom sheet for editing one of my text messages.
function EditMessage({ m, onClose }) {
  const [text, setText] = useState(m.text ?? '');
  function save(e) {
    e.preventDefault();
    const body = text.trim();
    if (body && body !== m.text) socket.emit(EVENTS.CHAT_EDIT, { id: m.id, text: body }, () => {});
    onClose();
  }
  return (
    <div className="mc-backdrop" onClick={onClose}>
      <form className="mc-menu mc-edit" onSubmit={save} onClick={(e) => e.stopPropagation()}>
        <p className="mc-menu-title">Edit message</p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          rows={3}
        />
        <div className="mc-edit-row">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="go" disabled={!text.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

// Tapping a photo opens it full screen (ImageViewer) with a Download button.
function MessageBody({ m, onView }) {
  if (m.kind === 'sticker') return <p className="mc-sticker">{m.text}</p>;
  if (m.kind === 'file' && m.file) {
    if (m.file.type?.startsWith('image/'))
      return (
        <button
          type="button"
          className="mc-imgbtn"
          onClick={() => onView({ src: m.file.url, name: m.file.name })}
          aria-label={`View ${m.file.name}`}
        >
          <img className="mc-img" src={m.file.url} alt={m.file.name} />
        </button>
      );
    return (
      // (the server sends it as a download — see downloadUrl)
      <a className="mc-file" href={downloadUrl(m.file.url)} download={m.file.name}>
        📎 {m.file.name}
      </a>
    );
  }
  return <p>{m.text}</p>;
}

// Bottom sheet behind the people button: invite link, the door, raised hands
// and everyone in the call with the moderator actions.
// `closing` = it's sliding back down; when that slide ends, onClosed()
// removes it for real (onClose only STARTS the slide).
function PeopleSheet({
  closing,
  onClose,
  onClosed,
  onInvite,
  participants,
  selfId,
  isHost,
  isModerator,
  moderated,
  waiting,
  queued,
  isListener,
  handRaised,
  myQueuePos,
  cohostId,
  chatMuted = [],
  act,
  questions,
  poll,
  onReport,
  onBreakouts,
  initialTab = 'people',
}) {
  // People, questions or the poll.
  const [tab, setTab] = useState(initialTab);
  const ordered = [...participants].sort(
    (a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) || a.name.localeCompare(b.name),
  );

  return (
    <div className={`mc-backdrop${closing ? ' closing' : ''}`} onClick={onClose}>
      <div
        className="mc-sheet"
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          // Only the sheet's OWN slide-down — not animations inside it.
          if (closing && e.target === e.currentTarget) onClosed();
        }}
      >
        <div className="mc-sheet-head">
          <div
            className="mc-tabs"
            role="tablist"
            // the sliding highlight (see .mc-tabs::before): 3 options, which is on
            style={{ '--n': 3, '--i': ['people', 'qa', 'poll'].indexOf(tab) }}
          >
            {[
              ['people', `People (${participants.length})`, 0],
              ['qa', 'Questions', questions.length],
              ['poll', 'Poll', poll?.open ? '•' : 0],
            ].map(([key, label, badge]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`mc-tab${tab === key ? ' on' : ''}`}
                onClick={() => setTab(key)}
              >
                {label}
                {badge ? <b className="cp-tab-badge">{badge}</b> : null}
              </button>
            ))}
          </div>
          <button type="button" className="mc-sheet-x" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>

        {/* slides in from the side you switched to (TabSwap) */}
        <TabSwap tab={tab} order={['people', 'qa', 'poll']}>
          {tab === 'qa' && (
            <QuestionsPanel
              questions={questions}
              participants={participants}
              selfId={selfId}
              isModerator={isModerator}
              moderated={moderated}
            />
          )}
          {tab === 'poll' && <PollPanel poll={poll} isModerator={isModerator} />}

          {tab === 'people' && (
            <>
              {isModerator && onBreakouts && (
                <button type="button" className="cp-report-btn" onClick={onBreakouts}>
                  🧩 Breakout rooms: split into small groups
                </button>
              )}
              {isModerator && (
                <button type="button" className="cp-report-btn" onClick={onReport}>
                  📊 Meeting report: who spoke, and for how long
                </button>
              )}
              <button type="button" className="mc-invite" onClick={onInvite}>
                <ShareIcon />
                Invite people
              </button>

              {isListener && (
                <p className="mc-note">
                  🎧 Listening only:{' '}
                  {handRaised
                    ? `you're #${myQueuePos + 1} in line for the floor.`
                    : 'raise your hand to ask for the floor.'}
                </p>
              )}

              {isModerator && waiting.length > 0 && (
                <>
                  <h3>Waiting to join ({waiting.length})</h3>
                  {waiting.map((w) => (
                    <div className="mc-person" key={w.id}>
                      <Avatar name={w.name} src={w.avatar} size={36} />
                      <span className="mc-pname">{w.name}</span>
                      <span className="mc-pacts">
                        <button type="button" className="go" onClick={() => act.admit(w.id)}>
                          Admit
                        </button>
                        <button type="button" onClick={() => act.deny(w.id)}>
                          Deny
                        </button>
                      </span>
                    </div>
                  ))}
                </>
              )}

              {isModerator && moderated && (
                <>
                  <h3>
                    Raised hands ({queued.length})
                    {participants.some((p) => p.role === ROLES.SPEAKER) && (
                      <button type="button" className="mc-link" onClick={act.clearFloor}>
                        Clear floor
                      </button>
                    )}
                  </h3>
                  {queued.length === 0 && (
                    <p className="mc-note">No one’s waiting for the floor.</p>
                  )}
                  {queued.map((p, i) => (
                    <div className="mc-person" key={p.id}>
                      <span className="mc-qpos">{i + 1}</span>
                      <span className="mc-pname">{p.name}</span>
                      <span className="mc-pacts">
                        <button
                          type="button"
                          disabled={i === 0}
                          onClick={() => act.moveInQueue(p.id, -1)}
                          aria-label={`Move ${p.name} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={i === queued.length - 1}
                          onClick={() => act.moveInQueue(p.id, 1)}
                          aria-label={`Move ${p.name} down`}
                        >
                          ↓
                        </button>
                        <button type="button" className="go" onClick={() => act.grantFloor(p.id)}>
                          Grant
                        </button>
                        <button type="button" onClick={() => act.dismissHand(p.id)}>
                          Dismiss
                        </button>
                      </span>
                    </div>
                  ))}
                </>
              )}

              <h3>In the call</h3>
              {ordered.map((p) => {
                const canMod = isModerator && p.id !== selfId && p.role !== ROLES.HOST;
                const hostControls = isHost && p.id !== selfId && p.role !== ROLES.HOST;
                return (
                  <div className="mc-person" key={p.id}>
                    <Avatar name={p.name} src={p.avatar} size={36} />
                    <span className="mc-pname">
                      {p.name}
                      {p.id === selfId ? ' (you)' : ''}
                      <small className={`mc-role ${p.role}`}>{ROLE_LABEL[p.role] ?? p.role}</small>
                    </span>
                    <span className="mc-pacts">
                      {canMod && moderated && p.role === ROLES.LISTENER && (
                        <button type="button" className="go" onClick={() => act.grantFloor(p.id)}>
                          Grant
                        </button>
                      )}
                      {canMod && moderated && p.role === ROLES.SPEAKER && (
                        <button type="button" onClick={() => act.revokeFloor(p.id)}>
                          Revoke
                        </button>
                      )}
                      {hostControls &&
                        (p.id === cohostId ? (
                          <button type="button" onClick={() => act.dropCohost(p)}>
                            Remove cohost
                          </button>
                        ) : (
                          <button type="button" onClick={() => act.makeCohost(p)}>
                            Make cohost
                          </button>
                        ))}
                      {/* Moderated rooms run the mic through Grant / Revoke
                    (listeners are silent anyway), so no Mute there. */}
                      {canMod && !moderated && (
                        <button type="button" onClick={() => act.forceMute(p.id)}>
                          Mute
                        </button>
                      )}
                      {/* their chat: muted = they can read, not post
                          (never the co-host — a moderator) */}
                      {canMod && p.id !== cohostId && (
                        <button
                          type="button"
                          onClick={() => act.setChatMute(p.id, !chatMuted.includes(p.id))}
                        >
                          {chatMuted.includes(p.id) ? 'Unmute chat' : 'Mute chat'}
                        </button>
                      )}
                      {canMod && (
                        <button
                          type="button"
                          className="bad"
                          onClick={() => act.removeParticipant(p)}
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </TabSwap>
      </div>
    </div>
  );
}

/* ---- the design's coloured icons --------------------------------------- */

function SwapScreens() {
  return (
    <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
      <rect
        x="4"
        y="6"
        width="20"
        height="13"
        rx="2"
        fill="#cfe9ff"
        stroke="#3d8fe0"
        strokeWidth="1.6"
      />
      <path d="M10 22h8M14 19v3" stroke="#3d8fe0" strokeWidth="1.6" strokeLinecap="round" />
      <rect
        x="24"
        y="26"
        width="20"
        height="13"
        rx="2"
        fill="#cfe9ff"
        stroke="#3d8fe0"
        strokeWidth="1.6"
      />
      <path d="M30 42h8M34 39v3" stroke="#3d8fe0" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M30 8a9 9 0 0 1 9 9"
        fill="none"
        stroke="#2fbf71"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="m36 15 3 3 3-3"
        fill="none"
        stroke="#2fbf71"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 40a9 9 0 0 1-9-9"
        fill="none"
        stroke="#2fbf71"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="m12 33-3-3-3 3"
        fill="none"
        stroke="#2fbf71"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PopOutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

const PHONE_D =
  'M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02z';

function PhoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d={PHONE_D}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AcceptCall() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
      <path d={PHONE_D} fill="#2fbf71" />
      <path
        d="M14 10l6-6m0 0h-4.5M20 4v4.5"
        fill="none"
        stroke="#2d8cf0"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke="#ff5c9a"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M16 4.3a4 4 0 0 1 0 7.4M19 14.5a7 7 0 0 1 3 6.5" />
    </svg>
  );
}

function CamFilled({ off }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="2" y="6" width="13" height="12" rx="3" fill="#fff" />
      <path d="M16 10.5 22 7v10l-6-3.5z" fill="#fff" />
      {off && <path d="M3 3l18 18" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />}
    </svg>
  );
}

function MicFilled({ off }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="8.5" y="2" width="7" height="12" rx="3.5" fill="currentColor" />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {off && <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
    </svg>
  );
}

function CastIcon() {
  return (
    <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
      <defs>
        <linearGradient id="mc-cast-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3aa0ff" />
          <stop offset="1" stopColor="#1f6fe8" />
        </linearGradient>
      </defs>
      <path
        d="M5 9a3 3 0 0 1 3-3h17a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H14a11 11 0 0 0-9-9z"
        fill="url(#mc-cast-g)"
      />
      <path
        d="M4 20a6 6 0 0 1 6 6M4 23.5A2.5 2.5 0 0 1 6.5 26"
        fill="none"
        stroke="#1f6fe8"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="4.5" cy="26" r="1.3" fill="#1f6fe8" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="#fff"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 3v8M7 6.3a8 8 0 1 0 10 0" />
    </svg>
  );
}
