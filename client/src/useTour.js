// When the step-by-step tour (Tour.jsx) plays.
//
// It plays ONCE per device on its own — the moment someone is in their first
// call (just long enough for the call screen to settle). That's remembered in
// this browser's storage, separately for each layout (phone / desktop), since
// their buttons differ. After that, only the "?" button plays it (start()).
//
// It goes FIRST: for a host starting a meeting, the "Your meeting is ready"
// invite pop-up waits until the tour is finished (the call screens use
// hasSeenTour() to decide that up front, then open the invite in onStop).

import { useCallback, useEffect, useState } from 'react';

// Long enough for the call screen to finish appearing, short enough to feel
// like it starts as you arrive.
const START_DELAY_MS = 700;

// Fallback when storage is blocked (private mode…): remember for this page
// load at least, so it doesn't replay every time `ready` flips.
const seenThisLoad = new Set();

const storageKeyOf = (key) => `listen.tour.${key}.seen`;

/** Has this device already seen (or skipped) the tour for this layout? */
export function hasSeenTour(key) {
  const storageKey = storageKeyOf(key);
  if (seenThisLoad.has(storageKey)) return true;
  try {
    return localStorage.getItem(storageKey) === '1';
  } catch {
    return false; // storage blocked — the in-memory set covers this page load
  }
}

/**
 * @param {string}    key     remembers "seen" separately per layout
 * @param {boolean}   ready   this layout is the one on screen, nothing in the way
 * @param {Function} [onStop] runs when the tour ends (finished or skipped)
 * @returns {{ running: boolean, start: Function, stop: Function }}
 */
export function useTour(key, ready, onStop) {
  const storageKey = storageKeyOf(key);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!ready || hasSeenTour(key)) return undefined;
    const t = setTimeout(() => setRunning(true), START_DELAY_MS);
    return () => clearTimeout(t);
  }, [ready, key]);

  // Finished or skipped: don't play by itself again on this device.
  const stop = useCallback(() => {
    setRunning(false);
    seenThisLoad.add(storageKey);
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // not remembered past this page load
    }
    onStop?.();
  }, [storageKey, onStop]);

  const start = useCallback(() => setRunning(true), []);
  return { running, start, stop };
}
