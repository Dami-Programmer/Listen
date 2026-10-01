// Owns the floating mini-call window (see Pip.jsx for what it shows and why).

import { useCallback, useEffect, useState } from 'react';

const pipSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window;

// The PiP window starts as a blank page: give it this page's styles.
function copyStyles(target) {
  for (const sheet of document.styleSheets) {
    try {
      const style = target.document.createElement('style');
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      target.document.head.appendChild(style);
    } catch {
      // Cross-origin sheet (Google Fonts): can't read its rules — link it.
      if (!sheet.href) continue;
      const link = target.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.document.head.appendChild(link);
    }
  }
}

// Owns the PiP window for the life of the call: opens it (automatically when
// the tab is hidden), closes it when the tab is visible again
// or the call ends. Returns the window while it's open, else null.
export function usePip() {
  const [pipWin, setPipWin] = useState(null);

  const openPip = useCallback(async () => {
    if (!pipSupported) return;
    if (window.documentPictureInPicture.window) return; // already open
    console.log('[pip] Chrome asked for the floating window — opening it');
    try {
      const win = await window.documentPictureInPicture.requestWindow({
        width: 360,
        height: 480,
      });
      copyStyles(win);
      win.document.title = 'Listen';
      win.document.body.className = 'pip-body';
      win.addEventListener('pagehide', () => setPipWin(null));
      setPipWin(win);
    } catch (err) {
      console.warn('[pip] could not open', err);
    }
  }, []);

  // Auto-open when the tab is hidden. Browsers that don't know this action
  // throw — then there's simply no auto-open.
  useEffect(() => {
    if (!pipSupported || !('mediaSession' in navigator)) {
      console.log('[pip] this browser has no Document Picture-in-Picture — no floating window');
      return undefined;
    }
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', openPip);
      console.log('[pip] ready — switch to another tab and Chrome should open the floating window');
    } catch (err) {
      console.log('[pip] this browser cannot auto-open the floating window:', err?.message);
      return undefined;
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      } catch {
        // ignore
      }
    };
  }, [openPip]);

  // Diagnostics: when the tab is hidden, say whether Chrome opened the window.
  // If it didn't, Chrome decided this tab wasn't eligible (it never tells the
  // page why) — the log lists what it checks.
  useEffect(() => {
    if (!pipSupported) return undefined;
    let timer;
    const onHidden = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'hidden') return;
      timer = setTimeout(() => {
        if (window.documentPictureInPicture.window) return;
        console.warn(
          '[pip] tab hidden but Chrome did not open the floating window. Chrome only does it when: ' +
            'the page is on https:// (plain http://, even localhost, never auto-opens); ' +
            'you switched to another TAB in the same window (not Alt-Tab / minimise); this tab is ' +
            'using the camera or mic; chrome://settings/content/autoPictureInPicture allows this ' +
            'site; and no other site (e.g. Google Meet) already has a floating window open.',
        );
      }, 1500);
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, []);

  // Back on the meeting's tab: the floating window isn't needed.
  useEffect(() => {
    if (!pipWin) return undefined;
    const onVisible = () => document.visibilityState === 'visible' && pipWin.close();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [pipWin]);

  // Leaving the call closes it.
  useEffect(() => () => window.documentPictureInPicture?.window?.close(), []);

  return { pipWin };
}
