// Phase 2 — the WebRTC layer.
//
// This file keeps ALL media/peer-connection logic out of the React components
// so App.jsx can stay "just UI". What happens here:
//
//   1. ask the browser for the microphone + camera (getUserMedia)
//   2. hold one RTCPeerConnection per *other* person in the room ("mesh")
//   3. run the offer / answer / ICE handshake for each connection, using the
//      Phase 1 Socket.IO connection purely as a messenger
//   4. expose the remote MediaStreams so the UI can drop them into <video> tiles
//   5. expose mic / camera on-off toggles
//
// Phase 4 adds effect D: when the server sets my role to 'listener' (moderated
// room), my client silences its own outbound tracks — the server can't, because
// media is peer-to-peer.
// Phase 6 adds effect E: watch my own mic level and emit throttled
// speaking: true/false so the server can elect the room's active speaker.
// Phase 7 adds effect F: the host can FORCE_MUTE me — my client disables its
// own mic track (media is peer-to-peer; the server can't).

import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, ROLES } from '@listen/shared';
import { socket } from './socket.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
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

export function useCall({ selfId, participants, inCall }) {
  // My current role, straight from the latest room-state snapshot. The server
  // decides this; the client only reacts. `listener` (Phase 4) means the room
  // is moderated and I'm not cleared to speak.
  const myRole = participants.find((p) => p.id === selfId)?.role ?? null;
  const isListener = myRole === ROLES.LISTENER;

  const [localStream, setLocalStream] = useState(null);
  const [remotes, setRemotes] = useState([]); // [{ id, stream }]
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [mediaError, setMediaError] = useState(null);

  const peersRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const pendingRef = useRef(new Map());

  const syncRemotes = useCallback(() => {
    setRemotes(
      [...peersRef.current.entries()]
        .filter(([, entry]) => entry.stream)
        .map(([id, entry]) => ({ id, stream: entry.stream })),
    );
  }, []);

  const removePeer = useCallback(
    (peerId) => {
      const entry = peersRef.current.get(peerId);
      if (!entry) return;
      try {
        entry.pc.close();
      } catch {
        // already closed — nothing to do
      }
      peersRef.current.delete(peerId);
      pendingRef.current.delete(peerId);
      syncRemotes();
    },
    [syncRemotes],
  );

  const addPeer = useCallback(
    (peerId) => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const entry = { pc, stream: null };
      peersRef.current.set(peerId, entry);

      const local = localStreamRef.current;
      if (local) {
        for (const track of local.getTracks()) pc.addTrack(track, local);
      }

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          socket.emit(EVENTS.RTC_SIGNAL, { targetId: peerId, candidate });
        }
      };

      pc.ontrack = (event) => {
        entry.stream = event.streams[0];
        syncRemotes();
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          removePeer(peerId);
        }
      };

      return entry;
    },
    [syncRemotes, removePeer],
  );

  const callPeer = useCallback(
    async (peerId) => {
      const { pc } = addPeer(peerId);
      try {
        await pc.setLocalDescription(await pc.createOffer());
        socket.emit(EVENTS.RTC_SIGNAL, {
          targetId: peerId,
          description: pc.localDescription,
        });
      } catch (err) {
        console.error('[webrtc] createOffer failed for', peerId, err);
      }
    },
    [addPeer],
  );

  const handleSignal = useCallback(
    async ({ from, description, candidate }) => {
      if (!from) return;

      if (!localStreamRef.current) {
        const queue = pendingRef.current.get(from) ?? [];
        queue.push({ from, description, candidate });
        pendingRef.current.set(from, queue);
        return;
      }

      const { pc } = addPeer(from);
      try {
        if (description) {
          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            await pc.setLocalDescription(await pc.createAnswer());
            socket.emit(EVENTS.RTC_SIGNAL, {
              targetId: from,
              description: pc.localDescription,
            });
          }
        } else if (candidate) {
          await pc.addIceCandidate(candidate);
        }
      } catch (err) {
        console.error('[webrtc] failed handling signal from', from, err);
      }
    },
    [addPeer],
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
      if (peersRef.current.has(peerId)) continue;
      if (selfId > peerId) callPeer(peerId);
      else addPeer(peerId);
    }

    for (const peerId of [...peersRef.current.keys()]) {
      if (!others.has(peerId)) removePeer(peerId);
    }
  }, [inCall, selfId, localStream, participants, callPeer, addPeer, removePeer]);

  // --- effect D: moderation follows your role -----------------------------
  // Phase 4. When the host moderates the room the server sets my role to
  // 'listener'; my client then silences its OWN outbound tracks — the server
  // can't, because media is peer-to-peer. Back to speaker/host: re-enable both.
  // This only runs when `myRole` changes, so it never fights the manual
  // mute/camera buttons below (those don't change the role).
  useEffect(() => {
    const stream = localStreamRef.current;
    if (!stream || !myRole) return;

    const allowed = myRole !== ROLES.LISTENER;
    for (const track of stream.getTracks()) track.enabled = allowed;
    setMicOn(allowed && stream.getAudioTracks().length > 0);
    setCamOn(allowed && stream.getVideoTracks().length > 0);
  }, [myRole, localStream]);

  // --- effect E: mic-level detection -> throttled "speaking" pings --------
  // Phase 6. We watch our OWN microphone with the Web Audio API and tell the
  // server only when the answer to "am I talking?" flips. RMS of the raw
  // waveform is the loudness measure; the rising edge fires immediately, the
  // falling edge waits out a short HANGOVER so the glow doesn't strobe between
  // words. A disabled mic track counts as silence. Only speakers and the host
  // run this — listeners are force-muted and never the active speaker.
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

    const THRESHOLD = 0.02; // RMS above this = "talking"
    const HANGOVER_MS = 600; // stay "talking" this long after dropping below
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
      if (speaking && socket.connected) {
        socket.emit(EVENTS.SPEAKING, { speaking: false });
      }
      source.disconnect();
      ctx.close();
    };
  }, [inCall, localStream, isListener]);

  // --- effect F: the host can force-mute me (Phase 7) --------------------
  // Media is peer-to-peer, so the server can't mute anyone — it relays a
  // FORCE_MUTE to my socket and my client disables its own mic track. I can
  // press "Unmute mic" myself afterwards; this isn't a lock.
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

  // --- controls: flip the track's `enabled` flag ---------------------------
  // A listener can't use these — in a moderated room the mic isn't theirs to
  // un-mute. The UI hides the buttons too; this is the belt-and-braces guard.
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

  return { localStream, remotes, micOn, camOn, toggleMic, toggleCam, mediaError, myRole, isListener };
}
