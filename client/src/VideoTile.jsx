// One video square in the call grid.
//
// React can't hand a MediaStream to a <video> through JSX — `srcObject` is a
// DOM-only property, not an HTML attribute — so we grab the element with a ref
// and assign it in an effect whenever the stream changes.

import { useEffect, useRef } from 'react';

/**
 * @param {object}       props
 * @param {MediaStream}  props.stream   the stream to show
 * @param {string}       props.label    name shown in the corner
 * @param {boolean}     [props.muted]   mute THIS <video> element's audio.
 *                                      Always true for your own tile, or you
 *                                      hear yourself echo.
 * @param {boolean}     [props.mirror]  flip horizontally (feels natural for
 *                                      your own webcam preview)
 * @param {string}      [props.role]    'host' | 'speaker' | 'listener' — shows a
 *                                      small pill in the corner (Phase 3)
 * @param {boolean}    [props.speaking] this person is the room's active speaker
 *                                      right now — draw the glow (Phase 6)
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
