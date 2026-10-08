// Floating mini-call, Google-Meet style. When you switch away from the
// meeting's tab, the browser opens a small always-on-top window (Document
// Picture-in-Picture): one rounded card with whoever is talking (or the screen
// being shared) — their avatar on a coloured card while their camera is off —
// their name in the corner, and a row of mic / camera / hand / leave buttons.
// It floats over every other tab and app and can be dragged anywhere. Clicking
// the card brings you back to the meeting's tab; coming back to the tab any
// other way closes it.
//
// How it opens: Chrome treats a page using the camera/mic as a video call and
// fires the media session "enterpictureinpicture" action when the tab is
// hidden — the one moment a page may open a PiP window without a click.
// There's no button: it only ever appears when you leave the tab.
// Browsers without Document PiP (Firefox, Safari today) simply don't get it.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar.jsx';
import VideoTile from './VideoTile.jsx';
import { Cam, CamOff, Check, Hand, Mic, MicOff, Phone, X } from './icons.jsx';

/**
 * What's drawn inside the PiP window (portalled into its document).
 *
 * @param {Window} props.win        the PiP window
 * @param {object} [props.main]     the big tile: { stream, mirror, ... }
 * @param {object} [props.person]   who's on it: { name, avatar, camOff, micOff }
 *                                  (camOff -> avatar card instead of video)
 * @param {object} [props.self]     my own tile, small in the corner while my
 *                                  camera is on and someone else is big
 * @param {object} props.controls   { micOn, camOn, isListener, showHand,
 *                                    handRaised, toggleMic, toggleCam,
 *                                    toggleHand, onLeave }
 * @param {object} [props.events]   what to announce in the window: { chat,
 *                                    queue, waiting, participants, selfId,
 *                                    isModerator, admit, deny }
 */
export function PipView({ win, main, person, self, controls, events }) {
  const c = controls;

  // Back to the meeting's tab. The floating window runs this page's code, so
  // `window` here is the meeting tab; focusing it from a click in the PiP
  // window switches to it. The visibility effect then closes the PiP.
  function backToTab() {
    window.focus();
    win.close();
  }

  const showVideo = main && !person?.camOff;

  return createPortal(
    <div className="pip">
      {events && <PipNotices events={events} onOpen={backToTab} />}
      <button
        type="button"
        className={`pip-stage${showVideo ? '' : ' card'}`}
        onClick={backToTab}
        title="Back to the meeting"
        aria-label="Back to the meeting"
      >
        {showVideo ? (
          <VideoTile stream={main.stream} label="" mirror={main.mirror} muted />
        ) : person ? (
          <Avatar name={person.name} src={person.avatar} size={96} className="pip-avatar" />
        ) : (
          <span className="pip-empty">Waiting for others…</span>
        )}
        {self && main !== self && c.camOn && (
          <span className="pip-self">
            <VideoTile stream={self.stream} label="" mirror muted />
          </span>
        )}
        {person && (
          <span className="pip-name">
            {person.micOff && <MicOff />}
            {person.name}
          </span>
        )}
      </button>

      <div className="pip-controls">
        <button
          type="button"
          onClick={c.toggleMic}
          disabled={c.isListener}
          className={c.micOn && !c.isListener ? '' : 'off'}
          title={
            c.isListener ? 'Raise your hand to ask for the floor' : c.micOn ? 'Mute' : 'Unmute'
          }
        >
          {c.micOn && !c.isListener ? <Mic /> : <MicOff />}
        </button>
        <button
          type="button"
          onClick={c.toggleCam}
          className={c.camOn ? '' : 'off'}
          title={c.camOn ? 'Turn camera off' : 'Turn camera on'}
        >
          {c.camOn ? <Cam /> : <CamOff />}
        </button>
        {c.showHand && (
          <button
            type="button"
            onClick={c.toggleHand}
            className={c.handRaised ? 'on' : ''}
            title={c.handRaised ? 'Lower hand' : 'Raise hand'}
          >
            <Hand />
          </button>
        )}
        <button type="button" onClick={c.onLeave} className="pip-leave" title="Leave call">
          <Phone />
        </button>
      </div>
    </div>,
    win.document.body,
  );
}

// Notices along the top of the floating window, so you don't miss anything
// while you're in another app: new messages and raised hands fade out after a
// few seconds; someone at the door stays (with admit / deny for the host and
// co-host) until they're let in or turned away. Nothing you did yourself, and
// nothing from before the window opened.
const NOTICE_MS = 5000;

function PipNotices({ events, onOpen }) {
  const { chat, queue, waiting, participants, selfId, isModerator, admit, deny } = events;
  const nameOf = (id) => participants.find((p) => p.id === id);
  const [notices, setNotices] = useState([]); // [{ id, kind, name, avatar, text }]
  const seenMsgs = useRef(null);
  const seenHands = useRef(null);

  function push(n) {
    setNotices((list) => [...list.filter((x) => x.id !== n.id), n].slice(-3));
    setTimeout(() => setNotices((list) => list.filter((x) => x.id !== n.id)), NOTICE_MS);
  }

  // new chat messages from other people
  useEffect(() => {
    const live = chat.filter((m) => !m.unsent);
    if (seenMsgs.current === null) {
      seenMsgs.current = new Set(live.map((m) => m.id));
      return;
    }
    for (const m of live) {
      if (seenMsgs.current.has(m.id)) continue;
      seenMsgs.current.add(m.id);
      if (m.from === selfId) continue;
      const text =
        m.kind === 'sticker'
          ? m.text
          : m.kind === 'file'
            ? m.file?.type?.startsWith('image/')
              ? 'sent a photo'
              : 'sent a file'
            : m.text;
      push({ id: `msg-${m.id}`, kind: 'msg', name: m.name, avatar: nameOf(m.from)?.avatar, text });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  // newly raised hands (not mine)
  const queueKey = queue.join(',');
  useEffect(() => {
    if (seenHands.current === null) {
      seenHands.current = new Set(queue);
      return;
    }
    for (const id of queue) {
      if (seenHands.current.has(id) || id === selfId) continue;
      const who = nameOf(id);
      push({
        id: `hand-${id}-${Date.now()}`,
        kind: 'hand',
        name: who?.name ?? 'Someone',
        avatar: who?.avatar,
      });
    }
    seenHands.current = new Set(queue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey]);

  const knocker = isModerator ? waiting[0] : null;

  if (!knocker && notices.length === 0) return null;
  return (
    <div className="pip-notices" aria-live="polite">
      {knocker && (
        <div className="pip-note knock" key={`knock-${knocker.id}`}>
          <Avatar name={knocker.name} src={knocker.avatar} size={28} />
          <span className="pip-note-text">
            <b>{knocker.name}</b> wants to join
            {waiting.length > 1 && <em> +{waiting.length - 1}</em>}
          </span>
          <button
            type="button"
            className="pip-note-btn deny"
            onClick={() => deny(knocker.id)}
            aria-label={`Turn ${knocker.name} away`}
          >
            <X />
          </button>
          <button
            type="button"
            className="pip-note-btn admit"
            onClick={() => admit(knocker.id)}
            aria-label={`Let ${knocker.name} in`}
          >
            <Check />
          </button>
        </div>
      )}
      {notices.map((n) => (
        <button type="button" key={n.id} className={`pip-note ${n.kind}`} onClick={onOpen}>
          <Avatar name={n.name} src={n.avatar} size={28} />
          <span className="pip-note-text">
            {n.kind === 'hand' ? (
              <>
                ✋ <b>{n.name}</b> raised their hand
              </>
            ) : (
              <>
                <b>{n.name}</b> {n.text}
              </>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
