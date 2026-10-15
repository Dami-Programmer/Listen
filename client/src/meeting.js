// Meeting codes and invite links.

import { looksLikeName } from './roomNames.js';

// A fresh, unguessable meeting code in the Google-Meet shape: "kqa-mzpt-xhe".
// 10 random letters = 26^10 (~1.4e14) codes, so two new meetings never clash
// in practice.
export function newMeetingCode() {
  const letters = crypto.getRandomValues(new Uint8Array(10));
  const code = Array.from(letters, (n) => String.fromCharCode(97 + (n % 26))).join('');
  return `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}

// The link that opens the lobby straight into this meeting. A fixed room
// (a claimed name — roomNames.js) gets its short form: turnly.io/gracechurch.
export function inviteLink(roomId) {
  if (looksLikeName(roomId)) return `${window.location.origin}/${roomId}`;
  const url = new URL('/', window.location.origin); // not /start — tidier links
  url.searchParams.set('room', roomId);
  return url.href;
}

// The page where a meeting's recording can be watched (?rec=<id>).
export function recordingLink(id) {
  const url = new URL('/', window.location.origin); // not /start — tidier links
  url.searchParams.set('rec', id);
  return url.href;
}
