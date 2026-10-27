// The WebRTC layer.
//
// This file keeps ALL media/peer-connection logic out of the React components
// so App.jsx can stay "just UI". What happens here:
//
//   1. ask the browser for the microphone + camera (getUserMedia)
//   2. hold one RTCPeerConnection per *other* person in the room ("mesh")
//   3. run the offer / answer / ICE handshake for each connection, using the
//      Socket.IO connection purely as a messenger
//   4. expose the remote MediaStreams so the UI can drop them into <video> tiles
//   5. expose mic / camera on-off toggles and screen sharing
//
// "Mesh" = with N people in a room, every browser holds N-1 peer connections and
// uploads its camera N-1 times. Fine for 3-6 friends. When the server has
// Cloudflare's SFU set up (snapshots say `sfu: true`), the mesh stays off and
// sfu.js carries the media instead: one connection, each track sent once.
// Everything else here — camera, mic, toggles, sharing, moderation — is the
// same either way.
//
// Screen sharing adds a video track to every peer connection mid-call, which
// needs renegotiation — so the connection setup uses the "perfect negotiation"
// pattern (MDN): both peers add their tracks, both may fire onnegotiationneeded,
// and glare is resolved by a deterministic polite/impolite role (lower socket id
// is polite). No single "caller" any more.

import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, MODES, ROLES } from '@listen/shared';
import { IS_DEMO, socket } from './socket.js';
import { useSfu } from './sfu.js';
// Calls that go wrong are reported to the server's logs (see errorReport.js).
import { reportCallProblem } from './errorReport.js';

// Fallback when the server didn't send a list: STUN only (direct routes).
// The server's list adds a TURN relay for networks that block direct routes.
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Self-healing (see `retry` in addPeer). If a connection to someone isn't up
// within this long — or it drops to 'failed' — we restart it. A lost or late
// signaling message, or a busy machine, can otherwise leave one PAIR of
// people stuck without video for the rest of the call.
const CONNECT_TIMEOUT_MS = 10000;
// Give up after this many restarts in a row (resets once connected), so a
// peer that's truly unreachable doesn't get hammered forever.
const MAX_RESTARTS = 5;

// The camera picture we ask for: HD (720p). Asking for nothing in particular
// (`video: true`) gets a small 640×480 LANDSCAPE picture — on a phone held
// upright that's a cropped slice of the camera's view, which then gets
// cropped AGAIN to fill a tall phone tile, so the front camera looks zoomed
// in. Asking for 1280×720 gets the camera's natural wide view instead; phones
// hand it over upright (720×1280) when they're held upright, just like the
// phone's own video recording. `ideal` = "this if you can, the closest you
// have otherwise", so an old webcam still works.
const CAMERA_QUALITY = { width: { ideal: 1280 }, height: { ideal: 720 } };

/**
 * The `video` part of a getUserMedia request: HD, plus a specific camera if
 * one was picked. `how` is 'exact' (that camera or fail) or 'ideal' (that
 * camera if it's still there, else any).
 */
export function cameraConstraints(deviceId, how = 'exact') {
  return deviceId ? { ...CAMERA_QUALITY, deviceId: { [how]: deviceId } } : { ...CAMERA_QUALITY };
}

// Camera + mic. Individual tracks get muted via `track.enabled` — we never
// renegotiate just to toggle mic/camera. (Screen share does renegotiate.)
const MEDIA_CONSTRAINTS = { audio: true, video: cameraConstraints() };

// Use the devices picked in the pre-join lobby, when there are any.
function constraintsFor(media) {
  return {
    audio: media?.audioId ? { deviceId: { exact: media.audioId } } : MEDIA_CONSTRAINTS.audio,
    video: cameraConstraints(media?.videoId),
  };
}

// Strong noise reduction (noiseReduction.js): on or off, remembered on this
// device. ON unless this device turned it off — on phones, tablets and
// computers alike (one noisy room spoils the call for everyone, and most
// people never open the mic menu). Someone who switched it off keeps it off.
//
// Never in the landing page's live demos (IS_DEMO): their saved settings are
// pretend (always empty), so it would switch on in every demo frame and make
// each one download and run the noise model for nothing.
const STRONG_NOISE_KEY = 'turnly.strongNoise';
function wantsStrongNoise() {
  if (IS_DEMO) return false;
  try {
    return localStorage.getItem(STRONG_NOISE_KEY) !== '0';
  } catch {
    return true; // storage blocked: still on (just not remembered)
  }
}
function saveStrongNoise(on) {
  try {
    localStorage.setItem(STRONG_NOISE_KEY, on ? '1' : '0');
  } catch {
    // not remembered past this visit
  }
}
// Can this browser run it at all? (Web Audio worklets.)
export const strongNoiseSupported =
  typeof window !== 'undefined' && typeof window.AudioWorkletNode === 'function';

// The deviceIds behind a stream's mic and camera tracks. `mic` is the mic
// itself when what's sent is a cleaned copy (which has no device of its own).
function deviceIdsOf(stream, mic = null) {
  return {
    audio: (mic ?? stream.getAudioTracks()[0])?.getSettings().deviceId ?? '',
    video: stream.getVideoTracks()[0]?.getSettings().deviceId ?? '',
  };
}

function friendlyMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera / microphone permission was denied. Allow access, then rejoin.';
    case 'NotFoundError':
      return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
      return 'Your camera or microphone is already in use by another app.';
    default:
      return `Could not access camera / microphone: ${err?.message || err?.name || err}`;
  }
}

/**
 * useCall — drives the entire call for one browser tab.
 *
 * @param {object}      args
 * @param {string|null} args.selfId        my own socket id (from the join ack)
 * @param {Array}       args.participants  the room-state participant list
 * @param {boolean}     args.inCall        true once joined and wanting media
 * @param {object}      args.sharing       room-state `sharing` map: socketId -> the
 *                                         id of that peer's screen MediaStream
 * @param {Array}      [args.iceServers]   STUN/TURN servers from the server
 * @param {string}      args.mode          room-state mode ('open' | 'moderated')
 * @param {object}     [args.media]        pre-join choices: { audioId, videoId,
 *                                         micOn, camOn } — applied when the
 *                                         call opens
 * @param {boolean}    [args.sfu]          media goes through Cloudflare's SFU
 *                                         (sfu.js) instead of the mesh
 * @param {object}     [args.sfuMedia]     room-state `media` (the SFU's tracks)
 * @param {boolean}    [args.recording]    this browser is recording the meeting
 */
export function useCall({
  selfId,
  participants,
  inCall,
  sharing = {},
  mode,
  media,
  iceServers,
  sfu = false,
  sfuMedia,
  recording = false,
}) {
  const myRole = participants.find((p) => p.id === selfId)?.role ?? null;
  const isListener = myRole === ROLES.LISTENER;

  // --- things the UI renders ------------------------------------------------
  const [localStream, setLocalStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null); // my own screen, or null
  const [peerMedia, setPeerMedia] = useState([]); // [{ id, streams: MediaStream[] }]
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [mediaError, setMediaError] = useState(null);

  // --- mutable internals --------------------------------------------------
  // peerId -> { pc, streams: Map<streamId, MediaStream>, polite, makingOffer, ignoreOffer }
  const peersRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  // signals that arrived before the local stream was ready — replayed later.
  const pendingRef = useRef(new Map());
  // The tail of a promise chain that runs signaling messages ONE AT A TIME, in
  // the order they arrived. handleSignal is async (it awaits the browser), so
  // without this, two messages could be processed at once — e.g. an ICE
  // candidate applied before the offer it belongs to has finished, which the
  // browser rejects ("remote description was null"). See queueSignal below.
  const signalChainRef = useRef(Promise.resolve());
  // Socket ids of people who were in the call with us and have since left.
  const leftRef = useRef(new Set());
  // Pre-join choices, read once when the camera/mic open.
  const mediaRef = useRef(media);
  // ICE servers for every new connection (set before the call starts).
  const iceRef = useRef(iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS);
  // The stream the pre-join mic/cam on-off choice has already been applied to.
  const prefsAppliedRef = useRef(null);
  // While the camera is off it is fully released (light off); this remembers
  // which camera to reopen when it's switched back on.
  const camDeviceRef = useRef(null);
  // The role effect D last applied — so a device switch (new stream, same
  // role) doesn't re-run the role logic and unmute a muted mic.
  const roleAppliedRef = useRef(null);
  // Which mic / camera are live right now (deviceIds), for the settings menu.
  const [devices, setDevices] = useState({ audio: '', video: '' });

  // Strong noise reduction. With it on, the stream's audio track is a
  // CLEANED COPY of the mic (noiseReduction.js) — that's what's sent, muted,
  // recorded and listened to for "speaking". `rawMicRef` is the mic itself;
  // `cleanerRef` is the cleaning in use ({ track, stop }), if any.
  const [strongNoise, setStrongNoiseState] = useState(wantsStrongNoise);
  const strongRef = useRef(strongNoise);
  const rawMicRef = useRef(null);
  const cleanerRef = useRef(null);

  // The track to send for this mic: a cleaned copy (strong noise reduction
  // on) or the mic as it is. If the cleaning can't start (old browser,
  // blocked download), the plain mic. It becomes the cleaning in use
  // (cleanerRef) and hands back the PREVIOUS one, still running: stop that
  // only once the new track has taken its place — a moment with no live mic
  // in the stream would make the SFU stop sending your audio altogether.
  const micOut = useCallback(async (mic) => {
    const previous = cleanerRef.current;
    let cleaner = null;
    if (mic && strongRef.current && strongNoiseSupported) {
      try {
        const { cleanMic } = await import('./noiseReduction.js');
        cleaner = await cleanMic(mic);
      } catch (err) {
        console.warn('[mic] strong noise reduction unavailable:', err);
      }
    }
    cleanerRef.current = cleaner;
    return { track: cleaner ? cleaner.track : mic, previous };
  }, []);

  // Rebuild `peerMedia` from whatever streams the peers currently have, dropping
  // any stream whose tracks have all ended (e.g. a peer stopped screen sharing).
  const syncRemotes = useCallback(() => {
    const list = [];
    for (const [id, entry] of peersRef.current.entries()) {
      for (const [sid, stream] of [...entry.streams.entries()]) {
        if (!stream.getTracks().some((t) => t.readyState === 'live')) {
          entry.streams.delete(sid);
        }
      }
      const streams = [...entry.streams.values()];
      if (streams.length) list.push({ id, streams });
    }
    setPeerMedia(list);
  }, []);

  const removePeer = useCallback(
    (peerId) => {
      const entry = peersRef.current.get(peerId);
      if (!entry) return;
      clearTimeout(entry.watchdog); // no restarts for a connection we're closing
      try {
        entry.pc.close();
      } catch {
        // already closed
      }
      peersRef.current.delete(peerId);
      pendingRef.current.delete(peerId);
      syncRemotes();
    },
    [syncRemotes],
  );

  // Create (or fetch) the RTCPeerConnection for one peer, with our camera/mic
  // (and screen, if we're already sharing) attached and every event wired up.
  const addPeer = useCallback(
    (peerId) => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: iceRef.current });
      const entry = {
        pc,
        streams: new Map(),
        polite: selfId < peerId, // deterministic: lower id yields on a collision
        makingOffer: false,
        ignoreOffer: false,
      };
      peersRef.current.set(peerId, entry);

      // Send our own audio + video (adding tracks triggers onnegotiationneeded).
      for (const track of localStreamRef.current?.getTracks() ?? []) {
        pc.addTrack(track, localStreamRef.current);
      }
      if (screenStreamRef.current) {
        for (const track of screenStreamRef.current.getTracks()) {
          pc.addTrack(track, screenStreamRef.current);
        }
      }

      // Perfect negotiation: whenever the set of tracks changes, (re)offer.
      pc.onnegotiationneeded = async () => {
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription(); // implicit createOffer / createAnswer
          socket.emit(EVENTS.RTC_SIGNAL, { targetId: peerId, description: pc.localDescription });
        } catch (err) {
          console.error('[webrtc] negotiation failed for', peerId, err);
          reportCallProblem('video connection setup failed', err);
        } finally {
          entry.makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit(EVENTS.RTC_SIGNAL, { targetId: peerId, candidate });
      };

      // A remote track arrived. Keep every stream the peer sends (camera, and a
      // separate stream for their screen); the hook body splits them using the
      // room-state `sharing` map.
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        entry.streams.set(stream.id, stream);
        event.track.addEventListener('ended', syncRemotes);
        stream.addEventListener('removetrack', syncRemotes);
        syncRemotes();
      };

      // --- self-healing ---------------------------------------------------
      // Restart this one connection without touching anyone else's. Two cases
      // it fixes:
      //  - STUCK: we sent an offer, the reply got lost (or a message arrived
      //    in an unlucky order), and the connection waits forever in
      //    'have-local-offer'. We "rollback" (take back our unanswered offer)
      //    so the connection is back to a clean state, then offer again.
      //  - FAILED: the network path broke (e.g. an overloaded machine). An
      //    ICE restart finds a fresh route and reconnects.
      // pc.restartIce() marks the connection as needing a new offer, which
      // fires onnegotiationneeded above — so the new offer goes out through
      // the normal path, and collisions are still sorted out by the usual
      // polite/impolite rules.
      //
      // WHO restarts: if both ends of a stuck pair restarted at the same
      // moment, their fresh offers would keep colliding (and each would get
      // replies to an offer it had just taken back) — stuck forever, in
      // lockstep. So one side leads: the IMPOLITE peer (the one whose offer
      // wins a collision) restarts after 10s. The polite peer only steps in
      // much later (25s) as a backup, in case the other side isn't acting.
      // A little random jitter on top keeps the two from ever lining up.
      entry.restarts = 0;
      const armWatchdog = () => {
        clearTimeout(entry.watchdog);
        const wait =
          (entry.polite ? CONNECT_TIMEOUT_MS * 2.5 : CONNECT_TIMEOUT_MS) + Math.random() * 2000;
        entry.watchdog = setTimeout(() => {
          if (pc.connectionState !== 'connected') retry('not connected in time');
        }, wait);
      };
      async function retry(why) {
        if (pc.signalingState === 'closed') return;
        if (entry.restarts >= MAX_RESTARTS) {
          // Out of retries: this person's video won't come back on its own.
          // Report it (once) — this is the "call failed" we most want to see.
          if (!entry.gaveUpReported) {
            entry.gaveUpReported = true;
            reportCallProblem(`video connection gave up after ${MAX_RESTARTS} tries`, why);
          }
          return;
        }
        entry.restarts += 1;
        console.warn(`[webrtc] reconnecting to ${peerId} (${why}), try ${entry.restarts}`);
        try {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setLocalDescription({ type: 'rollback' });
          }
          pc.restartIce();
        } catch (err) {
          console.error('[webrtc] restart failed for', peerId, err);
          reportCallProblem('video connection restart failed', err);
        }
        armWatchdog(); // check again in a bit; retry again if still not up
      }
      armWatchdog();

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          // Healthy: stop watching and reset the retry budget.
          clearTimeout(entry.watchdog);
          entry.restarts = 0;
        } else if (state === 'failed') {
          // Used to give up here, for good. Now the leading (impolite) side
          // restarts right away; the polite side waits on its backup timer.
          if (entry.polite) armWatchdog();
          else retry('connection failed');
        } else if (state === 'closed') {
          removePeer(peerId);
        }
      };

      return entry;
    },
    [selfId, syncRemotes, removePeer],
  );

  // A signaling message came in from another peer (relayed by the server, which
  // added `from`). Perfect-negotiation handling: on an offer collision the
  // impolite peer ignores the incoming offer, the polite peer rolls back.
  const handleSignal = useCallback(
    async ({ from, description, candidate }) => {
      if (!from) return;
      // A late message from someone who already left the call — ignore it,
      // or we'd build a fresh connection to nobody. (Socket ids are never
      // reused, so a departed id can't belong to anyone new.)
      if (leftRef.current.has(from)) return;

      // Camera not ready yet — stash and replay once it is (see effect B2).
      if (!localStreamRef.current) {
        const queue = pendingRef.current.get(from) ?? [];
        queue.push({ from, description, candidate });
        pendingRef.current.set(from, queue);
        return;
      }

      const entry = addPeer(from);
      const { pc } = entry;
      try {
        if (description) {
          const offerCollision =
            description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
          entry.ignoreOffer = !entry.polite && offerCollision;
          if (entry.ignoreOffer) return;

          await pc.setRemoteDescription(description);
          syncRemotes(); // a renegotiation may have added/removed a screen
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            socket.emit(EVENTS.RTC_SIGNAL, { targetId: from, description: pc.localDescription });
          }
        } else if (candidate) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            if (!entry.ignoreOffer) throw err;
          }
        }
      } catch (err) {
        // An OFFER that won't apply means the two ends disagree about the
        // connection — typically the other side started over (its restart
        // rolled back an offer we had already half-finished with it), so its
        // fresh offer doesn't fit our old connection. The fix is to start
        // over too: throw our connection to them away, build a new one, and
        // answer their offer on that. Both ends are then clean and in step.
        if (description?.type === 'offer') {
          console.warn('[webrtc] offer from', from, "doesn't fit — rebuilding the connection");
          removePeer(from);
          const fresh = addPeer(from);
          try {
            await fresh.pc.setRemoteDescription(description);
            syncRemotes();
            await fresh.pc.setLocalDescription();
            socket.emit(EVENTS.RTC_SIGNAL, {
              targetId: from,
              description: fresh.pc.localDescription,
            });
          } catch (err2) {
            console.error('[webrtc] rebuild failed for', from, err2);
            reportCallProblem('video connection rebuild failed', err2);
          }
          return;
        }
        console.error('[webrtc] failed handling signal from', from, err);
        reportCallProblem('video connection message failed', err);
      }
    },
    [addPeer, removePeer, syncRemotes],
  );

  // Put one signaling message at the back of the line: it starts only after
  // every earlier message has been fully handled. The .catch keeps one bad
  // message from jamming the line for everything after it.
  const queueSignal = useCallback(
    (msg) => {
      signalChainRef.current = signalChainRef.current
        .then(() => handleSignal(msg))
        .catch((err) => {
          console.error('[webrtc] signal handling failed', err);
          reportCallProblem('video connection message failed', err);
        });
    },
    [handleSignal],
  );

  // --- effect A: hold the microphone + camera for as long as we're in call ---
  useEffect(() => {
    if (!inCall) return undefined;

    let cancelled = false;
    setMediaError(null);

    navigator.mediaDevices
      .getUserMedia(constraintsFor(mediaRef.current))
      // The picked device vanished (unplugged) — fall back to the defaults.
      .catch((err) =>
        err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError'
          ? navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS)
          : Promise.reject(err),
      )
      .then(async (opened) => {
        if (cancelled) {
          opened.getTracks().forEach((t) => t.stop());
          return;
        }
        // Strong noise reduction on: send a cleaned copy of the mic.
        const mic = opened.getAudioTracks()[0] ?? null;
        rawMicRef.current = mic;
        const out = mic ? (await micOut(mic)).track : null;
        if (cancelled) {
          opened.getTracks().forEach((t) => t.stop());
          cleanerRef.current?.stop();
          cleanerRef.current = null;
          return;
        }
        const stream =
          out && out !== mic ? new MediaStream([out, ...opened.getVideoTracks()]) : opened;
        const prefs = mediaRef.current;
        stream.getAudioTracks().forEach((t) => (t.enabled = prefs?.micOn !== false));
        stream.getVideoTracks().forEach((t) => {
          t.enabled = prefs?.camOn !== false;
          // Joined with the camera off: release it now so its light goes out.
          // (The ended track stays in the stream so its senders can be refilled.)
          if (prefs?.camOn === false) {
            camDeviceRef.current = t.getSettings().deviceId;
            t.stop();
          }
        });
        localStreamRef.current = stream;
        setLocalStream(stream);
        setDevices(deviceIdsOf(stream, rawMicRef.current));
        setMicOn(stream.getAudioTracks()[0]?.enabled ?? false);
        setCamOn(stream.getVideoTracks()[0]?.enabled ?? false);
      })
      .catch((err) => {
        if (cancelled) return;
        setMediaError(friendlyMediaError(err));
        // (err.name tells why: refused, no device, in use by another app…)
        reportCallProblem('camera/mic failed to open', err);
      });

    return () => {
      cancelled = true;
      const stream = localStreamRef.current;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      // (the mic itself, when what was sent was a cleaned copy)
      rawMicRef.current?.stop();
      rawMicRef.current = null;
      cleanerRef.current?.stop();
      cleanerRef.current = null;
      localStreamRef.current = null;
      setLocalStream(null);
    };
  }, [inCall, micOut]);

  // --- effect B: the signaling wire + mesh teardown -------------------------
  // Start listening the moment we're in the call — NOT once the camera is
  // ready. Why it matters: when the host admits you, their tab sends you a
  // connection offer straight away, usually while your camera is still
  // starting. If nobody is listening yet, that offer is simply lost, the host
  // waits forever for a reply, and (depending on a coin-flip of socket ids)
  // the two tabs can deadlock with no video between them. Listening early
  // means an early offer lands in handleSignal, which stashes it in pendingRef
  // until the camera is up (effect B2 replays it).
  useEffect(() => {
    if (!inCall || !selfId || sfu) return undefined;

    const peers = peersRef.current;
    const pending = pendingRef.current;
    socket.on(EVENTS.RTC_SIGNAL, queueSignal);

    return () => {
      socket.off(EVENTS.RTC_SIGNAL, queueSignal);
      for (const id of [...peers.keys()]) removePeer(id);
      pending.clear(); // stashed messages for a call we've left are useless
    };
  }, [inCall, selfId, sfu, queueSignal, removePeer]);

  // --- effect B2: camera ready -> replay whatever arrived early -------------
  // Everything stashed while the camera was starting goes back through the
  // same one-at-a-time line, oldest first, so an offer is always fully
  // applied before its ICE candidates.
  useEffect(() => {
    if (!inCall || !selfId || !localStream || sfu) return;

    const queued = [...pendingRef.current.values()].flat();
    pendingRef.current.clear();
    queued.forEach(queueSignal);
  }, [inCall, selfId, localStream, sfu, queueSignal]);

  // --- effect C: keep exactly one connection per other participant ----------
  useEffect(() => {
    if (!inCall || !selfId || !localStream || sfu) return;

    const others = new Set(participants.map((p) => p.id).filter((id) => id !== selfId));

    for (const peerId of others) {
      if (!peersRef.current.has(peerId)) addPeer(peerId);
    }
    for (const peerId of [...peersRef.current.keys()]) {
      if (!others.has(peerId)) {
        leftRef.current.add(peerId); // remember: ignore their late messages
        removePeer(peerId);
      }
    }
  }, [inCall, selfId, localStream, sfu, participants, addPeer, removePeer]);

  // --- effect D: moderation follows your role -----------------------------
  // When the host moderates the room the server sets my role to 'listener'; my
  // client silences its OWN mic. The camera is NOT role-gated — listeners
  // may turn theirs on and off freely; role changes never touch it.
  useEffect(() => {
    const stream = localStreamRef.current;
    if (!stream || !myRole) return;

    const allowed = myRole !== ROLES.LISTENER;
    // First pass for this stream keeps whatever was chosen in the pre-join
    // lobby (e.g. "join with mic off"); later role changes behave as before.
    const first = prefsAppliedRef.current !== stream;
    // Same role, same stream already handled (a device switch swaps in a new
    // stream object but marks it applied): nothing to do.
    if (!first && roleAppliedRef.current === myRole) return;
    prefsAppliedRef.current = stream;
    roleAppliedRef.current = myRole;
    const prefs = mediaRef.current;
    const micWanted = !first || prefs?.micOn !== false;
    stream.getAudioTracks().forEach((t) => (t.enabled = allowed && micWanted));
    setMicOn(allowed && micWanted && stream.getAudioTracks().length > 0);
    if (first) {
      const camWanted = prefs?.camOn !== false;
      stream.getVideoTracks().forEach((t) => (t.enabled = camWanted));
      setCamOn(camWanted && stream.getVideoTracks().length > 0);
    }
  }, [myRole, localStream]);

  // --- effect E: mic-level detection -> throttled "speaking" pings --------
  useEffect(() => {
    if (!inCall || !localStream || isListener) return undefined;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return undefined;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return undefined;

    const ctx = new AudioCtx();
    ctx.resume?.();
    const source = ctx.createMediaStreamSource(localStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // NOT connected to ctx.destination — no playback
    const buf = new Float32Array(analyser.fftSize);

    const THRESHOLD = 0.02;
    const HANGOVER_MS = 600;
    const TICK_MS = 100;

    let speaking = false;
    let quietSince = 0;

    const report = (next) => {
      speaking = next;
      if (socket.connected) socket.emit(EVENTS.SPEAKING, { speaking: next });
    };

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sumSquares = 0;
      for (let i = 0; i < buf.length; i += 1) sumSquares += buf[i] * buf[i];
      const rms = Math.sqrt(sumSquares / buf.length);
      const loud = rms > THRESHOLD && audioTrack.enabled;

      if (loud) {
        quietSince = 0;
        if (!speaking) report(true);
      } else if (speaking) {
        if (!quietSince) quietSince = performance.now();
        else if (performance.now() - quietSince > HANGOVER_MS) report(false);
      }
    }, TICK_MS);

    return () => {
      clearInterval(timer);
      if (speaking && socket.connected) socket.emit(EVENTS.SPEAKING, { speaking: false });
      source.disconnect();
      ctx.close();
    };
  }, [inCall, localStream, isListener]);

  // --- effect F: the host can force-mute me (Phase 7) --------------------
  useEffect(() => {
    function onForceMute() {
      const track = localStreamRef.current?.getAudioTracks()[0];
      if (track && track.enabled) {
        track.enabled = false;
        setMicOn(false);
      }
    }
    socket.on(EVENTS.FORCE_MUTE, onForceMute);
    return () => socket.off(EVENTS.FORCE_MUTE, onForceMute);
  }, []);

  // --- effect G: flipping to moderated hands the room to the host --------
  // The moment the room becomes moderated, the host holds the floor: their mic
  // is unmuted and everyone else's is muted. Listeners also get muted by
  // effect D (their role changes), but this additionally covers the co-host and
  // unmutes the host. A one-shot on the transition — anyone can toggle after.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    const was = prevModeRef.current;
    prevModeRef.current = mode;
    if (was === mode || mode !== MODES.MODERATED) return;

    const micTrack = localStreamRef.current?.getAudioTracks()[0];
    if (!micTrack) return;
    const iAmHost = myRole === ROLES.HOST;
    micTrack.enabled = iAmHost;
    setMicOn(iAmHost);
  }, [mode, myRole]);

  // --- effect H: tell the room whenever my mic turns on or off ------------
  // `micOn` changes from every path — the mic button, the pre-join choice, a
  // host mute, a role change — so watching it here catches them all in one
  // place. The server stores it and re-broadcasts, which is how other people's
  // screens learn to show "<name> is muted".
  // `selfId` is in the list too: after a reconnect (new socket id) we report
  // again, in case the mic was toggled while we were offline and the report
  // never got through.
  useEffect(() => {
    if (inCall && localStream && socket.connected) {
      socket.emit(EVENTS.MIC_STATE, { on: micOn });
    }
  }, [micOn, inCall, localStream, selfId]);

  // ...and the camera, so others can show my avatar while it's off.
  useEffect(() => {
    if (inCall && localStream && socket.connected) {
      socket.emit(EVENTS.CAM_STATE, { on: camOn });
    }
  }, [camOn, inCall, localStream, selfId]);

  // --- screen sharing ----------------------------------------------------
  const stopShare = useCallback(() => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    const trackIds = new Set(stream.getTracks().map((t) => t.id));
    for (const { pc } of peersRef.current.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && trackIds.has(sender.track.id)) {
          try {
            pc.removeTrack(sender); // triggers renegotiation
          } catch {
            // pc already closed
          }
        }
      }
    }
    stream.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setScreenStream(null);
    if (socket.connected) socket.emit(EVENTS.SCREEN_SHARE, { on: false });
  }, []);

  // Send a screen (or presentation) stream to every peer and tell the room.
  const publishShare = useCallback(
    (stream) => {
      screenStreamRef.current = stream;
      setScreenStream(stream);
      // The browser's own "Stop sharing" bar ends the video track.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopShare());
      for (const { pc } of peersRef.current.values()) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }
      if (socket.connected) socket.emit(EVENTS.SCREEN_SHARE, { on: true, streamId: stream.id });
    },
    [stopShare],
  );

  const startShare = useCallback(async () => {
    if (screenStreamRef.current || !navigator.mediaDevices?.getDisplayMedia) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setMediaError(`Could not start screen share: ${err?.message || err?.name || err}`);
      }
      return;
    }
    publishShare(stream);
  }, [publishShare]);

  // Present something other than the screen — e.g. photos or a PDF drawn onto
  // a canvas (canvas.captureStream) on phones, which can't capture the screen.
  // It travels exactly like a screen share, so every viewer shows it the same.
  const presentStream = useCallback(
    (stream) => {
      if (screenStreamRef.current || !stream) return false;
      publishShare(stream);
      return true;
    },
    [publishShare],
  );

  // Stop sharing when the call unmounts.
  useEffect(() => () => stopShare(), [stopShare]);

  // Someone else started presenting and bumped me (Google-Meet-style: only one
  // presenter at a time). The server has already dropped me from
  // `room.sharing`; this actually ends my capture and renegotiates it away.
  useEffect(() => {
    function onBumped() {
      stopShare();
    }
    socket.on(EVENTS.SCREEN_SHARE_STOPPED, onBumped);
    return () => socket.off(EVENTS.SCREEN_SHARE_STOPPED, onBumped);
  }, [stopShare]);

  // In a moderated room only the host + speakers may screen share, so if my
  // role drops to 'listener' while I'm sharing, stop (the server has already
  // dropped me from `room.sharing`; this stops the actual media).
  useEffect(() => {
    if (isListener && screenStreamRef.current) stopShare();
  }, [isListener, stopShare]);

  // --- controls: flip the track's `enabled` flag ---------------------------
  const toggleMic = useCallback(() => {
    if (isListener) return;
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, [isListener]);

  // Camera: anyone, any role — including a moderated room's listeners.
  //
  // Off really means off: the camera track is STOPPED, which releases the
  // hardware so the camera light goes out (like Google Meet) — not just
  // disabled, which keeps the camera running behind a black frame. On opens
  // the camera again and swaps the fresh track into every connection with
  // replaceTrack: no renegotiation, nobody reconnects.
  const toggleCam = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];

    if (track && track.readyState === 'live' && track.enabled) {
      camDeviceRef.current = track.getSettings().deviceId;
      track.enabled = false;
      track.stop();
      setCamOn(false);
      return;
    }

    let fresh;
    try {
      const id = camDeviceRef.current;
      const s = await navigator.mediaDevices.getUserMedia({
        video: cameraConstraints(id, 'ideal'),
      });
      fresh = s.getVideoTracks()[0];
    } catch (err) {
      setMediaError(friendlyMediaError(err));
      reportCallProblem('camera failed to turn back on', err);
      return;
    }
    if (localStreamRef.current !== stream) {
      fresh.stop(); // left the call (or switched devices) while it was opening
      return;
    }
    for (const { pc } of peersRef.current.values()) {
      // Exact match only: a screen share is another video sender.
      const sender = track && pc.getSenders().find((x) => x.track === track);
      if (sender) await sender.replaceTrack(fresh).catch(() => {});
      else if (!track) pc.addTrack(fresh, stream); // never had a camera track
    }
    const next = new MediaStream([...stream.getTracks().filter((t) => t !== track), fresh]);
    setMediaError(null);
    prefsAppliedRef.current = next;
    localStreamRef.current = next;
    setLocalStream(next);
    setDevices(deviceIdsOf(next, rawMicRef.current));
    setCamOn(true);
  }, []);

  // --- switch mic / camera mid-call ---------------------------------------
  // Open the newly picked device and swap its track in for the old one on
  // every peer connection with replaceTrack — no renegotiation, nobody
  // reconnects. The new track inherits the old one's on/off state, so a muted
  // mic stays muted and a listener stays silent.
  //
  // The swapped tracks go into a NEW MediaStream object so everything keyed on
  // the stream re-runs: the local preview tile and the speaking detector
  // (effect E), which is bound to the old mic track. Effect D is told this
  // stream is already handled, so it doesn't redo the join-time logic.
  const switchDevice = useCallback(
    async (kind, deviceId) => {
      const stream = localStreamRef.current;
      const old = kind === 'audio' ? stream?.getAudioTracks()[0] : stream?.getVideoTracks()[0];
      // Camera is off (released): don't switch it on — use this one next time.
      if (kind === 'video' && old && old.readyState === 'ended') {
        camDeviceRef.current = deviceId;
        setDevices((d) => ({ ...d, video: deviceId }));
        return;
      }
      // (For the mic, compare the mic itself — what's sent may be a cleaned copy.)
      const current = kind === 'audio' ? (rawMicRef.current ?? old) : old;
      if (!stream || !deviceId || current?.getSettings().deviceId === deviceId) return;

      const open = (id) =>
        navigator.mediaDevices
          .getUserMedia(
            kind === 'video'
              ? { video: cameraConstraints(id) }
              : { audio: { deviceId: { exact: id } } },
          )
          .then((s) => (kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0]));

      // Many phones/laptops can't run two cameras at once, so the old camera is
      // released first. (Mics don't have that problem; keep the old one live
      // until the new one is ready.)
      if (kind === 'video') old?.stop();
      let track;
      // Stops what the new mic replaced (see the audio branch below).
      let retire = () => {};
      try {
        track = await open(deviceId);
      } catch (err) {
        setMediaError(friendlyMediaError(err));
        reportCallProblem(`switching ${kind === 'video' ? 'camera' : 'mic'} failed`, err);
        if (kind !== 'video' || !old) return;
        // Camera switch failed: bring the previous camera back.
        try {
          track = await open(old.getSettings().deviceId);
        } catch {
          return;
        }
      }
      if (localStreamRef.current !== stream) {
        track.stop(); // left the call while the device was opening
        return;
      }
      if (kind === 'audio') {
        // The new mic replaces the old one; with strong noise reduction on,
        // what's sent is a cleaned copy of it.
        const previousMic = rawMicRef.current;
        rawMicRef.current = track;
        const made = await micOut(track);
        track = made.track;
        // (stopped once the new one is in place — below)
        retire = () => {
          made.previous?.stop();
          if (previousMic && previousMic !== rawMicRef.current) previousMic.stop();
        };
      }
      track.enabled = old ? old.enabled : true;

      for (const { pc } of peersRef.current.values()) {
        // Exact match only: a screen share is another video sender.
        const sender = old && pc.getSenders().find((s) => s.track === old);
        if (sender) await sender.replaceTrack(track).catch(() => {});
      }

      const others = stream.getTracks().filter((t) => t !== old && t.kind !== kind);
      const next = new MediaStream([...others, track]);
      if (old && old.readyState !== 'ended') old.stop();
      setMediaError(null);
      prefsAppliedRef.current = next;
      localStreamRef.current = next;
      setLocalStream(next);
      setDevices(deviceIdsOf(next, rawMicRef.current));
      retire();
    },
    [micOut],
  );

  // --- strong noise reduction on / off, mid-call ----------------------------
  // Swaps what's sent — the mic as it is, or a cleaned copy — in place
  // (replaceTrack; nobody reconnects). Muted stays muted.
  const setStrongNoise = useCallback(
    async (on) => {
      saveStrongNoise(on);
      strongRef.current = on;
      setStrongNoiseState(on);
      const stream = localStreamRef.current;
      const mic = rawMicRef.current;
      if (!stream || !mic) return; // not in a call: used next time the mic opens
      const old = stream.getAudioTracks()[0];
      const enabled = old ? old.enabled : true;
      const { track: out, previous } = await micOut(mic);
      if (localStreamRef.current !== stream) {
        previous?.stop(); // left meanwhile
        return;
      }
      out.enabled = enabled;
      if (out !== mic) mic.enabled = true; // the copy does the muting
      for (const { pc } of peersRef.current.values()) {
        const sender = old && pc.getSenders().find((x) => x.track === old);
        if (sender) await sender.replaceTrack(out).catch(() => {});
      }
      const next = new MediaStream([out, ...stream.getTracks().filter((t) => t.kind !== 'audio')]);
      prefsAppliedRef.current = next;
      localStreamRef.current = next;
      setLocalStream(next);
      // Only now, with the new one in place: stop the previous cleaning.
      previous?.stop();
    },
    [micOut],
  );

  // --- the SFU's media (when it's on) -------------------------------------
  const viaSfu = useSfu({
    active: inCall && sfu,
    selfId,
    media: sfuMedia,
    localStream,
    camOn,
    isListener,
    screenStream,
    iceServers,
    recording,
  });

  // --- split each peer's streams into camera vs screen --------------------
  const remotes = sfu ? viaSfu.remotes : [];
  const remoteScreens = sfu ? viaSfu.remoteScreens : [];
  if (!sfu) {
    for (const { id, streams } of peerMedia) {
      const screenId = sharing?.[id];
      for (const stream of streams) {
        if (screenId && stream.id === screenId) remoteScreens.push({ id, stream });
        else remotes.push({ id, stream });
      }
    }
  }

  return {
    localStream,
    screenStream,
    remotes,
    remoteScreens,
    micOn,
    camOn,
    sharingScreen: Boolean(screenStream),
    toggleMic,
    toggleCam,
    devices,
    switchDevice,
    strongNoise,
    setStrongNoise,
    startShare,
    presentStream,
    stopShare,
    mediaError,
    isListener,
    // My audio/video connection never came up — likely the network (sfu.js).
    mediaBlocked: sfu ? viaSfu.blocked : false,
  };
}
