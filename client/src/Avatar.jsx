// Initials on a deterministic pastel disc — no photos, no dependency.
// Same name always gets the same colour.

const PALETTE = [
  ['#dfe7c8', '#4b5a1f'],
  ['#f6d7c4', '#7a3b1e'],
  ['#cfe0f2', '#254a73'],
  ['#f3cede', '#7a2f56'],
  ['#c9e6df', '#1f5049'],
  ['#e6d6f2', '#4a2f66'],
  ['#f5e0b8', '#6b4a15'],
  ['#d5dbe6', '#33405a'],
];

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h << 5) - h + str.charCodeAt(i);
  return Math.abs(h);
}

function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({ name, size = 36, className = '' }) {
  const [bg, fg] = PALETTE[hash(name || '') % PALETTE.length];
  return (
    <span
      className={`avatar ${className}`}
      style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
