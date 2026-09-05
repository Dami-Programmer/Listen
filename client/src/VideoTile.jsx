// One video square in the call grid.
//
// React can't hand a MediaStream to a <video> through JSX — `srcObject` is a
// DOM-only property, not an HTML attribute — so we grab the element with a ref
// and assign it in an effect whenever the stream changes.

import { useEffect, useRef } from 'react';

/**
 * @param {object}      props
 * @param {MediaStream} props.stream   the stream to show
 * @param {string}      props.label    name shown in the corner
 * @param {boolean}    [props.muted]   mute THIS <video>'s audio (your own tile)
 * @param {boolean}    [props.mirror]  flip horizontally (your own webcam)
 * @param {string}     [props.role]    'host' | 'speaker' | 'listener' — corner pill
 * @param {boolean}   [props.speaking] this person is the room's active speaker (glow)
 */
export default function VideoTile({
  stream,
  label,
  muted = false,
  mirror = false,
  role,
  speaking = false,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream) el.srcObject = stream;
  }, [stream]);

  return (
    <div className={`tile${speaking ? ' speaking' : ''}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={mirror ? 'mirror' : undefined}
      />
      <span className="tile-label">{label}</span>
      {role && (
        <span className={`pill pill-${role} tile-role`}>{role === 'host' ? '★ host' : role}</span>
      )}
    </div>
  );
}
