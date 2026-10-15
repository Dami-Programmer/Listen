// Reactions: tap 👍 👏 🙏 … and it floats up from the bottom-left of
// everyone's screen with your name — a way to respond without unmuting or
// interrupting (handy for listeners in a moderated room).
//
//   <ReactionsLayer />     the floating ones, for everyone (EVENTS.REACTION)
//   <ReactionButton />     the 😊 button + its row of emojis (EVENTS.REACT)

import { useEffect, useRef, useState } from 'react';
import { EVENTS, REACTIONS } from '@listen/shared';
import { socket } from './socket.js';
import { Smile } from './icons.jsx';

// How long one floats before it's gone (matches the CSS animation), and how
// many may be on screen at once (a burst of 👏 shouldn't fill the screen).
const FLOAT_MS = 3200;
const MAX_ON_SCREEN = 12;

export function ReactionsLayer() {
  const [items, setItems] = useState([]); // { key, emoji, name, x }
  const seq = useRef(0);

  useEffect(() => {
    const onReaction = ({ emoji, name }) => {
      seq.current += 1;
      const key = seq.current;
      // A little sideways spread so a burst doesn't stack in one column.
      const x = Math.round(Math.random() * 60);
      setItems((list) => [...list, { key, emoji, name, x }].slice(-MAX_ON_SCREEN));
      setTimeout(() => setItems((list) => list.filter((i) => i.key !== key)), FLOAT_MS);
    };
    socket.on(EVENTS.REACTION, onReaction);
    return () => socket.off(EVENTS.REACTION, onReaction);
  }, []);

  return (
    <div className="reactions-layer" aria-hidden="true">
      {items.map((i) => (
        <span key={i.key} className="reaction-float" style={{ '--x': `${i.x}px` }}>
          <span className="reaction-emoji">{i.emoji}</span>
          <span className="reaction-name">{i.name}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * @param {string} [props.className]  the button's class (fits the bar it's in)
 * @param {'up'|'down'} [props.opens] which way the emoji row opens
 */
export function ReactionButton({ className = '', opens = 'up' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Tap anywhere else (or Esc) closes the row.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const send = (emoji) => {
    socket.emit(EVENTS.REACT, { emoji });
    setOpen(false);
  };

  return (
    <span className="reaction-wrap" ref={rootRef}>
      <button
        type="button"
        className={`${className}${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Send a reaction"
        title="Send a reaction"
      >
        <Smile />
      </button>
      {open && (
        <div className={`reaction-row opens-${opens}`} role="menu" aria-label="Reactions">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              className="reaction-pick"
              onClick={() => send(emoji)}
              aria-label={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
