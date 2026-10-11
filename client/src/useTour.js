// When the step-by-step tour (Tour.jsx) plays.
//
// It plays ONCE per device on its own — the first time in a call, a beat
// after the screen settles, and only when nothing else is in the way
// (`ready`, e.g. the invite pop-up is closed). That's remembered in this
// browser's storage, separately for each layout (phone / desktop), since
// their buttons differ. After that, the "?" button replays it (start()).

import { useCallback, useEffect, useState } from 'react';

// Fallback when storage is blocked (private mode…): remember for this page
// load at least, so it doesn't replay every time `ready` flips.
const seenThisLoad = new Set();

/**
 * @param {string}  key    remembers "seen" separately per layout
 * @param {boolean} ready  nothing else is in the way
 * @returns {{ running: boolean, start: Function, stop: Function }}
 */
export function useTour(key, ready) {
  const storageKey = `listen.tour.${key}.seen`;
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!ready) return undefined;
    let seen = seenThisLoad.has(storageKey);
    try {
      seen = seen || localStorage.getItem(storageKey) === '1';
    } catch {
      // storage blocked — the in-memory set above covers this page load
    }
    if (seen) return undefined;
    // A beat after the call screen settles, not the instant it appears.
    const t = setTimeout(() => setRunning(true), 1500);
    return () => clearTimeout(t);
  }, [ready, storageKey]);

  // Finished or skipped: don't play by itself again on this device.
  const stop = useCallback(() => {
    setRunning(false);
    seenThisLoad.add(storageKey);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // not remembered past this page load
    }
  }, [storageKey]);

  const start = useCallback(() => setRunning(true), []);
  return { running, start, stop };
}
