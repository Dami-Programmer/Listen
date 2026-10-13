// Recording the meeting — the browser side.
//
// One person's browser is "the recorder" (the server picks it: see
// EVENTS.REC_START). While it is, this draws the meeting into one video —
// everyone's camera in a grid (a name + initials while a camera is off), or a
// screen share with the speaker in the corner — mixes everyone's sound into
// one track, records both with the browser's own recorder (MediaRecorder),
// and sends the result to the server a second at a time (EVENTS.REC_CHUNK).
// The server saves it (R2). If this person stops being the recorder (they
// leave, recording stops), the last second is sent marked `final`.
//
// Nothing here is shown on screen: the canvas and its <video> elements are
// never added to the page.

import { useEffect, useRef } from 'react';
import { EVENTS } from '@listen/shared';
import { socket } from './socket.js';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;
// ~0.75 Mbit/s in total — about 340 MB an hour. The recorder uploads this ON
// TOP of their own camera (and screen, if they're sharing), and home / mobile
// upload is small: much more and it clogs their connection — the call's own
// messages then queue behind it and the video connection restarts. Still
// clear for faces and slides at 720p (a meeting grid barely moves).
const VIDEO_BITRATE = 700_000;
const AUDIO_BITRATE = 64_000;
// How often a piece is sent (ms).
const CHUNK_MS = 1000;
// An MP4 can only be cut into pieces at a "key frame" (a full picture). A
// drawn canvas hardly ever makes one by itself, so the recorder would hold
// the WHOLE meeting until the end — so ask for one every second. (Asking
// also makes Chrome use H.264, which plays everywhere.)
const KEY_FRAME_MS = 1000;

// Formats in order of preference. MP4 (H.264) first: it plays everywhere
// (iPhones too) and players can skip around in it. WebM (Firefox) still
// records, but some players can't skip ahead in it.
const FORMATS = [
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4;codecs=avc1,opus',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickFormat() {
  if (typeof MediaRecorder === 'undefined') return null;
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f)) ?? null;
}

/** Can this browser record at all? (Told to the server — see EVENTS.DEVICE.) */
export function canRecord() {
  return Boolean(
    pickFormat() &&
    typeof HTMLCanvasElement !== 'undefined' &&
    HTMLCanvasElement.prototype.captureStream &&
    (window.AudioContext || window.webkitAudioContext),
  );
}

/** Phones and tablets are weaker recorders than laptops / desktops. */
export function isPhoneOrTablet() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// --- drawing ----------------------------------------------------------------

const COLORS = { bg: '#0b0f17', tile: '#1b2230', ring: '#3b82f6', text: '#ffffff' };

// Draw a video to fill a box (cropping the overflow) or fit inside it.
function drawVideo(g, video, x, y, w, h, fit) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = fit ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  g.restore();
}

const initialsOf = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

// A video that has a picture to draw.
const hasPicture = (video) => video && video.readyState >= 2 && video.videoWidth > 0;

function drawTile(g, tile, video, x, y, w, h) {
  g.fillStyle = COLORS.tile;
  g.fillRect(x, y, w, h);
  if (!tile.camOff && hasPicture(video)) {
    drawVideo(g, video, x, y, w, h, false);
  } else {
    // Camera off: a circle with their initials.
    const r = Math.min(w, h) * 0.18;
    g.fillStyle = '#2f3a4f';
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = COLORS.text;
    g.font = `600 ${Math.round(r * 0.8)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(initialsOf(tile.name), x + w / 2, y + h / 2);
  }
  // Name, bottom-left.
  const size = Math.max(13, Math.min(20, Math.round(h / 14)));
  g.font = `600 ${size}px system-ui, sans-serif`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const label = tile.name || 'Guest';
  const tw = Math.min(g.measureText(label).width, w - 24);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(x + 8, y + h - size - 18, tw + 16, size + 10);
  g.fillStyle = COLORS.text;
  g.fillText(label, x + 16, y + h - size / 2 - 13, w - 32);
  // Talking: a blue frame.
  if (tile.speaking) {
    g.strokeStyle = COLORS.ring;
    g.lineWidth = 4;
    g.strokeRect(x + 2, y + 2, w - 4, h - 4);
  }
}

function drawScene(g, scene, videoOf) {
  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, WIDTH, HEIGHT);

  // A screen share: the screen, with whoever's talking (or the presenter)
  // small in the corner.
  if (scene.screen) {
    const v = videoOf(scene.screen.stream);
    if (hasPicture(v)) drawVideo(g, v, 0, 0, WIDTH, HEIGHT, true);
    const corner =
      scene.tiles.find((t) => t.speaking) ?? scene.tiles.find((t) => t.key === scene.screen.key);
    if (corner) {
      const w = 256;
      const h = 144;
      drawTile(g, corner, videoOf(corner.stream), WIDTH - w - 16, HEIGHT - h - 16, w, h);
    }
    return;
  }

  // Everyone in a grid, as square-ish as fits.
  const n = Math.max(1, scene.tiles.length);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gap = 8;
  const w = (WIDTH - gap * (cols + 1)) / cols;
  const h = (HEIGHT - gap * (rows + 1)) / rows;
  scene.tiles.forEach((tile, i) => {
    const row = Math.floor(i / cols);
    // The last row's tiles are centred when it isn't full.
    const inRow = row === rows - 1 ? n - cols * (rows - 1) : cols;
    const col = i % cols;
    const x = (WIDTH - (inRow * w + (inRow - 1) * gap)) / 2 + col * (w + gap);
    const y = gap + row * (h + gap);
    drawTile(g, tile, videoOf(tile.stream), x, y, w, h);
  });
}

/**
 * Record while this browser is the recorder.
 *
 * @param {object}  args
 * @param {string}  args.id      the recording's id (null when not recording)
 * @param {number}  args.part    the part number the server gave this recorder
 * @param {boolean} args.active  this browser is the recorder right now
 * @param {object}  args.scene   what to draw, rebuilt every render:
 *   { tiles: [{ key, stream, name, camOff, speaking, audible }],
 *     screen: { key, stream } | null }
 *   `audible` = their sound goes into the recording (never a listener's).
 */
export function useRecorder({ id, part, active, scene }) {
  // The latest scene, read by the drawing loop (which outlives renders).
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    if (!active || !id || !part) return undefined;
    const format = pickFormat();
    if (!format) return undefined;

    // --- the picture: a canvas the scene is drawn onto ---------------------
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const g = canvas.getContext('2d');

    // One hidden <video> per stream, to draw frames from.
    const videos = new Map(); // stream id -> <video>
    const videoOf = (stream) => {
      if (!stream) return null;
      let v = videos.get(stream.id);
      if (!v) {
        v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.srcObject = stream;
        v.play().catch(() => {});
        videos.set(stream.id, v);
      }
      return v;
    };

    // --- the sound: everyone's audio mixed into one track ------------------
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audio = new AudioCtx();
    audio.resume?.().catch(() => {});
    const mix = audio.createMediaStreamDestination();
    // A steady silent signal, always plugged in: with nothing to mix (nobody
    // allowed to talk yet) the sound track would carry no audio at all, and
    // the recorder waits for audio before writing anything.
    const silence = audio.createConstantSource();
    silence.offset.value = 0;
    silence.connect(mix);
    silence.start();
    const sources = new Map(); // track id -> source node
    const syncAudio = (s) => {
      const tracks = [
        ...s.tiles.filter((t) => t.audible && t.stream).flatMap((t) => t.stream.getAudioTracks()),
        ...(s.screen?.stream?.getAudioTracks() ?? []),
      ].filter((t) => t.readyState === 'live');
      const want = new Set(tracks.map((t) => t.id));
      for (const [tid, node] of sources) {
        if (!want.has(tid)) {
          node.disconnect();
          sources.delete(tid);
        }
      }
      for (const t of tracks) {
        if (sources.has(t.id)) continue;
        const node = audio.createMediaStreamSource(new MediaStream([t]));
        node.connect(mix);
        sources.set(t.id, node);
      }
    };

    // --- draw FPS times a second -------------------------------------------
    // The clock runs in a Worker: browsers slow ordinary timers right down
    // when the tab is in the background, which would make a choppy video.
    const draw = () => {
      const s = sceneRef.current;
      syncAudio(s);
      drawScene(g, s, videoOf);
      // Forget videos for streams that are gone.
      const live = new Set([...s.tiles.map((t) => t.stream?.id), s.screen?.stream?.id]);
      for (const [sid, v] of videos) {
        if (!live.has(sid)) {
          v.srcObject = null;
          videos.delete(sid);
        }
      }
    };
    const clock = new Worker(
      URL.createObjectURL(
        new Blob([`setInterval(() => postMessage(0), ${Math.round(1000 / FPS)});`], {
          type: 'text/javascript',
        }),
      ),
    );
    clock.onmessage = draw;
    draw();

    // --- record, and send each second to the server ------------------------
    const stream = new MediaStream([
      ...canvas.captureStream(FPS).getVideoTracks(),
      ...mix.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: format,
      videoBitsPerSecond: VIDEO_BITRATE,
      audioBitsPerSecond: AUDIO_BITRATE,
      videoKeyFrameIntervalDuration: KEY_FRAME_MS, // (see KEY_FRAME_MS)
    });
    const type = recorder.mimeType || format;
    let stopping = false;
    // Pieces go out in the order they were made (reading each is async).
    let sending = Promise.resolve();
    recorder.ondataavailable = (e) => {
      const final = stopping && recorder.state === 'inactive';
      if (!e.data.size && !final) return;
      // ONE piece on the wire at a time: the next waits until the server has
      // this one. A slow upload then can't pile seconds of video into the
      // connection ahead of the call's own messages (which would time out
      // and restart everyone's video) — the backlog waits here instead.
      // While disconnected, pieces are dropped: someone else has taken over
      // the recording by then (see the server's handOver).
      sending = sending.then(async () => {
        const data = await e.data.arrayBuffer();
        if (!socket.connected) return;
        await socket
          .timeout(30_000)
          .emitWithAck(EVENTS.REC_CHUNK, { id, part, type, data, final })
          .catch(() => {});
      });
    };
    recorder.onerror = (e) => console.warn('[rec] recorder error', e.error ?? e);
    recorder.start(CHUNK_MS);
    console.log(`[rec] recording part ${part} (${type})`);

    // Let go of the canvas, the hidden videos and the sound mixer.
    const release = () => {
      stream.getTracks().forEach((t) => t.stop());
      for (const v of videos.values()) v.srcObject = null;
      for (const node of sources.values()) node.disconnect();
      audio.close().catch(() => {});
    };

    return () => {
      // Stop: the recorder hands over its last piece (sent `final`), and
      // only once it has fully stopped is everything released.
      stopping = true;
      clock.terminate();
      if (recorder.state === 'inactive') {
        release();
      } else {
        recorder.onstop = () => sending.finally(release);
        recorder.stop();
      }
      console.log(`[rec] stopped recording part ${part}`);
    };
  }, [active, id, part]);
}
