// A single video surface: shows the stream, or an initials avatar when there's
// no live video (camera off, or the peer connection isn't up yet). Overlays
// (name label, mic badge, controls) are positioned by the parent.

import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';

export default function VideoTile({
  stream,
  name,
  muted = false,
  mirror = false,
  speaking = false,
  avatarSize = 88,
}) {
  const videoRef = useRef(null);
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream) el.srcObject = stream;

    const track = stream?.getVideoTracks?.()[0] ?? null;
    const check = () =>
      setHasVideo(Boolean(track && track.enabled && track.readyState === 'live'));
    check();
    if (!track) return undefined;

    track.addEventListener('ended', check);
    track.addEventListener('mute', check);
    track.addEventListener('unmute', check);
    const poll = setInterval(check, 700); // track.enabled flips fire no event
    return () => {
      clearInterval(poll);
      track.removeEventListener('ended', check);
      track.removeEventListener('mute', check);
      track.removeEventListener('unmute', check);
    };
  }, [stream]);

  return (
    <div className={`tile${speaking ? ' speaking' : ''}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`${mirror ? 'mirror ' : ''}${hasVideo ? '' : 'is-hidden'}`}
      />
      {!hasVideo && (
        <div className="tile-fallback">
          <Avatar name={name} size={avatarSize} />
        </div>
      )}
    </div>
  );
}
