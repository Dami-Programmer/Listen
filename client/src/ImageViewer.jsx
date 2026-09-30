// Full-screen image viewer (a "lightbox") for images sent in chat.
//
// Clicking a chat image opens this: the picture zooms in to the middle of the
// screen while everything behind it darkens and blurs. Clicking anywhere (the
// picture included) or pressing Esc zooms it back out, then it closes — except
// the Download button in the top-right corner, which saves the image and
// leaves the viewer open.
//
// How the zoom-OUT works: we can't just unmount on click — the element would
// vanish instantly with no animation. So a click only sets `closing`, which
// swaps the CSS animations to their reverse versions. When the backdrop's
// closing animation finishes (`onAnimationEnd`), we call `onClose` and the
// parent actually removes us.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download } from './icons.jsx';

/**
 * @param {object}   props
 * @param {string}   props.src      the image URL (a data: URL from chat)
 * @param {string}  [props.alt]     description / file name, for screen readers
 * @param {Function} props.onClose  called once the zoom-out has finished
 */
export default function ImageViewer({ src, alt = 'Image', onClose }) {
  // false = open (or zooming in), true = zooming out, about to close.
  const [closing, setClosing] = useState(false);

  // Esc closes too — the keyboard equivalent of clicking away.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') setClosing(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // createPortal draws this straight into <body> instead of inside the chat
  // panel. That way it covers the WHOLE app and the picture sits in the true
  // middle of the screen, not the middle of the narrow chat column.
  return createPortal(
    <div
      className={`img-viewer${closing ? ' closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      // One click handler on the backdrop catches clicks on the picture as
      // well (the click bubbles up from the <img>), so "click the image or
      // anywhere" both close it.
      onClick={() => setClosing(true)}
      onAnimationEnd={(e) => {
        // The <img>'s animation-end event bubbles up here too — only react to
        // the backdrop's own one, and only when we're on the way out.
        if (closing && e.target === e.currentTarget) onClose();
      }}
    >
      <img className="img-viewer-img" src={src} alt={alt} />

      {/* Download, top-right. `alt` is the file name, so the saved file keeps
          its original name. stopPropagation stops this click from bubbling
          up to the backdrop — otherwise saving would also close the viewer. */}
      <a
        className="img-viewer-dl"
        href={src}
        download={alt}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Download ${alt}`}
      >
        <Download />
        Download
      </a>
    </div>,
    document.body,
  );
}
