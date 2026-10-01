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

import { createPortal } from 'react-dom';
import Avatar from './Avatar.jsx';
import VideoTile from './VideoTile.jsx';
import { Cam, CamOff, Hand, Mic, MicOff, Phone } from './icons.jsx';

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
 */
export function PipView({ win, main, person, self, controls }) {
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
