// The "Strong noise reduction" switch, at the bottom of the microphone list
// (desktop mic menu and the phone's). See noiseReduction.js for what it does.

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
