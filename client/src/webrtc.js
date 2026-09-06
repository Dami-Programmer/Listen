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
// "Mesh" = with N people in a room, every browser holds N-1 peer connections and
// uploads its camera N-1 times. That's fine for 3-6 friends. A bigger room needs
// an SFU (a media server that fans out one upload), which the roadmap leaves as
// a post-v1 rewrite. None of the signaling/role code cares how media is routed,
// so that swap stays contained.

import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, ROLES } from '@listen/shared';
import { socket } from './socket.js';

// STUN lets a browser discover its own public IP:port so two peers behind home
// routers can find a path to each other. This free Google server is plenty for
// localhost and same-Wi-Fi testing. Real cross-network calls also need a TURN
// server (a relay used when no direct path exists) — that is Phase 8.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// We always request both. Individual tracks get muted via `track.enabled`
// later — we never renegotiate just to toggle mic/camera.
const MEDIA_CONSTRAINTS = { audio: true, video: true };

// Turn a getUserMedia DOMException into a sentence a person can act on.
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
 * @param {object}       args
 * @param {string|null}  args.selfId        my own socket id (from the join ack)
 * @param {Array}        args.participants  the room-state participant list
 * @param {boolean}      args.inCall        true once joined and wanting media
 *
 * @returns {{
 *   localStream: MediaStream|null,
 *   remotes: Array<{ id: string, stream: MediaStream }>,
 *   micOn: boolean,
 *   camOn: boolean,
 *   toggleMic: () => void,
 *   toggleCam: () => void,
 *   mediaError: string|null,
 *   myRole: 'host'|'speaker'|'listener'|null,
 *   isListener: boolean,   // true => moderated room, not cleared to speak
 * }}
 */
export function useCall({ selfId, participants, inCall }) {
  // My current role, straight from the latest room-state snapshot. The server
  // decides this; the client only reacts to it. `listener` (Phase 4) means the
  // room is moderated and I'm not cleared to speak.
  const myRole = participants.find((p) => p.id === selfId)?.role ?? null;
  const isListener = myRole === ROLES.LISTENER;

  // --- things the UI renders --------------------------------------------------
  const [localStream, setLocalStream] = useState(null);
  const [remotes, setRemotes] = useState([]); // [{ id, stream }]
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [mediaError, setMediaError] = useState(null);

  // --- mutable internals (refs, so socket callbacks always see fresh values) --
  // peerId -> { pc: RTCPeerConnection, stream: MediaStream|null }
  const peersRef = useRef(new Map());
  // the local camera/mic stream, mirrored from state into a ref
  const localStreamRef = useRef(null);
  // signals that arrived before the local stream was ready — replayed later.
  // peerId -> [ signal, ... ]
  const pendingRef = useRef(new Map());

  // Rebuild the `remotes` array from whatever streams the peers currently have.
  // Called whenever a peer gains media or a connection goes away.
  const syncRemotes = useCallback(() => {
    setRemotes(
      [...peersRef.current.entries()]
        .filter(([, entry]) => entry.stream)
        .map(([id, entry]) => ({ id, stream: entry.stream })),
    );
  }, []);

  // Tear down one peer connection and forget it.
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

  // Create (or fetch the existing) RTCPeerConnection for one peer, with our
  // camera/mic already attached and every event wired up. Safe to call twice —
  // the second call just returns the first connection.
  const addPeer = useCallback(
    (peerId) => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const entry = { pc, stream: null };
      peersRef.current.set(peerId, entry);

      // Send our own audio + video down this connection.
      const local = localStreamRef.current;
      if (local) {
        for (const track of local.getTracks()) pc.addTrack(track, local);
      }

      // Trickle ICE: as the browser discovers network paths, forward each
      // candidate to the peer. `null` candidate = "done", nothing to send.
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          socket.emit(EVENTS.RTC_SIGNAL, { targetId: peerId, candidate });
        }
      };

      // The peer's media arrived. event.streams[0] is the MediaStream we passed
      // to addTrack on their side; attach it to a <video> in the UI.
      pc.ontrack = (event) => {
        entry.stream = event.streams[0];
        syncRemotes();
      };

      // If the connection dies for good, drop the tile. ('disconnected' can
      // recover on its own, so we only hard-close on 'failed' / 'closed'.)
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          removePeer(peerId);
        }
      };

      return entry;
    },
    [syncRemotes, removePeer],
  );

  // I am the caller for this pair: build an offer and send it.
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

  // A signaling message came in from another peer (relayed by the server, which
  // added `from`). It is either an SDP description (offer/answer) or an ICE
  // candidate.
  //
  // We do NOT use RTCPeerConnection.onnegotiationneeded here: in Phase 2 tracks
  // are added exactly once, at connection setup, and mic/camera toggles use
  // `track.enabled` (no renegotiation). One deterministic offer per pair — see
  // effect C — so there is never a "glare" collision to resolve. If a later
  // phase adds/removes tracks mid-call (screen share, etc.), upgrade this to the
  // full "perfect negotiation" pattern (polite/impolite rollback).
  const handleSignal = useCallback(
    async ({ from, description, candidate }) => {
      if (!from) return;

      // Camera not ready yet — stash the message and replay it once it is
      // (see effect B). Without this, an early offer would be lost.
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
          // Their offer needs our answer back. (An answer needs nothing more.)
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
          // component unmounted while the permission prompt was open
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

    // Leaving the call: stop the camera/mic hardware (turns the light off).
    return () => {
      cancelled = true;
      const stream = localStreamRef.current;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    };
  }, [inCall]);

  // --- effect B: the signaling wire + mesh teardown -------------------------
  // Runs once we have an id and a local stream. Owns the RTC_SIGNAL listener and
  // is the single place every peer connection gets torn down.
  useEffect(() => {
    if (!inCall || !selfId || !localStream) return undefined;

    // The Map object itself never gets replaced, only mutated, so capturing it
    // here is the same Map at cleanup time (and keeps the linter happy about
    // reading a ref in a cleanup function).
    const peers = peersRef.current;

    socket.on(EVENTS.RTC_SIGNAL, handleSignal);

    // Replay any signals that landed before the camera was ready.
    const queued = [...pendingRef.current.values()].flat();
    pendingRef.current.clear();
    queued.forEach(handleSignal);

    return () => {
      socket.off(EVENTS.RTC_SIGNAL, handleSignal);
      for (const id of [...peers.keys()]) removePeer(id);
    };
  }, [inCall, selfId, localStream, handleSignal, removePeer]);

  // --- effect C: keep exactly one connection per other participant ----------
  // Re-runs on every room-state snapshot. It only acts on the *difference*
  // between the roster and our current connections, so running it often is cheap.
  useEffect(() => {
    if (!inCall || !selfId || !localStream) return;

    const others = new Set(participants.map((p) => p.id).filter((id) => id !== selfId));

    // New people -> open a connection. Deterministic rule: for each pair, the
    // peer whose socket id sorts GREATER makes the offer; the other just
    // prepares to answer. Guarantees exactly one offer per pair, no collision.
    for (const peerId of others) {
      if (peersRef.current.has(peerId)) continue;
      if (selfId > peerId) callPeer(peerId);
      else addPeer(peerId);
    }

    // People who left -> close their connection.
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
  // server only when the answer to "am I talking?" flips. The server times the
  // silence and elects the room's active speaker; this side just reports.
  //
  //   - RMS of the raw waveform is the loudness measure (0..1). Speech sits
  //     around 0.05-0.2; a quiet room is well under 0.01.
  //   - Rising edge fires immediately (feels responsive). Falling edge waits
  //     out a short HANGOVER so the glow doesn't strobe between words.
  //   - A disabled mic track (muted, or a listener) counts as silence, so
  //     muting yourself drops your glow without any extra wiring.
  //
  // Only speakers and the host run this. Listeners are force-muted and never
  // the active speaker, so there's nothing to measure.
  useEffect(() => {
    if (!inCall || !localStream || isListener) return undefined;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return undefined;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return undefined;

    const ctx = new AudioCtx();
    // Joining was a user gesture, so this should already be 'running'; resume
    // anyway in case the browser suspended it.
    ctx.resume?.();
    const source = ctx.createMediaStreamSource(localStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // note: NOT connected to ctx.destination — we
    //                           analyse the mic, we don't play it back
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
      // Tell the server we've stopped (leaving, or becoming a listener) — but
      // only if we'd claimed to be talking, so it never sees a bare "false".
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
  // Disabled audio => peers receive silence. Disabled video => peers receive a
  // black frame. No renegotiation, instant, reversible.
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

  return {
    localStream,
    remotes,
    micOn,
    camOn,
    toggleMic,
    toggleCam,
    mediaError,
    myRole,
    isListener,
  };
}
