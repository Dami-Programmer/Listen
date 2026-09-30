// Inline line icons for the dark call screen — one stroke weight, currentColor.
// Kept minimal: only the icons the current screen actually uses.

const s = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export const Mic = (p) => (
  <svg {...s} {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
  </svg>
);

export const MicOff = (p) => (
  <svg {...s} {...p}>
    <path d="M15 5a3 3 0 0 0-6 0v5m0 2.5a3 3 0 0 0 4.7 1.4" />
    <path d="M5.5 11a6.5 6.5 0 0 0 10.9 4.9M18.5 11M12 17.5V21M8.5 21h7M3 3l18 18" />
  </svg>
);

export const Cam = (p) => (
  <svg {...s} {...p}>
    <rect x="2.5" y="6" width="13" height="12" rx="3" />
    <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
  </svg>
);

export const CamOff = (p) => (
  <svg {...s} {...p}>
    <path d="M15.5 10.5 21 7.5v9l-5.5-3" />
    <path d="M2.5 9v6a3 3 0 0 0 3 3h7a3 3 0 0 0 2.5-1.4M15.5 8.3A3 3 0 0 0 12.5 6H8" />
    <path d="m3 3 18 18" />
  </svg>
);

export const Phone = (p) => (
  <svg {...s} {...p}>
    <path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
  </svg>
);

export const Screen = (p) => (
  <svg {...s} {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

// Four equal squares — switch to the equal-tile grid view.
export const GridView = (p) => (
  <svg {...s} {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.8" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8" />
  </svg>
);

// One big frame with a small one in its corner — switch back to spotlight.
export const SpotlightView = (p) => (
  <svg {...s} {...p}>
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <rect x="13" y="13" width="6" height="4.5" rx="1" />
  </svg>
);

export const Check = (p) => (
  <svg {...s} {...p}>
    <path d="m4 12 5 5L20 6" />
  </svg>
);

export const X = (p) => (
  <svg {...s} {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const Lock = (p) => (
  <svg {...s} {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
  </svg>
);

export const Unlock = (p) => (
  <svg {...s} {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7.5a4 4 0 0 1 7.75-1.4" />
  </svg>
);

export const LinkIcon = (p) => (
  <svg {...s} {...p}>
    <path d="M10 14a4.5 4.5 0 0 0 6.36 0l3.18-3.18a4.5 4.5 0 0 0-6.36-6.36L11.6 6.04" />
    <path d="M14 10a4.5 4.5 0 0 0-6.36 0l-3.18 3.18a4.5 4.5 0 0 0 6.36 6.36l1.58-1.58" />
  </svg>
);

export const Copy = (p) => (
  <svg {...s} {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </svg>
);

export const ChatBubble = (p) => (
  <svg {...s} {...p}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z" />
  </svg>
);

// The brand mark — soundwave bars, not a stroke icon so it skips `s`.
export const Wave = (p) => (
  <svg width="28" height="24" viewBox="0 0 28 24" fill="none" {...p}>
    <rect x="0" y="9" width="5" height="10" rx="2.5" fill="#3B6FC9" />
    <rect x="7.5" y="2" width="5" height="20" rx="2.5" fill="#3E7FD6" />
    <rect x="15" y="5" width="5" height="17" rx="2.5" fill="#7FC9E8" />
    <rect x="22.5" y="0" width="5" height="19" rx="2.5" fill="#4FB8E8" />
  </svg>
);

export const Hand = (p) => (
  <svg {...s} {...p}>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 14.3a1.5 1.5 0 0 1 2.4-1.8L8 15" />
  </svg>
);

// --- chat panel icons ------------------------------------------------------

// Two people — the "who's here" dropdown button at the top of the chat panel.
export const People = (p) => (
  <svg {...s} {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
  </svg>
);

// Small "v" — marks something as a dropdown.
export const ChevronDown = (p) => (
  <svg {...s} {...p}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// Picture frame — the "attach a photo or file" button in the composer.
export const ImageIcon = (p) => (
  <svg {...s} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="9" cy="9" r="1.8" />
    <path d="m21 15-4.5-4.5L6 21" />
  </svg>
);

// Paperclip — the "send a file" button (any file type).
export const Paperclip = (p) => (
  <svg {...s} {...p}>
    <path d="m20.5 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.8-8.8a3.4 3.4 0 0 1 4.8 4.8l-8.8 8.8a1.7 1.7 0 0 1-2.4-2.4l8-8" />
  </svg>
);

// Arrow into a tray — download.
export const Download = (p) => (
  <svg {...s} {...p}>
    <path d="M12 3.5v12M7 11l5 5 5-5" />
    <path d="M4 17.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-1.5" />
  </svg>
);

// Pencil — edit one of your messages.
export const Pencil = (p) => (
  <svg {...s} {...p}>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z" />
    <path d="m14.5 5.5 3 3" />
  </svg>
);

// Trash can — unsend one of your messages.
export const Trash = (p) => (
  <svg {...s} {...p}>
    <path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

// Smiley — opens the emoji / sticker picker.
export const Smile = (p) => (
  <svg {...s} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" />
  </svg>
);

// Paper plane — send.
export const Send = (p) => (
  <svg {...s} {...p}>
    <path d="M21 3 10.5 13.5" />
    <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
  </svg>
);

// Document with a folded corner — a (non-image) file attachment.
export const FileDoc = (p) => (
  <svg {...s} {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </svg>
);

// A "T" — shown next to "<name> is typing...".
export const TypeT = (p) => (
  <svg {...s} {...p}>
    <path d="M5 5h14M12 5v14M9.5 19h5" />
  </svg>
);

export const Speaker = (p) => (
  <svg {...s} {...p}>
    <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4Z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </svg>
);
