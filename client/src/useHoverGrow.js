// Buttons that grow a little as the mouse passes over them — the desktop
// call screen's control pill (App.jsx), like the landing page's dock but
// growing IN PLACE: no sliding up, nothing moves sideways.
//
// The button under the mouse grows the most (MAX_GROW); its neighbours a bit
// less, fading smoothly to normal size REACH px away. It sets a --grow number
// on each button; the CSS does the scaling (index.css, "control pill"), so the
// press-down effect still works on top of it.
//
// Use: `const pillRef = useHoverGrow();` then `<div ref={pillRef}>`. It's a
// "callback ref": React calls it with the element whenever the pill appears
// (and with null when it goes) — so it works even though the call screen
// shows other things first (the lobby, the phone layout…) and the pill only
// turns up later.
//
// Mouse / trackpad only, and not for people who ask for less motion.

import { useCallback, useRef } from 'react';

const MAX_GROW = 1.25; // the button right under the mouse
const REACH = 100; // px from the mouse where buttons are back to normal

// The pill's own buttons — not the ^ device carets, and not anything inside
// a pop-up (device list, reaction choices).
const BUTTONS =
  ':scope > button, :scope > .dp > button:not(.dp-caret), :scope > .reaction-wrap > button';

/** @returns {(el: HTMLElement | null) => void}  the ref to put on the pill */
export function useHoverGrow() {
  const cleanup = useRef(null); // un-hooks the pill we're attached to, if any

  return useCallback((pill) => {
    cleanup.current?.(); // a different pill (or none): let go of the old one
    cleanup.current = null;
    const can = window.matchMedia?.('(hover: hover) and (prefers-reduced-motion: no-preference)');
    if (!pill || !can?.matches) return;

    let frame = 0;
    let mouseX = 0;
    const apply = () => {
      frame = 0;
      for (const b of pill.querySelectorAll(BUTTONS)) {
        const r = b.getBoundingClientRect();
        // how far its centre is from the mouse (it grows from its centre, so
        // the centre stays put however big it is right now)
        const d = Math.abs(mouseX - (r.left + r.width / 2));
        const grow =
          d >= REACH ? 1 : 1 + (MAX_GROW - 1) * (0.5 + 0.5 * Math.cos((Math.PI * d) / REACH));
        b.style.setProperty('--grow', grow.toFixed(3));
      }
    };
    const onMove = (e) => {
      mouseX = e.clientX;
      if (!frame) frame = requestAnimationFrame(apply); // at most once a frame
    };
    const onLeave = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      for (const b of pill.querySelectorAll(BUTTONS)) b.style.removeProperty('--grow');
    };
    pill.addEventListener('pointermove', onMove);
    pill.addEventListener('pointerleave', onLeave);
    cleanup.current = () => {
      cancelAnimationFrame(frame);
      pill.removeEventListener('pointermove', onMove);
      pill.removeEventListener('pointerleave', onLeave);
    };
  }, []);
}
