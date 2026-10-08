// Pre-join lobby, Google-Meet style: a live camera preview with mic/camera
// toggles, a mic level meter, device pickers and a speaker test, next to the
// room + name form. The choices made here (devices, mic/cam on or off) are
// handed to the call via onSubmit so the call opens exactly as previewed.

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Cam, CamOff, Mic, MicOff, Speaker } from './icons.jsx';
import AvatarPicker from './AvatarPicker.jsx';
import Select from './Select.jsx';
import useIsMobile from './useIsMobile.js';
import ThemeToggle from './ThemeToggle.jsx';
import Logo from './Logo.jsx';
import ProfileCard, { PROFILE } from './ProfileCard.jsx';

// A link with ?profile in it (https://your-site/?profile) opens the creator card.
const wantsProfile = () => new URLSearchParams(window.location.search).has('profile');
// The card pops up by itself only the first time a device opens the site —
// remembered in this browser's storage, so not again after refreshes or new
// meetings. (Storage can be blocked, e.g. private mode: then it falls back to
// once per page load.) The "Made by" credit and ?profile still open it.
const SEEN_KEY = 'listen.creatorCardSeen';
let profileShown = false;
function cardSeen() {
  if (profileShown) return true;
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}
function markCardSeen() {
  profileShown = true;
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // not remembered — it may pop up again on another visit
  }
}

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
  invited = false,
  name,
  title = '',
  avatar,
  error,
  note,
  onRoomId,
  onName,
  onTitle,
  onAvatar,
  onSubmit,
}) {
  const isMobile = useIsMobile();
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

  // Open the preview, and reopen it whenever a different device is picked —
  // or the camera is switched on / off. Off asks for no camera at all, so the
  // camera is released and its light goes out (not just a hidden picture).
  useEffect(() => {
    let cancelled = false;
    let opened = null;
    navigator.mediaDevices
      .getUserMedia({
        audio: audioId ? { deviceId: { exact: audioId } } : true,
        video: camOn ? (videoId ? { deviceId: { exact: videoId } } : true) : false,
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
  }, [audioId, videoId, camOn]);

  // Mic / camera toggles just enable/disable the preview tracks.
  useEffect(() => {
    stream?.getAudioTracks().forEach((t) => (t.enabled = micOn));
  }, [stream, micOn]);
  useEffect(() => {
    stream?.getVideoTracks().forEach((t) => (t.enabled = camOn));
  }, [stream, camOn]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, isMobile]);

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
  }, [stream, micOn, isMobile]);

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
  const [profileOpen, setProfileOpen] = useState(wantsProfile);
  // Auto pop-up: a short beat after the lobby appears, so the card rises in
  // over the page rather than flashing up with it.
  useEffect(() => {
    if (cardSeen()) return undefined;
    const t = setTimeout(() => setProfileOpen(true), 700);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (profileOpen) markCardSeen();
  }, [profileOpen]);
  function closeProfile() {
    setProfileOpen(false);
    // Drop ?profile so a reload doesn't pop the card open again.
    if (wantsProfile()) {
      const url = new URL(window.location.href);
      url.searchParams.delete('profile');
      window.history.replaceState(null, '', url);
    }
  }

  if (isMobile) {
    return (
      <main className="prejoin pjm">
        <div className="pjm-top">
          <button
            type="button"
            className="pjm-back"
            onClick={() => window.history.back()}
            aria-label="Back"
          >
            <ArrowLeft />
          </button>
          {/* the creator credit — opens the profile card */}
          <button type="button" className="pj-credit" onClick={() => setProfileOpen(true)}>
            <img src={PROFILE.photo} alt="" />
            <span>
              Made by <strong>{PROFILE.name}</strong>
            </span>
          </button>
        </div>
        {profileOpen && <ProfileCard onClose={closeProfile} />}

        <form className="pjm-body" onSubmit={handleSubmit}>
          <div className="pjm-preview">
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
                ) : avatar ? (
                  <img className="pj-initials" src={avatar} alt="" />
                ) : (
                  <span className="pj-initials">{initials(name)}</span>
                )}
              </div>
            )}
            <div className={`pjm-meter${micOn ? '' : ' off'}`} ref={meterRef} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>

          <div className="pjm-row">
            <button
              type="button"
              className={`pjm-round${camOn ? '' : ' off'}`}
              onClick={() => setCamOn((v) => !v)}
              disabled={!stream}
              aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
            >
              {camOn ? <Cam /> : <CamOff />}
            </button>
            <button
              type="button"
              className={`pjm-round${micOn ? '' : ' off'}`}
              onClick={() => setMicOn((v) => !v)}
              disabled={!stream}
              aria-label={micOn ? 'Turn microphone off' : 'Turn microphone on'}
            >
              {micOn ? <Mic /> : <MicOff />}
            </button>
            <button
              type="submit"
              className="pjm-join"
              // Whoever starts the meeting has to name it; invitees only need their name.
              disabled={!name.trim() || (!invited && !title.trim())}
            >
              Join
            </button>
          </div>

          <div className="pjm-fields">
            {/* An invite link already names the meeting — only the creator sets it. */}
            {!invited && (
              <input
                value={title}
                onChange={(e) => onTitle(e.target.value)}
                placeholder="Meeting name"
                aria-label="Meeting name"
                maxLength={80}
                autoComplete="off"
              />
            )}
            <input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              autoComplete="off"
            />
            <AvatarPicker name={name} avatar={avatar} onChange={onAvatar} />
          </div>
          {note && <p className="pj-note">{note}</p>}
          {error && <p className="err">{error}</p>}
        </form>

      </main>
    );
  }

  return (
    <main className="prejoin">
      <header className="pj-top">
        <Logo />
        <div className="pj-top-right">
          {/* the creator credit — opens the profile card */}
          <button type="button" className="pj-credit" onClick={() => setProfileOpen(true)}>
            <img src={PROFILE.photo} alt="" />
            <span>
              Made by <strong>{PROFILE.name}</strong>
            </span>
          </button>
          {/* light / dark switch, top-right of the lobby */}
          <ThemeToggle />
        </div>
      </header>
      {profileOpen && <ProfileCard onClose={closeProfile} />}

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
            <div className="pj-select">
              <Mic />
              <Select
                value={curAudio}
                onChange={setAudioId}
                options={devices.audioinput.map((d) => ({
                  value: d.deviceId,
                  label: d.label || 'Microphone',
                }))}
                disabled={!devices.audioinput.length}
                placeholder="Microphone"
                label="Microphone"
              />
            </div>

            <div className="pj-select">
              <Cam />
              <Select
                value={curVideo}
                onChange={setVideoId}
                options={devices.videoinput.map((d) => ({
                  value: d.deviceId,
                  label: d.label || 'Camera',
                }))}
                disabled={!devices.videoinput.length}
                placeholder="Camera"
                label="Camera"
              />
            </div>

            <div className="pj-select pj-speaker">
              <Speaker />
              {canPickSpeaker && devices.audiooutput.length > 0 ? (
                <Select
                  value={speakerId}
                  onChange={setSpeakerId}
                  options={[
                    { value: '', label: 'System default' },
                    ...devices.audiooutput
                      .filter((d) => d.deviceId !== 'default')
                      .map((d) => ({ value: d.deviceId, label: d.label || 'Speaker' })),
                  ]}
                  label="Speaker"
                />
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
          <p className="pj-sub">
            {invited
              ? 'You’ve been invited to a meeting. Check your camera and mic, then hop in.'
              : 'Check your camera and mic, then hop in.'}
          </p>

          {note && <p className="pj-note">{note}</p>}

          <form className="pj-form" onSubmit={handleSubmit}>
            {/* From an invite link the meeting is already chosen — no code box. */}
            {!invited && (
              <label>
                <span>Meeting code</span>
                <input
                  value={roomId}
                  onChange={(e) => onRoomId(e.target.value)}
                  placeholder="Leave empty to start a new meeting"
                  autoComplete="off"
                />
              </label>
            )}
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
            <button type="submit" className="pj-join" disabled={!name.trim()}>
              {roomId.trim() ? 'Join now' : 'Start a new meeting'}
            </button>
            {error && <p className="err">{error}</p>}
          </form>
        </section>
      </div>
    </main>
  );
}
