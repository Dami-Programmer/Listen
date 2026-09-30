// Meeting codes and invite links.

// A fresh, unguessable meeting code in the Google-Meet shape: "kqa-mzpt-xhe".
// 10 random letters = 26^10 (~1.4e14) codes, so two new meetings never clash
// in practice.
export function newMeetingCode() {
  const letters = crypto.getRandomValues(new Uint8Array(10));
  const code = Array.from(letters, (n) => String.fromCharCode(97 + (n % 26))).join('');
  return `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}

// The link that opens the lobby straight into this meeting.
export function inviteLink(roomId) {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('room', roomId);
  return url.href;
}
