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
// uploads its camera N-1 times. Fine for 3-6 friends; a bigger room needs an SFU
// (a post-v1 rewrite).
//
// Screen sharing adds a video track to every peer connection mid-call, which
// needs renegotiation — so the connection setup uses the "perfect negotiation"
// pattern (MDN): both peers add their tracks, both may fire onnegotiationneeded,
// and glare is resolved by a deterministic polite/impolite role (lower socket id
// is polite). No single "caller" any more.

import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, ROLES } from '@listen/shared';
import { socket } from './socket.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Camera + mic. Individual tracks get muted via `track.enabled` — we never
// renegotiate just to toggle mic/camera. (Screen share does renegotiate.)
const MEDIA_CONSTRAINTS = { audio: true, video: true };

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
 */
export function useCall({ selfId, participants, inCall, sharing = {} }) {
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

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
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

      // Camera not ready yet — stash and replay once it is (see effect B).
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
            description.type === 'offer' &&
            (entry.makingOffer || pc.signalingState !== 'stable');
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
        console.error('[webrtc] failed handling signal from', from, err);
      }
    },
    [addPeer, syncRemotes],
  );

  // --- effect A: hold the microphone + camera for as long as we're in call ---
  useEffect(() => {
    if (!inCall) return undefined;

    let cancelled = false;
    setMediaError(null);

    navigator.mediaDevices
      .getUserMedia(MEDIA_CONSTRAINTS)
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        setLocalStream(stream);
        setMicOn(stream.getAudioTracks()[0]?.enabled ?? false);
        setCamOn(stream.getVideoTracks()[0]?.enabled ?? false);
      })
      .catch((err) => {
        if (!cancelled) setMediaError(friendlyMediaError(err));
      });

    return () => {
      cancelled = true;
      const stream = localStreamRef.current;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    };
  }, [inCall]);

  // --- effect B: the signaling wire + mesh teardown -------------------------
  useEffect(() => {
    if (!inCall || !selfId || !localStream) return undefined;

    const peers = peersRef.current;
    socket.on(EVENTS.RTC_SIGNAL, handleSignal);

    const queued = [...pendingRef.current.values()].flat();
    pendingRef.current.clear();
    queued.forEach(handleSignal);

    return () => {
      socket.off(EVENTS.RTC_SIGNAL, handleSignal);
      for (const id of [...peers.keys()]) removePeer(id);
    };
  }, [inCall, selfId, localStream, handleSignal, removePeer]);

  // --- effect C: keep exactly one connection per other participant ----------
  useEffect(() => {
    if (!inCall || !selfId || !localStream) return;

    const others = new Set(participants.map((p) => p.id).filter((id) => id !== selfId));

    for (const peerId of others) {
      if (!peersRef.current.has(peerId)) addPeer(peerId);
    }
    for (const peerId of [...peersRef.current.keys()]) {
      if (!others.has(peerId)) removePeer(peerId);
    }
  }, [inCall, selfId, localStream, participants, addPeer, removePeer]);

  // --- effect D: moderation follows your role -----------------------------
  // When the host moderates the room the server sets my role to 'listener'; my
  // client silences its OWN camera/mic tracks. Screen share is left alone —
  // anyone may share regardless of role.
  useEffect(() => {
    const stream = localStreamRef.current;
    if (!stream || !myRole) return;

    const allowed = myRole !== ROLES.LISTENER;
    for (const track of stream.getTracks()) track.enabled = allowed;
    setMicOn(allowed && stream.getAudioTracks().length > 0);
    setCamOn(allowed && stream.getVideoTracks().length > 0);
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
    screenStreamRef.current = stream;
    setScreenStream(stream);
    // The browser's own "Stop sharing" bar ends the video track.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stopShare());
    for (const { pc } of peersRef.current.values()) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
    if (socket.connected) socket.emit(EVENTS.SCREEN_SHARE, { on: true, streamId: stream.id });
  }, [stopShare]);

  // Stop sharing when the call unmounts.
  useEffect(() => () => stopShare(), [stopShare]);

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

  const toggleCam = useCallback(() => {
    if (isListener) return;
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  }, [isListener]);

  // --- split each peer's streams into camera vs screen --------------------
  const remotes = [];
  const remoteScreens = [];
  for (const { id, streams } of peerMedia) {
    const screenId = sharing?.[id];
    for (const stream of streams) {
      if (screenId && stream.id === screenId) remoteScreens.push({ id, stream });
      else remotes.push({ id, stream });
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
    startShare,
    stopShare,
    mediaError,
    myRole,
    isListener,
  };
}
