// The "Strong noise reduction" switch, at the bottom of the microphone list
// (desktop mic menu and the phone's), and the little badge that shows it's
// on. See noiseReduction.js for what it does.

import { Sparkle } from './icons.jsx';

/**
 * The "noise reduction is on" sign: a small green sparkle on the corner of
 * the mic button (desktop control bar and the phone's dial). Decorative — the
 * mic button's own label / tooltip says "Noise reduction on" in words.
 * Its look is in index.css (.nr-badge).
 */
export function NoiseBadge() {
  return (
    <span className="nr-badge" aria-hidden="true">
      <Sparkle />
    </span>
  );
}

/**
 * @param {boolean}  props.on
 * @param {Function} props.onChange  (on) => void
 */
export default function NoiseToggle({ on, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`noise-toggle${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="noise-text">
        <b>Strong noise reduction</b>
        <small>Removes typing, traffic, crying babies and chatter around you.</small>
      </span>
      <span className="noise-switch" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}
