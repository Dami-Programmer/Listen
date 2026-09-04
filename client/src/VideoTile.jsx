// One video square in the call grid.
//
// React can't hand a MediaStream to a <video> through JSX — `srcObject` is a
// DOM-only property, not an HTML attribute — so we grab the element with a ref
// and assign it in an effect whenever the stream changes.

import { useEffect, useRef } from 'react';

export default function VideoTile({ stream, label, muted = false, mirror = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream) el.srcObject = stream;
  }, [stream]);

  return (
    <div className="tile">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={mirror ? 'mirror' : undefined}
      />
      <span className="tile-label">{label}</span>
    </div>
  );
}
