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
// a post-v1 rewrite.

import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS } from '@listen/shared';
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
  const [localStream, setLocalStream] = useState(null);
  const [remotes, setRemotes] = useState([]); // [{ id, stream }]
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [mediaError, setMediaError] = useState(null);

  // peerId -> { pc: RTCPeerConnection, stream: MediaStream|null }
  const peersRef = useRef(new Map());
  const localStreamRef = useRef(null);
  // signals that arrived before the local stream was ready — replayed later.
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
  // candidate. One deterministic offer per pair (see effect C), so there is
  // never a "glare" collision to resolve.
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
  // Deterministic rule: for each pair, the peer whose socket id sorts GREATER
  // makes the offer; the other prepares to answer. Exactly one offer per pair.
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

  // --- controls: flip the track's `enabled` flag ---------------------------
  const toggleMic = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, []);

  const toggleCam = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  }, []);

  return { localStream, remotes, micOn, camOn, toggleMic, toggleCam, mediaError };
}
