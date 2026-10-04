// In-app replacement for window.confirm() — a centered card over a dimmed,
// blurred backdrop, styled to match the rest of the app (and both themes).
//
// Usage, from anywhere:
//
//   if (!(await confirmDialog({ title: 'Remove Ada?', confirmLabel: 'Remove', danger: true }))) return;
//
// confirmDialog() returns a Promise that resolves true (confirmed) or false
// (Cancel, Esc, or a click on the backdrop). <ConfirmHost/> is rendered once
// in <App/> and draws whichever dialog is currently open.
//
// Closing animates out the same way the image viewer does: the click only
// sets `closing`, and the backdrop's animationend actually unmounts it.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar.jsx';

let openDialog = null; // set by <ConfirmHost/> while it's mounted

/**
 * @param {object}  opts
 * @param {string}  opts.title                 the question, e.g. "Remove Ada from the call?"
 * @param {string} [opts.message]              one line of detail under the title
 * @param {string} [opts.confirmLabel='OK']    the confirm button's text
 * @param {string} [opts.cancelLabel='Cancel']
 * @param {boolean}[opts.danger]               red confirm button, for destructive actions
 * @param {{name: string, avatar?: string}} [opts.person]  shows their avatar at the top
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  // Fall back to the browser's own if the host isn't mounted for some reason.
  if (!openDialog) return Promise.resolve(window.confirm(opts.title));
  return new Promise((resolve) => openDialog({ ...opts, resolve }));
}

export function ConfirmHost() {
  const [dialog, setDialog] = useState(null);
  const [closing, setClosing] = useState(false);
  const answer = useRef(false);
  const confirmBtn = useRef(null);

  useEffect(() => {
    openDialog = (d) => {
      answer.current = false;
      setClosing(false);
      setDialog((prev) => {
        prev?.resolve(false); // a new dialog replaces an unanswered one
        return d;
      });
    };
    return () => {
      openDialog = null;
    };
  }, []);

  function close(result) {
    answer.current = result;
    setClosing(true);
  }

  useEffect(() => {
    if (!dialog) return undefined;
    confirmBtn.current?.focus();
    function onKey(e) {
      if (e.key === 'Escape') close(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  if (!dialog) return null;
  const { title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger, person } = dialog;

  return createPortal(
    <div
      className={`confirm-backdrop${closing ? ' closing' : ''}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
      onAnimationEnd={(e) => {
        if (!closing || e.target !== e.currentTarget) return;
        dialog.resolve(answer.current);
        setDialog(null);
        setClosing(false);
      }}
    >
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={message ? 'confirm-msg' : undefined}
      >
        {person && (
          <Avatar name={person.name} src={person.avatar} size={56} className="confirm-avatar" />
        )}
        <h2 id="confirm-title" className="confirm-title">
          {title}
        </h2>
        {message && (
          <p id="confirm-msg" className="confirm-msg">
            {message}
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" className="confirm-btn cancel" onClick={() => close(false)}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmBtn}
            className={`confirm-btn ${danger ? 'danger' : 'primary'}`}
            onClick={() => close(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
