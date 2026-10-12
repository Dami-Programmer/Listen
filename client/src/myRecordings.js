// "Your recordings": the meetings recorded while you were in them, remembered
// in this browser so you can come back to them from the home screen — no
// account needed. (Only on this device: another phone or browser won't know
// them.) Each entry is { id, title, at }; ones too old to still exist are
// dropped as the list is read.

import { RECORDING_KEEP_MS } from '@listen/shared';

const KEY = 'listen.recordings';
// The recording is deleted a day after the meeting ENDS, which we don't know
// here — so keep showing it a little longer; its page says if it's gone.
const SHOW_FOR_MS = RECORDING_KEEP_MS + 12 * 60 * 60 * 1000;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Recordings to show, newest first. */
export function listRecordings() {
  const now = Date.now();
  return read()
    .filter((r) => r && typeof r.id === 'string' && now - r.at < SHOW_FOR_MS)
    .sort((a, b) => b.at - a.at);
}

/** Remember a recording you were there for (once per id). */
export function rememberRecording(id, title) {
  if (!id) return;
  const list = listRecordings();
  if (list.some((r) => r.id === id)) return;
  list.unshift({ id, title: String(title ?? '').slice(0, 120), at: Date.now() });
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    // storage blocked (private mode…): it just won't be listed later
  }
}
