// Inline line icons — one stroke weight, currentColor.

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

export const Hand = (p) => (
  <svg {...s} {...p}>
    <path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11m0-.5V4a1.5 1.5 0 0 1 3 0v6.5m0-.5V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7 7 7 0 0 1-5.8-3.1l-1.5-2.2a1.6 1.6 0 0 1 2.5-2l1.3 1.4V8a1.5 1.5 0 0 1 3 0v3" />
  </svg>
);

export const Send = (p) => (
  <svg {...s} {...p}>
    <path d="M4 12 20 4l-6 16-3.5-6.5L4 12Z" />
  </svg>
);

export const Smile = (p) => (
  <svg {...s} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
  </svg>
);

export const Paperclip = (p) => (
  <svg {...s} {...p}>
    <path d="M20 11.5 12.5 19a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.2-2.1l7.3-7.3" />
  </svg>
);

export const Sticker = (p) => (
  <svg {...s} {...p}>
    <path d="M20 12A8 8 0 1 0 12 20h1l6-6z" />
    <path d="M13 20v-4a3 3 0 0 1 3-3h4" />
  </svg>
);

export const Chevron = (p) => (
  <svg {...s} {...p}>
    <path d="m9 5 7 7-7 7" />
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
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
  </svg>
);

export const Unlock = (p) => (
  <svg {...s} {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7a4 4 0 0 1 7.7-1.5" />
  </svg>
);
