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
