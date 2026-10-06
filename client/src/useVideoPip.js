// Floating video on phones. Phone browsers have no Document Picture-in-Picture
// (that's what the desktop mini-call in Pip.jsx uses), but they can float a
// single <video> over other apps. So we keep one hidden <video> showing
// whoever is on your big screen (or the screen being presented) and pop that
// out:
//
//   - automatically when you leave the browser, where the phone allows it
//     (Chrome's "enterpictureinpicture" media-session action, Safari's
//     autopictureinpicture, or a best-effort request on tab hide)
//   - from the pop-out button, which works wherever video PiP exists
//
// Tapping the floating window shows the system's own "back to tab" control,
// which returns to the meeting. Coming back any other way closes the window.

import { useCallback, useEffect, useRef, useState } from 'react';

const canPip =
  typeof document !== 'undefined' &&
  (document.pictureInPictureEnabled ||
    (typeof HTMLVideoElement !== 'undefined' &&
      'webkitSetPresentationMode' in HTMLVideoElement.prototype));

export function useVideoPip(stream) {
  const videoRef = useRef(null);
  const [active, setActive] = useState(false);

  // The hidden video always shows the current big-screen stream — also while
  // floating, so switching who's big updates the floating window too.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream ?? null;
    if (stream) v.play().catch(() => {});
  }, [stream]);

  const enter = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !v.srcObject) return false;
    try {
      if (v.readyState < 1)
        await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
      await v.play().catch(() => {});
      if (document.pictureInPictureElement === v) return true;
      if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      } else if (v.webkitSupportsPresentationMode?.('picture-in-picture')) {
        v.webkitSetPresentationMode('picture-in-picture');
      } else {
        return false;
      }
      return true;
    } catch {
      return false; // the browser said no (e.g. no tap behind it) — stay put
    }
  }, []);

  const exit = useCallback(() => {
    const v = videoRef.current;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else if (v?.webkitPresentationMode === 'picture-in-picture')
      v.webkitSetPresentationMode('inline');
  }, []);

  // Track whether we're floating; let Safari float on its own when you go home.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    v.autoPictureInPicture = true;
    v.setAttribute('autopictureinpicture', '');
    const on = () => setActive(true);
    const off = () => setActive(false);
    const webkit = () => setActive(v.webkitPresentationMode === 'picture-in-picture');
    v.addEventListener('enterpictureinpicture', on);
    v.addEventListener('leavepictureinpicture', off);
    v.addEventListener('webkitpresentationmodechanged', webkit);
    return () => {
      v.removeEventListener('enterpictureinpicture', on);
      v.removeEventListener('leavepictureinpicture', off);
      v.removeEventListener('webkitpresentationmodechanged', webkit);
    };
  }, []);

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

  // Leaving the page: try to float (some browsers allow it during a call).
  // Coming back: close the floating window — you're looking at the meeting.
  useEffect(() => {
    if (!canPip) return undefined;
    const onVis = () => {
      if (document.visibilityState === 'hidden') enter();
      else exit();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [enter, exit]);

  // Leaving the call closes it.
  useEffect(() => exit, [exit]);

  return { videoRef, supported: canPip, active, enter, exit };
}
