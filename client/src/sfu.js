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
//   4. switch cameras to the size they're shown at  (SFU_LAYERS — simulcast)
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
import { reportCallProblem } from './errorReport.js';

// Cloudflare's own STUN server, plus the TURN relay the server handed us (for
// networks that block direct routes, e.g. strict office / school Wi-Fi).
const CF_STUN = { urls: 'stun:stun.cloudflare.com:3478' };

// Kinds of track I can send. Each is published separately.
const KINDS = ['audio', 'video', 'screen', 'screenAudio'];

// Simulcast: my camera goes up in three sizes at once ("layers"), and each
// viewer gets the one that suits them — full size for the big tile, smaller
// ones for a grid or a strip of thumbnails, and Cloudflare steps a viewer
// down by itself when their connection can't keep up. Named so alphabetical
// order is best-first (Cloudflare's "asciibetical" preference):
//   a  full size (720p)     up to ~1 Mbit/s
//   b  half      (360p)     up to ~300 kbit/s
//   c  quarter   (180p)     up to ~100 kbit/s
// The two small ones add only ~40% to my upload. (Screen shares stay one
// full-size layer — text must stay sharp.)
const CAMERA_LAYERS = [
  { rid: 'a', maxBitrate: 1_000_000 },
  { rid: 'b', scaleResolutionDownBy: 2, maxBitrate: 300_000 },
  { rid: 'c', scaleResolutionDownBy: 4, maxBitrate: 100_000 },
];
// Which layer to ask for, from how wide that person's video is on my screen
// (in real pixels): wider than FULL_FROM_PX gets 'a', wider than HALF_FROM_PX
// 'b', anything smaller — or not on screen at all — 'c'. Checked every
// LAYER_CHECK_MS, so it follows layout changes (spotlight, grid, someone
// presenting, the floating window) without the screens having to say.
const FULL_FROM_PX = 700;
const HALF_FROM_PX = 340;
const LAYER_CHECK_MS = 2000;
// A video only goes DOWN a size after its tile has been smaller for this many
// checks in a row (~4 s) — see the size check below for why.
const SHRINK_AFTER_CHECKS = 2;

// A track Cloudflare couldn't hand over yet is asked for again — usually
// someone who JUST joined: their track is listed before their video has
// started flowing ("not found"), which takes a second or two. So the first
// retries come quickly (PULL_RETRY_MS, twice each), then further apart up
// to PULL_RETRY_MAX_MS — for as long as it's listed, so nobody's video
// stays missing for good.
const PULL_RETRY_MS = 1000;
const PULL_RETRY_MAX_MS = 30_000;

// My connection struggling (receiving): if more than LOSS_HIGH of the video
// packets coming in get lost, every camera I receive drops one size (twice
// at most); after RECOVER_CHECKS checks in a row under LOSS_LOW, back up one.
const LOSS_HIGH = 0.04;
const LOSS_LOW = 0.01;
const RECOVER_CHECKS = 15; // × LAYER_CHECK_MS = 30 s of smooth video

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
 * @param {boolean}     [args.recording]    I'm recording the meeting: nobody
 *                                          below half size (the recording is
 *                                          drawn bigger than my thumbnails)
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
  recording = false,
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
  // The cameras among them (their size can be chosen — simulcast).
  const cams = new Set(
    Object.entries(media ?? {})
      .filter(([id, kinds]) => id !== selfId && kinds.video)
      .map(([, kinds]) => kinds.video),
  );
  const wantRef = useRef({ send, receive, cams });
  wantRef.current = { send, receive, cams };
  const iceRef = useRef(iceServers);
  iceRef.current = iceServers;
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  // camera key -> the layer (size) I want for it right now (see measure()).
  const layersRef = useRef(new Map());

  // --- the connection, and what it's doing ----------------------------------
  // pc:       the RTCPeerConnection to Cloudflare (null until needed)
  // sending:  kind -> { transceiver, track }
  // getting:  key -> { transceiver, rid } (rid: the layer asked for, cameras)
  // refused:  track ids the server won't take (see isRefusal)
  // misses:   key -> { tries, next } for tracks Cloudflare couldn't hand over
  //           yet: how many times, and when to ask again
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
    reportCallProblem('Cloudflare video connection started over', why);
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
      // My camera in three sizes (CAMERA_LAYERS); anything else as it is.
      const transceiver = c.pc.addTransceiver(track, {
        direction: 'sendonly',
        ...(kind === 'video' ? { sendEncodings: CAMERA_LAYERS } : {}),
      });
      return { kind, track, transceiver };
    });
    if (!adding.length) return;

    const sdp = await offer(c.pc);
    let ack;
    try {
      ack = await ask(EVENTS.SFU_PUBLISH, {
        sdp,
        tracks: adding.map(({ kind, transceiver }) => ({
          kind,
          mid: transceiver.mid,
          simulcast: kind === 'video',
        })),
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
    const now = Date.now();
    const keys = [...want.receive].filter(
      (key) => !c.getting.has(key) && (c.misses.get(key)?.next ?? 0) <= now,
    );
    if (!keys.length) return;

    // Cameras: start at the size they're shown at (half until measured).
    const rids = {};
    for (const key of keys) if (want.cams.has(key)) rids[key] = layersRef.current.get(key) ?? 'b';
    const ack = await ask(EVENTS.SFU_PULL, { keys, rids });
    if (ack.sdp) {
      await c.pc.setRemoteDescription({ type: 'offer', sdp: ack.sdp });
      const answer = await c.pc.createAnswer();
      await c.pc.setLocalDescription(answer);
      await ask(EVENTS.SFU_ANSWER, { sdp: answer.sdp });
    }

    const got = [];
    for (const t of ack.tracks ?? []) {
      const transceiver = t.mid != null && c.pc.getTransceivers().find((x) => x.mid === t.mid);
      if (transceiver) {
        c.getting.set(t.key, { transceiver, rid: rids[t.key] ?? null });
        c.misses.delete(t.key);
        got.push([t.key, transceiver.receiver.track]);
      } else {
        // Not yet: try again later, waiting longer each time.
        const tries = (c.misses.get(t.key)?.tries ?? 0) + 1;
        // 1 s, 1 s, 2 s, 2 s, 4 s, 4 s, 8 s … up to 30 s
        const wait = Math.min(PULL_RETRY_MS * 2 ** Math.floor((tries - 1) / 2), PULL_RETRY_MAX_MS);
        c.misses.set(t.key, { tries, next: Date.now() + wait });
      }
    }
    if (got.length) setReceived((prev) => new Map([...prev, ...got]));
    // Come back when the soonest retry is due.
    const soonest = Math.min(...[...c.misses.values()].map((m) => m.next));
    if (Number.isFinite(soonest)) {
      const run = runRef.current;
      clearTimeout(run.timer);
      run.timer = setTimeout(() => sync(), Math.max(0, soonest - Date.now()));
    }
  }

  // 4. Switch cameras I'm receiving to the size they're shown at now.
  async function updateLayers(c, want) {
    const changes = [];
    for (const [key, g] of c.getting) {
      const rid = layersRef.current.get(key);
      if (!want.cams.has(key) || !rid || rid === g.rid) continue;
      changes.push({ key, mid: g.transceiver.mid, rid });
    }
    if (!changes.length) return;
    const ack = await ask(EVENTS.SFU_LAYERS, { changes });
    // (Cloudflare rarely wants a fresh offer/answer for this — handled anyway.)
    if (ack.sdp) {
      await c.pc.setRemoteDescription({ type: 'offer', sdp: ack.sdp });
      const answer = await c.pc.createAnswer();
      await c.pc.setLocalDescription(answer);
      await ask(EVENTS.SFU_ANSWER, { sdp: answer.sdp });
    }
    for (const { key, rid } of changes) {
      const g = c.getting.get(key);
      if (g) g.rid = rid;
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
        await updateLayers(c, want);
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
  // --- simulcast: which size of each camera to ask for ---------------------
  // Every LAYER_CHECK_MS, look at how wide each person's video is actually
  // shown (the widest of their tiles, in real pixels — the floating window
  // too), pick the layer that fits (see FULL_FROM_PX), and switch any that
  // changed. Looking at the screen itself means it just works for every
  // layout, desktop or phone.
  useEffect(() => {
    if (!active) return undefined;

    // How much incoming video is getting lost — my connection struggling.
    // `step` is how many sizes everyone is dropped by right now (0-2).
    const health = { lost: 0, got: 0, step: 0, calm: 0 };
    // camera key -> how many checks in a row it has wanted a smaller size
    const shrinking = new Map();
    const updateHealth = async () => {
      const pc = connRef.current.pc;
      if (!pc || pc.connectionState !== 'connected') return;
      let lost = 0;
      let got = 0;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          lost += r.packetsLost ?? 0;
          got += r.packetsReceived ?? 0;
        }
      });
      const newLost = Math.max(0, lost - health.lost);
      const newGot = Math.max(0, got - health.got);
      health.lost = lost;
      health.got = got;
      if (newGot + newLost < 50) return; // too little to judge
      const loss = newLost / (newGot + newLost);
      if (loss > LOSS_HIGH && health.step < 2) {
        health.step += 1;
        health.calm = 0;
      } else if (loss < LOSS_LOW && health.step > 0 && ++health.calm >= RECOVER_CHECKS) {
        health.step -= 1;
        health.calm = 0;
      } else if (loss >= LOSS_LOW) {
        health.calm = 0;
      }
    };

    const check = async () => {
      await updateHealth().catch(() => {});
      const widths = new Map(); // MediaStream id -> widest it's shown
      const pipDoc = window.documentPictureInPicture?.window?.document;
      for (const doc of [document, pipDoc]) {
        if (!doc) continue;
        const dpr = doc.defaultView?.devicePixelRatio || 1;
        for (const v of doc.querySelectorAll('video')) {
          const id = v.srcObject?.id;
          const w = v.clientWidth * dpr; // 0 when it isn't on screen
          if (id && w > (widths.get(id) ?? 0)) widths.set(id, w);
        }
      }
      let changed = false;
      for (const [id, kinds] of Object.entries(mediaRef.current ?? {})) {
        if (!kinds.video) continue;
        const stream = streamsRef.current.get(`${id}:cam`);
        const w = (stream && widths.get(stream.id)) || 0;
        let size = w > FULL_FROM_PX ? 0 : w > HALF_FROM_PX ? 1 : 2; // a, b, c
        if (recordingRef.current) size = Math.min(size, 1); // (see `recording`)
        size = Math.min(2, size + health.step); // a struggling connection
        const rid = 'abc'[size];
        const key = kinds.video;
        const now = layersRef.current.get(key);
        // Bigger (or the first choice): straight away. Smaller: only once it
        // has stayed smaller for SHRINK_AFTER_CHECKS checks in a row. A
        // switched video shows nothing until its next full picture arrives
        // (a second or more on a real network) — and a layout change (a
        // share starting or stopping) puts everyone in brand-new tiles at
        // the same moment, which have no old picture to show meanwhile.
        // Shrinking straight away made everyone vanish for a moment.
        const smaller = now && rid > now; // 'c' > 'b' > 'a'
        if (smaller) {
          const n = (shrinking.get(key) ?? 0) + 1;
          shrinking.set(key, n);
          if (n < SHRINK_AFTER_CHECKS) continue;
        }
        shrinking.delete(key);
        if (now !== rid) {
          layersRef.current.set(key, rid);
          changed = true;
        }
      }
      if (changed) sync();
    };
    const timer = setInterval(check, LAYER_CHECK_MS);
    return () => clearInterval(timer);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

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
