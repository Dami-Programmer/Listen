// The call's media through Cloudflare's SFU (the "video desk").
//
// Used instead of the mesh in webrtc.js when the server says `sfu: true`.
// Mesh: every browser sends its camera to every other browser (N-1 uploads).
// SFU: every browser keeps ONE connection, to Cloudflare, sends each of its
// tracks there ONCE, and receives everyone else's from there.
//
// How it works — "say what you want, then make it so":
//   - what I should SEND: my mic (unless I'm a listener), my camera (while
//     it's on), my screen / presentation (while I'm sharing)
//   - what I should RECEIVE: every track listed in the room snapshot's
//     `media` map, except my own
// Whenever either list changes, `sync` compares it with what the connection
// is doing right now and fixes the difference, one step at a time:
//   1. stop what's no longer wanted     (SFU_CLOSE)
//   2. send what's newly wanted         (SFU_PUBLISH)
//   3. receive what's newly listed      (SFU_PULL, then SFU_ANSWER)
// Each step is a WebRTC offer/answer with Cloudflare, made through our
// server (it holds the Cloudflare secret and checks every request).
// Steps never overlap: Cloudflare needs one finished before the next starts.
//
// Small changes never touch Cloudflare: muting the mic just silences the
// track, and switching camera / mic swaps the track in place (replaceTrack).
//
// If anything goes wrong (Cloudflare or the network), the whole connection
// is thrown away and built again a moment later — everyone else's screens
// pick up the new tracks by themselves.

import { useEffect, useRef, useState } from 'react';
import { EVENTS } from '@listen/shared';
import { socket } from './socket.js';

// Cloudflare's own STUN server, plus the TURN relay the server handed us (for
// networks that block direct routes, e.g. strict office / school Wi-Fi).
const CF_STUN = { urls: 'stun:stun.cloudflare.com:3478' };

// Kinds of track I can send. Each is published separately.
const KINDS = ['audio', 'video', 'screen', 'screenAudio'];

// A camera at most this many bits per second. Everyone receives every camera
// at the quality it's sent (no per-viewer versions yet), so keep it modest:
// still sharp at 720p, and easy on phones and mobile data.
const CAMERA_MAX_BITRATE = 1_000_000;

// A track Cloudflare couldn't hand over yet (e.g. it was published a moment
// ago) is asked for again after this, up to PULL_TRIES times.
const PULL_RETRY_MS = 1500;
const PULL_TRIES = 5;

// How long a new connection to Cloudflare may take to come up (slow mobile
// networks, a TURN relay) before we give up on it and start over.
const CONNECT_MS = 15_000;

// Starting over after a failure: wait this long, doubling each time up to
// REBUILD_MAX_MS, so a Cloudflare outage isn't hammered.
const REBUILD_MS = 1000;
const REBUILD_MAX_MS = 15_000;

// Ask our server for something and wait for its reply. Throws if it says no
// (the error text is on `err.message`) or doesn't answer in time.
async function ask(event, payload = {}) {
  const ack = await socket.timeout(15_000).emitWithAck(event, payload);
  if (!ack?.ok) throw new Error(ack?.error || `${event} failed`);
  return ack;
}

// Server refusals that starting over won't fix (e.g. a listener's mic, or a
// share the room didn't accept): skip that track until it changes.
const isRefusal = (err) => /^(not allowed|already sending)/.test(err?.message ?? '');

/**
 * @param {object}       args
 * @param {boolean}      args.active        in the call, with the SFU on
 * @param {string|null}  args.selfId        my socket id
 * @param {object}       args.media         snapshot `media`: socketId -> { kind: key }
 * @param {MediaStream}  args.localStream   my camera + mic
 * @param {boolean}      args.camOn         my camera is on
 * @param {boolean}      args.isListener    I may not send audio
 * @param {MediaStream}  args.screenStream  my screen / presentation, or null
 * @param {Array}       [args.iceServers]   TURN relay from the server
 * @returns {{ remotes: Array, remoteScreens: Array }}  like the mesh's
 */
export function useSfu({
  active,
  selfId,
  media,
  localStream,
  camOn,
  isListener,
  screenStream,
  iceServers,
}) {
  // key -> the MediaStreamTrack I'm receiving for it. Drives the render.
  const [received, setReceived] = useState(() => new Map());

  // --- what I want right now (read by `sync`, which runs later) -------------
  const audio = localStream?.getAudioTracks()[0];
  const video = localStream?.getVideoTracks()[0];
  const send = {
    audio: !isListener && audio?.readyState === 'live' ? audio : null,
    video: camOn && video?.readyState === 'live' ? video : null,
    screen: screenStream?.getVideoTracks()[0] ?? null,
    screenAudio: screenStream?.getAudioTracks()[0] ?? null,
  };
  const mine = new Set(Object.values(media?.[selfId] ?? {}));
  const receive = new Set();
  for (const [id, kinds] of Object.entries(media ?? {})) {
    if (id === selfId) continue;
    for (const key of Object.values(kinds)) if (!mine.has(key)) receive.add(key);
  }
  const wantRef = useRef({ send, receive });
  wantRef.current = { send, receive };
  const iceRef = useRef(iceServers);
  iceRef.current = iceServers;

  // --- the connection, and what it's doing ----------------------------------
  // pc:       the RTCPeerConnection to Cloudflare (null until needed)
  // sending:  kind -> { transceiver, track }
  // getting:  key -> { transceiver }
  // refused:  track ids the server won't take (see isRefusal)
  // misses:   key -> how many times Cloudflare couldn't hand it over
  const connRef = useRef(null);
  const fresh = () => ({
    pc: null,
    sending: new Map(),
    getting: new Map(),
    refused: new Set(),
    misses: new Map(),
  });
  if (!connRef.current) connRef.current = fresh();

  // `sync` bookkeeping: one at a time; `again` = something changed meanwhile.
  const runRef = useRef({ busy: false, again: false, timer: null, backoff: REBUILD_MS });
  const activeRef = useRef(active);
  activeRef.current = active;

  // Throw the connection away (stop everything; nothing received any more).
  const teardown = () => {
    const c = connRef.current;
    if (c.pc) {
      c.pc.onconnectionstatechange = null;
      c.pc.close();
    }
    connRef.current = fresh();
    setReceived(new Map());
  };

  // Something failed: start over after a pause that grows on repeated failures.
  const rebuildLater = (why) => {
    const run = runRef.current;
    console.warn(`[sfu] starting the video connection over (${why})`);
    teardown();
    clearTimeout(run.timer);
    run.timer = setTimeout(() => sync(), run.backoff);
    run.backoff = Math.min(run.backoff * 2, REBUILD_MAX_MS);
  };

  // Wait until the connection to Cloudflare is actually up before changing
  // it again. A change sent while it's still connecting (the very first
  // seconds) can leave it stuck there for good. Nothing negotiated yet:
  // nothing to wait for.
  function settled(pc) {
    if (!pc.remoteDescription || pc.connectionState === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearTimeout(timer);
        pc.removeEventListener('connectionstatechange', check);
        fn(arg);
      };
      const check = () => {
        if (pc.connectionState === 'connected') done(resolve);
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          done(reject, new Error(`connection ${pc.connectionState}`));
        }
      };
      const timer = setTimeout(() => done(reject, new Error('connection timed out')), CONNECT_MS);
      pc.addEventListener('connectionstatechange', check);
    });
  }

  // My offer for whatever just changed on the connection.
  async function offer(pc) {
    const desc = await pc.createOffer();
    await pc.setLocalDescription(desc);
    return desc.sdp;
  }

  // A brand-new connection + Cloudflare session.
  async function open() {
    const pc = new RTCPeerConnection({
      iceServers: [CF_STUN, ...(iceRef.current ?? [])],
      bundlePolicy: 'max-bundle', // Cloudflare carries everything on one route
    });
    connRef.current.pc = pc;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && connRef.current.pc === pc) {
        rebuildLater('connection failed');
      }
    };
    await ask(EVENTS.SFU_SESSION);
  }

  // 1. Stop sending / receiving whatever isn't wanted any more.
  async function closeUnwanted(c, want) {
    const mids = [];
    // Stop one track. The connection's FIRST track is special: the browser
    // carries every track over that one's route ("bundle"), so stopping it
    // would cut the whole connection. That one is only switched to idle
    // (and never used again); every other track is stopped for real.
    const anchor = c.pc.currentLocalDescription?.sdp.match(/a=group:BUNDLE (\S+)/)?.[1];
    const retire = (transceiver) => {
      mids.push(transceiver.mid);
      if (transceiver.mid !== anchor) {
        transceiver.stop();
        return;
      }
      transceiver.sender.replaceTrack(null).catch(() => {});
      transceiver.direction = 'inactive';
    };
    for (const [kind, s] of c.sending) {
      const track = want.send[kind];
      if (track && track !== s.track) {
        // Same kind, different track (switched camera / mic): swap in place.
        await s.transceiver.sender.replaceTrack(track);
        s.track = track;
      } else if (!track) {
        retire(s.transceiver);
        c.sending.delete(kind);
      }
    }
    let lost = false;
    for (const [key, g] of c.getting) {
      if (want.receive.has(key)) continue;
      retire(g.transceiver);
      c.getting.delete(key);
      lost = true;
    }
    for (const key of c.misses.keys()) if (!want.receive.has(key)) c.misses.delete(key);
    if (lost) {
      setReceived((prev) => new Map([...prev].filter(([key]) => c.getting.has(key))));
    }
    if (!mids.length) return;
    const sdp = await offer(c.pc);
    const ack = await ask(EVENTS.SFU_CLOSE, { mids, sdp });
    await c.pc.setRemoteDescription({ type: 'answer', sdp: ack.sdp });
  }

  // 2. Start sending whatever's newly wanted (all in one offer).
  async function publishWanted(c, want) {
    const adding = KINDS.filter(
      (kind) => want.send[kind] && !c.sending.has(kind) && !c.refused.has(want.send[kind].id),
    ).map((kind) => {
      const track = want.send[kind];
      const transceiver = c.pc.addTransceiver(track, { direction: 'sendonly' });
      if (kind === 'video') {
        const params = transceiver.sender.getParameters();
        params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: CAMERA_MAX_BITRATE }];
        transceiver.sender.setParameters(params).catch(() => {});
      }
      return { kind, track, transceiver };
    });
    if (!adding.length) return;

    const sdp = await offer(c.pc);
    let ack;
    try {
      ack = await ask(EVENTS.SFU_PUBLISH, {
        sdp,
        tracks: adding.map(({ kind, transceiver }) => ({ kind, mid: transceiver.mid })),
      });
    } catch (err) {
      if (!isRefusal(err)) throw err;
      // Not allowed (yet): take the offer back, drop these, don't ask again
      // for these same tracks. (A new track — e.g. the floor was granted and
      // the mic reopened — gets asked for normally.)
      await c.pc.setLocalDescription({ type: 'rollback' });
      for (const a of adding) {
        a.transceiver.stop();
        c.refused.add(a.track.id);
      }
      return;
    }
    await c.pc.setRemoteDescription({ type: 'answer', sdp: ack.sdp });
    for (const a of adding) {
      if (ack.failed?.includes(a.kind)) a.transceiver.stop();
      else c.sending.set(a.kind, { transceiver: a.transceiver, track: a.track });
    }
  }

  // 3. Start receiving every newly listed track (all in one request).
  async function pullWanted(c, want) {
    const keys = [...want.receive].filter(
      (key) => !c.getting.has(key) && (c.misses.get(key) ?? 0) < PULL_TRIES,
    );
    if (!keys.length) return;

    const ack = await ask(EVENTS.SFU_PULL, { keys });
    if (ack.sdp) {
      await c.pc.setRemoteDescription({ type: 'offer', sdp: ack.sdp });
      const answer = await c.pc.createAnswer();
      await c.pc.setLocalDescription(answer);
      await ask(EVENTS.SFU_ANSWER, { sdp: answer.sdp });
    }

    const got = [];
    let missed = false;
    for (const t of ack.tracks ?? []) {
      const transceiver = t.mid != null && c.pc.getTransceivers().find((x) => x.mid === t.mid);
      if (transceiver) {
        c.getting.set(t.key, { transceiver });
        c.misses.delete(t.key);
        got.push([t.key, transceiver.receiver.track]);
      } else {
        c.misses.set(t.key, (c.misses.get(t.key) ?? 0) + 1);
        missed = true;
      }
    }
    if (got.length) setReceived((prev) => new Map([...prev, ...got]));
    // Ask again for the ones Cloudflare couldn't hand over yet.
    if (missed) {
      const run = runRef.current;
      clearTimeout(run.timer);
      run.timer = setTimeout(() => sync(), PULL_RETRY_MS);
    }
  }

  // Make the connection match what's wanted. Re-runs until nothing changed
  // while it worked. Only ever one running.
  async function sync() {
    const run = runRef.current;
    if (run.busy) {
      run.again = true;
      return;
    }
    run.busy = true;
    let c = null;
    try {
      do {
        run.again = false;
        // Not in the call, or our server can't hear us (reconnecting): wait.
        // (A reconnect re-runs this — see the 'connect' listener below.)
        if (!activeRef.current || !socket.connected) break;
        c = connRef.current;
        if (!c.pc) await open();
        if (connRef.current !== c) {
          run.again = true; // started over meanwhile: go again, on the new one
          continue;
        }
        const want = wantRef.current;
        await closeUnwanted(c, want);
        await settled(c.pc);
        await publishWanted(c, want);
        await settled(c.pc);
        await pullWanted(c, want);
        run.backoff = REBUILD_MS; // all good
      } while (run.again);
    } catch (err) {
      // (Already started over — e.g. the connection failed mid-step, which is
      // why this step broke — then there's nothing more to do.)
      if (activeRef.current && connRef.current === c) {
        rebuildLater(err?.message || String(err));
      }
    } finally {
      run.busy = false;
    }
  }

  // Re-sync whenever what I want changes. The key lists every track by id,
  // so e.g. a camera switch or a newly listed track counts as a change.
  const wantKey = [
    active,
    selfId,
    ...KINDS.map((kind) => send[kind]?.id ?? '-'),
    ...[...receive].sort(),
  ].join('|');
  useEffect(() => {
    // Something changed, so a track the server refused before (e.g. my mic
    // while I was still a listener) may be fine now.
    connRef.current.refused.clear();
    sync();
  }, [wantKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Our server came back after a drop: carry on (anything that failed while
  // it was gone gets retried).
  useEffect(() => {
    const onConnect = () => sync();
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the call (or the SFU switched off): close everything.
  useEffect(() => {
    if (active) return undefined;
    teardown();
    return undefined;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // The call screen closing. Also left in a clean state (`fresh`), because in
  // development React runs this and then mounts the screen again straight
  // away — the next sync must build a new connection, not reuse a closed one.
  useEffect(
    () => () => {
      clearTimeout(runRef.current.timer);
      const { pc } = connRef.current;
      if (pc) {
        pc.onconnectionstatechange = null;
        pc.close();
      }
      connRef.current = fresh();
    },
    [],
  );

  // --- what the UI shows: one camera stream + one screen stream per person --
  // A MediaStream is reused while its tracks stay the same, so video tiles
  // don't flicker on unrelated changes.
  const streamsRef = useRef(new Map()); // "id:cam" / "id:screen" -> MediaStream
  const streamOf = (name, tracks) => {
    const old = streamsRef.current.get(name);
    const ids = tracks.map((t) => t.id).join();
    if (
      old &&
      old
        .getTracks()
        .map((t) => t.id)
        .join() === ids
    )
      return old;
    const next = new MediaStream(tracks);
    streamsRef.current.set(name, next);
    return next;
  };
  const remotes = [];
  const remoteScreens = [];
  for (const [id, kinds] of Object.entries(media ?? {})) {
    if (id === selfId) continue;
    const pick = (...ks) => ks.map((k) => received.get(kinds[k])).filter(Boolean);
    const cam = pick('audio', 'video');
    const screen = pick('screen', 'screenAudio');
    if (cam.length) remotes.push({ id, stream: streamOf(`${id}:cam`, cam) });
    if (screen.length) remoteScreens.push({ id, stream: streamOf(`${id}:screen`, screen) });
  }

  return { remotes, remoteScreens };
}
