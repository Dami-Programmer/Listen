// Google-Meet-style device picker: a small ^ button joined onto the left of
// the mic (or camera) button in the controls bar. It opens a rounded list
// above, with every mic (or camera) and a check on the one in use. Picking
// one swaps it into the live call (useCall's switchDevice) — nobody
// reconnects, and mute / camera-off carry over.
//
//   <DevicePicker kind="audio" ...>{the mic button}</DevicePicker>

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from './icons.jsx';

const KINDS = {
  audio: { list: 'audioinput', label: 'Microphone' },
  video: { list: 'videoinput', label: 'Camera' },
};

export default function DevicePicker({ kind, current, onSwitch, children }) {
  const { list: listKind, label } = KINDS[kind];
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState([]);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const caretRef = useRef(null);

  // List devices while open, and again if something is plugged in or out.
  useEffect(() => {
    if (!open) return undefined;
    function refresh() {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === listKind)));
    }
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [open, listKind]);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !rootRef.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      caretRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function pick(deviceId) {
    setOpen(false);
    if (deviceId === current) return;
    setBusy(true);
    try {
      await onSwitch(kind, deviceId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`dp${open ? ' open' : ''}`} ref={rootRef}>
      <button
        ref={caretRef}
        className="dp-caret"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Choose ${label.toLowerCase()}`}
        title={busy ? 'Switching…' : `Choose ${label.toLowerCase()}`}
      >
        <ChevronDown />
      </button>
      {children}

      {open && (
        <div className="dp-pop" role="listbox" aria-label={label}>
          <p className="dp-title">{label}</p>
          {devices.length === 0 && <p className="dp-empty">No {label.toLowerCase()} found</p>}
          {/* Every entry, "Default - …" included: a device opened without a
              choice reports its deviceId as "default". */}
          {devices.map((d) => (
            <button
              key={d.deviceId}
              role="option"
              aria-selected={d.deviceId === current}
              className={`dp-option${d.deviceId === current ? ' selected' : ''}`}
              onClick={() => pick(d.deviceId)}
              title={d.label || label}
            >
              <span>{d.label || label}</span>
              {d.deviceId === current && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
