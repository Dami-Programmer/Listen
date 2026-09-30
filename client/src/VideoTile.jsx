// One video surface — a camera tile in the grid, or (screen=true) a bigger
// let-boxed screen-share panel.
//
// React can't hand a MediaStream to a <video> through JSX — `srcObject` is a
// DOM-only property, not an HTML attribute — so we grab the element with a ref
// and assign it in an effect whenever the stream changes.

import { useEffect, useRef } from 'react';
import { MicOff } from './icons.jsx';

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
 * @param {boolean}    [props.screen]   this is a screen share — bigger, 16:9,
 *                                      picture let-boxed, no mirror / role pill
 * @param {string}     [props.sinkId]   audio output device id (speaker choice)
 * @param {boolean}    [props.micOff]   this person's mic is off — show a small
 *                                      crossed-out mic badge in the corner.
 *                                      (Different from `muted`, which only
 *                                      silences this <video> element locally.)
 */
export default function VideoTile({
  stream,
  label,
  muted = false,
  mirror = false,
  role,
  speaking = false,
  screen = false,
  sinkId,
  micOff = false,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream) el.srcObject = stream;
  }, [stream]);

  // Play this tile's audio through the speaker picked in the pre-join lobby.
  useEffect(() => {
    const el = videoRef.current;
    if (el && sinkId && el.setSinkId) el.setSinkId(sinkId).catch(() => {});
  }, [sinkId]);

  return (
    <div className={`tile${speaking ? ' speaking' : ''}${screen ? ' tile-screen' : ''}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={mirror && !screen ? 'mirror' : undefined}
      />
      <span className="tile-label">{label}</span>
      {/* Mute badge — only on camera tiles; a screen share has no mic. */}
      {micOff && !screen && (
        <span className="tile-mic-off" title={`${label} is muted`}>
          <MicOff />
        </span>
      )}
      {role && !screen && (
        <span className={`pill pill-${role} tile-role`}>{role === 'host' ? '★ host' : role}</span>
      )}
    </div>
  );
}
