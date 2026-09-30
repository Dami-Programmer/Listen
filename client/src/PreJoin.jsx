// Pre-join lobby, Google-Meet style: a live camera preview with mic/camera
// toggles, a mic level meter, device pickers and a speaker test, next to the
// room + name form. The choices made here (devices, mic/cam on or off) are
// handed to the call via onSubmit so the call opens exactly as previewed.

import { useEffect, useRef, useState } from 'react';
import { Cam, CamOff, Mic, MicOff, Speaker } from './icons.jsx';
import AvatarPicker from './AvatarPicker.jsx';

function friendlyMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera / microphone access is blocked. Allow it in the address bar, then reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'That camera or microphone isn’t available.';
    case 'NotReadableError':
      return 'Your camera or microphone is in use by another app.';
    default:
      return `Couldn’t start camera / microphone: ${err?.message || err?.name || err}`;
  }
}

function initials(name) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?'
  );
}

const canPickSpeaker =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export default function PreJoin({
  roomId,
  name,
  avatar,
  error,
  note,
  onRoomId,
  onName,
  onAvatar,
  onSubmit,
}) {
  const videoRef = useRef(null);
  const meterRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [mediaError, setMediaError] = useState(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [devices, setDevices] = useState({ audioinput: [], videoinput: [], audiooutput: [] });
  // '' = "whatever the browser picked"
  const [audioId, setAudioId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [speakerId, setSpeakerId] = useState('');
  const [testing, setTesting] = useState(false);

  // Open the preview, and reopen it whenever a different device is picked.
  useEffect(() => {
    let cancelled = false;
    let opened = null;
    navigator.mediaDevices
      .getUserMedia({
        audio: audioId ? { deviceId: { exact: audioId } } : true,
        video: videoId ? { deviceId: { exact: videoId } } : true,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        opened = s;
        setMediaError(null);
        setStream(s);
      })
      .catch((err) => {
        if (!cancelled) setMediaError(friendlyMediaError(err));
      });
    return () => {
      cancelled = true;
      opened?.getTracks().forEach((t) => t.stop());
    };
  }, [audioId, videoId]);

  // Mic / camera toggles just enable/disable the preview tracks.
  useEffect(() => {
    stream?.getAudioTracks().forEach((t) => (t.enabled = micOn));
  }, [stream, micOn]);
  useEffect(() => {
    stream?.getVideoTracks().forEach((t) => (t.enabled = camOn));
  }, [stream, camOn]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  // Device labels only show up once permission is granted, so list them after
  // the preview opens — and again whenever something is plugged in / out.
  useEffect(() => {
    if (!stream) return undefined;
    function refresh() {
      navigator.mediaDevices.enumerateDevices().then((list) => {
        const grouped = { audioinput: [], videoinput: [], audiooutput: [] };
        list.forEach((d) => grouped[d.kind]?.push(d));
        setDevices(grouped);
      });
    }
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [stream]);

  // Mic level meter: RMS of the waveform, written straight to a CSS variable
  // every frame (no React re-render per frame).
  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    const meter = meterRef.current;
    if (!track || !micOn || !meter) {
      meter?.style.setProperty('--level', 0);
      return undefined;
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      meter.style.setProperty('--level', level.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      ctx.close();
    };
  }, [stream, micOn]);

  // Play a short two-note chime through the chosen speaker.
  async function testSpeaker() {
    if (testing) return;
    setTesting(true);
    const ctx = new AudioContext();
    try {
      if (speakerId && ctx.setSinkId) await ctx.setSinkId(speakerId);
    } catch {
      // older browsers: plays on the default output instead
    }
    const t0 = ctx.currentTime;
    [523.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      const start = t0 + i * 0.35;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.62);
    });
    setTimeout(() => {
      ctx.close();
      setTesting(false);
    }, 1100);
  }

  // What's actually in use, for the selects and for handing to the call.
  const curAudio = audioId || stream?.getAudioTracks()[0]?.getSettings().deviceId || '';
  const curVideo = videoId || stream?.getVideoTracks()[0]?.getSettings().deviceId || '';

  function handleSubmit(e) {
    onSubmit(e, { audioId: curAudio, videoId: curVideo, speakerId, micOn, camOn });
  }

  const showVideo = stream && camOn;

  return (
    <main className="prejoin">
      <header className="pj-top">
        <img className="cs-logo" src="/logo.svg" alt="Listen" />
      </header>

      <div className="pj-body">
        <section className="pj-left">
          <div className="pj-preview">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`mirror${showVideo ? '' : ' pj-hidden'}`}
            />
            {!showVideo && (
              <div className="pj-placeholder">
                {mediaError ? (
                  <p className="pj-media-err">{mediaError}</p>
                ) : !stream ? (
                  <p>Starting camera…</p>
                ) : (
                  <>
                    {avatar ? (
                      <img className="pj-initials" src={avatar} alt="" />
                    ) : (
                      <span className="pj-initials">{initials(name)}</span>
                    )}
                    <p>Camera is off</p>
                  </>
                )}
              </div>
            )}

            <span className="pj-name-tag">{name.trim() || 'You'}</span>

            <div className={`pj-meter${micOn ? '' : ' off'}`} ref={meterRef} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>

            <div className="pj-toggles">
              <button
                type="button"
                className={micOn ? '' : 'off'}
                onClick={() => setMicOn((v) => !v)}
                disabled={!stream}
                aria-label={micOn ? 'Turn microphone off' : 'Turn microphone on'}
                title={micOn ? 'Turn microphone off' : 'Turn microphone on'}
              >
                {micOn ? <Mic /> : <MicOff />}
              </button>
              <button
                type="button"
                className={camOn ? '' : 'off'}
                onClick={() => setCamOn((v) => !v)}
                disabled={!stream}
                aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
                title={camOn ? 'Turn camera off' : 'Turn camera on'}
              >
                {camOn ? <Cam /> : <CamOff />}
              </button>
            </div>
          </div>

          <div className="pj-devices">
            <label className="pj-select" title="Microphone">
              <Mic />
              <select
                value={curAudio}
                onChange={(e) => setAudioId(e.target.value)}
                disabled={!devices.audioinput.length}
                aria-label="Microphone"
              >
                {devices.audioinput.length === 0 && <option value="">Microphone</option>}
                {devices.audioinput.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Microphone'}
                  </option>
                ))}
              </select>
            </label>

            <label className="pj-select" title="Camera">
              <Cam />
              <select
                value={curVideo}
                onChange={(e) => setVideoId(e.target.value)}
                disabled={!devices.videoinput.length}
                aria-label="Camera"
              >
                {devices.videoinput.length === 0 && <option value="">Camera</option>}
                {devices.videoinput.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Camera'}
                  </option>
                ))}
              </select>
            </label>

            <div className="pj-select pj-speaker" title="Speaker">
              <Speaker />
              {canPickSpeaker && devices.audiooutput.length > 0 ? (
                <select
                  value={speakerId}
                  onChange={(e) => setSpeakerId(e.target.value)}
                  aria-label="Speaker"
                >
                  <option value="">System default</option>
                  {devices.audiooutput
                    .filter((d) => d.deviceId !== 'default')
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || 'Speaker'}
                      </option>
                    ))}
                </select>
              ) : (
                <span className="pj-select-text">System default</span>
              )}
              <button type="button" className="pj-test" onClick={testSpeaker} disabled={testing}>
                {testing ? 'Playing…' : 'Test'}
              </button>
            </div>
          </div>
        </section>

        <section className="pj-right">
          <h1>Ready to join?</h1>
          <p className="pj-sub">Check your camera and mic, then hop in.</p>

          {note && <p className="pj-note">{note}</p>}

          <form className="pj-form" onSubmit={handleSubmit}>
            <label>
              <span>Meeting</span>
              <input
                value={roomId}
                onChange={(e) => onRoomId(e.target.value)}
                placeholder="e.g. design-sprint"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Your name</span>
              <input
                value={name}
                onChange={(e) => onName(e.target.value)}
                placeholder="e.g. Sam"
                autoComplete="off"
              />
            </label>
            <AvatarPicker name={name} avatar={avatar} onChange={onAvatar} />
            <button type="submit" className="pj-join" disabled={!roomId.trim() || !name.trim()}>
              Join now
            </button>
            {error && <p className="err">{error}</p>}
          </form>
        </section>
      </div>
    </main>
  );
}
