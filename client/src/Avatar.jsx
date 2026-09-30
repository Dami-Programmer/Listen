// A round avatar: the person's initials on a colored circle, with an optional
// status dot in the bottom-right corner.
//
// A picture (`src`, picked in the pre-join lobby) replaces the initials when
// there is one; if it fails to load, the initials show instead.
// Each person's color is picked from their NAME, not at random — so "Ada"
// gets the same color on every screen and on every render, without anyone
// having to store or send a color.
//
import { useState } from 'react';

// The dot shows mic state: green = mic on, red = muted. (Pass `status` as
// undefined to hide the dot, e.g. for someone who has left the call.)

// A handful of saturated colors that all read well with white text on the
// dark call screen. The pink matches the "MY" avatar in the design.
const COLORS = ['#e8358a', '#7c5cff', '#1f9bd1', '#12a37f', '#e0892b', '#d6455d', '#5b7cfa'];

// Turn a name into a stable index into COLORS. Same name in -> same color out,
// every time. Multiplying by 31 at each step (a classic string hash) makes
// the ORDER of letters matter, so similar names like "May Jona" and
// "Christiana Jona" usually land on different colors — a plain sum of letter
// codes lumped too many names together.
function colorFor(name = '') {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0; // >>> 0 keeps it a positive 32-bit int
  return COLORS[hash % COLORS.length];
}

// "May Jona" -> "MJ", "ada" -> "AD", "" -> "?".
function initialsOf(name = '') {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * @param {object}  props
 * @param {string}  props.name      whose avatar this is (drives initials + color)
 * @param {number} [props.size=38]  diameter in px
 * @param {'on'|'off'} [props.status] mic state for the corner dot; omit to hide it
 * @param {string} [props.src]        profile picture URL; omit for initials
 * @param {string} [props.className]  extra classes (e.g. for positioning)
 */
export default function Avatar({ name, size = 38, status, src, className = '' }) {
  // Remember which src failed, so a new picture gets a fresh try.
  const [broken, setBroken] = useState(null);
  const showImg = src && broken !== src;
  return (
    <span
      className={`avatar ${className}`}
      // Size + color are per-avatar, so they're set inline; everything that's
      // the same for every avatar lives in the `.avatar` CSS rule.
      style={{
        width: size,
        height: size,
        background: colorFor(name),
        fontSize: Math.round(size * 0.34),
      }}
      title={name}
      aria-label={name}
    >
      {showImg ? (
        <img className="avatar-img" src={src} alt="" onError={() => setBroken(src)} />
      ) : (
        initialsOf(name)
      )}
      {status && (
        <span
          className={`avatar-dot ${status === 'on' ? 'on' : 'off'}`}
          aria-label={status === 'on' ? 'mic on' : 'muted'}
        />
      )}
    </span>
  );
}
