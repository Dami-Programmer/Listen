// confirmDialog() — the in-app replacement for window.confirm(). The dialog
// itself is drawn by <ConfirmHost/> (ConfirmDialog.jsx), rendered once in
// <App/>; this file is the function you call from anywhere:
//
//   if (!(await confirmDialog({ title: 'Remove Ada?', confirmLabel: 'Remove', danger: true }))) return;
//
// (Its own file, not inside ConfirmDialog.jsx, so that file only exports
// components — which keeps instant reload working while developing.)

let openDialog = null; // set by <ConfirmHost/> while it's mounted

/** <ConfirmHost/> hands over how to open it (null when it unmounts). */
export function setDialogOpener(fn) {
  openDialog = fn;
}

/**
 * @param {object}  opts
 * @param {string}  opts.title                 the question, e.g. "Remove Ada from the call?"
 * @param {string} [opts.message]              one line of detail under the title
 * @param {string} [opts.confirmLabel='OK']    the confirm button's text
 * @param {string} [opts.cancelLabel='Cancel']
 * @param {boolean}[opts.danger]               red confirm button, for destructive actions
 * @param {{name: string, avatar?: string}} [opts.person]  shows their avatar at the top
 * @returns {Promise<boolean>} true = confirmed; false = Cancel, Esc or a click outside
 */
export function confirmDialog(opts) {
  // Fall back to the browser's own if the host isn't mounted for some reason.
  if (!openDialog) return Promise.resolve(window.confirm(opts.title));
  return new Promise((resolve) => openDialog({ ...opts, resolve }));
}
