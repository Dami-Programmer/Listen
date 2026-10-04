// The sun / moon / screen button that switches between light and dark.
//
// Each click moves to the next choice:
//   screen (match device) → sun (light) → moon (dark) → screen …
// The icon shows the CURRENT choice; the tooltip says what it is and what the
// next click does. The work itself lives in theme.js.
//
// Used in the lobby header (PreJoin.jsx) and the call header (App.jsx). Only
// one is ever on screen, and each reads the saved choice when it appears, so
// the two always agree.

import { useTheme } from './theme.js';
import { Monitor, Moon, Sun } from './icons.jsx';

// What each choice looks like, and what the next click switches to.
const LOOK = {
  system: { Icon: Monitor, label: 'Theme: match device', next: 'light' },
  light: { Icon: Sun, label: 'Theme: light', next: 'dark' },
  dark: { Icon: Moon, label: 'Theme: dark', next: 'match device' },
};

export default function ThemeToggle() {
  const [choice, cycle] = useTheme();
  const { Icon, label, next } = LOOK[choice];

  return (
    <button
      type="button"
      className="theme-btn"
      onClick={cycle}
      title={`${label} — click for ${next}`}
      aria-label={`${label}. Click to switch to ${next}.`}
    >
      {/* key = the choice, so React swaps in a fresh icon each change and the
          spin-in animation in index.css plays again */}
      <Icon key={choice} />
    </button>
  );
}
