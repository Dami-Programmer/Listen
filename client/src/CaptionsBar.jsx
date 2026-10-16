// What live captions look like (the logic is in captions.js): a strip of the
// latest lines — "Ada  so I think we should…" — and the CC icon for the
// button that switches them on. Used by the desktop call screen (App.jsx)
// and the phone one (MobileCall.jsx).

import { canTranscribe } from './captions.js';

/** "CC" in a rounded box — the usual captions symbol. */
export function CcIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <rect
        x="2.5"
        y="5"
        width="19"
        height="14"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <text
        x="12"
        y="15.2"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="currentColor"
      >
        CC
      </text>
    </svg>
  );
}

/**
 * The captions strip. `lines`: from useCaptionLines (my own words show as
 * "You"). Before anyone has spoken, a short hint instead.
 */
export function CaptionsBar({ lines, selfId, phone = false }) {
  return (
    // aria-live: screen readers read new captions out as they arrive
    <div className={`captions${phone ? ' phone' : ''}`} aria-live="polite" aria-label="Captions">
      {lines.length ? (
        lines.map((l) => (
          <p key={l.id} className={l.final ? 'final' : ''}>
            <b>{l.id === selfId ? 'You' : l.name}</b> {l.text}
          </p>
        ))
      ) : (
        <p className="captions-hint">
          Captions show here when someone speaks.
          {!canTranscribe &&
            ' (This browser can’t caption your own voice, but you’ll see others’.)'}
        </p>
      )}
    </div>
  );
}
