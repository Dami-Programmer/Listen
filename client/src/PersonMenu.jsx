// The ⋯ button on a row of the people pop-up (App.jsx), and the small menu
// it opens: the less-used actions for that person — Make cohost, Mute chat,
// Remove — so the row itself stays calm.
//
// items: [{ label, icon, onClick, danger }] — a `null` in the list draws a
// thin line between groups; `false` (from `cond && {…}`) is skipped. Lines
// only show between groups that still have something in them. Closes on a
// pick, a click outside, or Escape.

import { useEffect, useRef, useState } from 'react';
import { MoreDots } from './icons.jsx';

export default function PersonMenu({ label, items }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // On the last rows the menu would hang below the bottom of the scrolling
  // list, cut off. When it opens, scroll the list just enough to show all of
  // it (smoothly; nothing moves if it's already in view). Once more when its
  // grow-in animation ends: it starts a little smaller, so the first scroll
  // can stop a few pixels short.
  const listRef = useRef(null);
  const showList = () => listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  useEffect(() => {
    if (open) showList();
  }, [open]);

  // split at the nulls, drop empty groups, then join them back with a line
  const groups = [[]];
  items.forEach((it) => (it === null ? groups.push([]) : it && groups.at(-1).push(it)));
  const shown = groups.filter((g) => g.length).flatMap((g, i) => (i ? [null, ...g] : g));
  if (!shown.length) return null; // nothing to offer: no button

  return (
    <span className="pm" ref={rootRef}>
      <button
        type="button"
        ref={btnRef}
        className={`pp-icon${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title="More"
      >
        <MoreDots />
      </button>
      {open && (
        <div className="pm-list" role="menu" ref={listRef} onAnimationEnd={showList}>
          {shown.map((it, i) =>
            it ? (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={it.danger ? 'danger' : ''}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon}
                {it.label}
              </button>
            ) : (
              <hr key={`line-${i}`} />
            ),
          )}
        </div>
      )}
    </span>
  );
}
