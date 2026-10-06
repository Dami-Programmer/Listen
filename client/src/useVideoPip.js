// Floating video on phones. Phone browsers have no Document Picture-in-Picture
// (that's what the desktop mini-call in Pip.jsx uses), but they can float a
// single <video> over other apps. We float the video you're actually looking
// at — whoever is on your big screen, or the screen being presented:
//
//   - from the pop-out button. iPhone Safari only allows this as the direct
//     result of a tap, so the request is made straight away, no waiting.
//   - automatically when you leave the browser, where the phone allows it:
//     Chrome's "enterpictureinpicture" media-session action, or Safari's
//     autopictureinpicture on the big-screen video.
//
// Tapping the floating window shows the system's own "back to app" control,
// which returns to the meeting. Coming back any other way closes the window.

import { useCallback, useEffect, useRef, useState } from 'react';

const proto = typeof HTMLVideoElement !== 'undefined' ? HTMLVideoElement.prototype : {};
const hasWebkitPip = 'webkitSetPresentationMode' in proto; // iPhone / iPad Safari
const canPip =
  typeof document !== 'undefined' && (hasWebkitPip || Boolean(document.pictureInPictureEnabled));

const isFloating = (v) =>
  Boolean(v) &&
  (document.pictureInPictureElement === v || v.webkitPresentationMode === 'picture-in-picture');

/**
 * @param {() => HTMLVideoElement | null} findVideo  the big-screen <video> right now
 * @param {*} spotKey  changes when a different video is on the big screen
 */
export function useVideoPip(findVideo, spotKey) {
  const findRef = useRef(findVideo);
  findRef.current = findVideo;
  const floatingEl = useRef(null);
  const [active, setActive] = useState(false);

  // Called straight from the tap — keep it synchronous (no await before the
  // request), or Safari treats it as not user-initiated and ignores it.
  const enter = useCallback(() => {
    const v = findRef.current?.();
    if (!v || isFloating(v)) return;
    try {
      v.play?.()?.catch?.(() => {});
      if (hasWebkitPip && v.webkitSupportsPresentationMode?.('picture-in-picture')) {
        floatingEl.current = v;
        v.webkitSetPresentationMode('picture-in-picture');
      } else if (v.requestPictureInPicture) {
        floatingEl.current = v;
        v.requestPictureInPicture().catch(() => {});
      }
    } catch {
      // the browser said no — stay as we are
    }
  }, []);

  const exit = useCallback(() => {
    const v = floatingEl.current;
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else if (v?.webkitPresentationMode === 'picture-in-picture')
        v.webkitSetPresentationMode('inline');
    } catch {
      // ignore
    }
  }, []);

  // Know when any of our videos floats or comes back (these events fire on
  // the <video>; listen at the document in the capture phase to catch them).
  useEffect(() => {
    const sync = (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement)) return;
      if (isFloating(v)) {
        floatingEl.current = v;
        setActive(true);
      } else if (v === floatingEl.current) {
        setActive(false);
      }
    };
    const types = [
      'enterpictureinpicture',
      'leavepictureinpicture',
      'webkitpresentationmodechanged',
    ];
    types.forEach((t) => document.addEventListener(t, sync, true));
    return () => types.forEach((t) => document.removeEventListener(t, sync, true));
  }, []);

  // Let Safari float the big-screen video on its own when you swipe home —
  // only that one video, so it knows which to pick.
  useEffect(() => {
    if (!canPip) return;
    document.querySelectorAll('video[autopictureinpicture]').forEach((v) => {
      v.autoPictureInPicture = false;
      v.removeAttribute('autopictureinpicture');
    });
    const v = findRef.current?.();
    if (v) {
      v.autoPictureInPicture = true;
      v.setAttribute('autopictureinpicture', '');
    }
  }, [spotKey]);

  // Chrome calls this when you leave a tab that's in a call — the one moment a
  // page may float a video without a tap. Unknown action -> it throws -> skip.
  useEffect(() => {
    if (!canPip || !('mediaSession' in navigator)) return undefined;
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', enter);
    } catch {
      return undefined;
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      } catch {
        // ignore
      }
    };
  }, [enter]);

  // Back on the meeting: close the floating window — you're looking at it.
  useEffect(() => {
    if (!canPip) return undefined;
    const onVis = () => document.visibilityState === 'visible' && exit();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [exit]);

  // Leaving the call closes it.
  useEffect(() => exit, [exit]);

  return { supported: canPip, active, enter, exit };
}
