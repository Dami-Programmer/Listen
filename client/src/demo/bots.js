// The pretend participants' side of the video connections (demo only).
//
// The real call screen connects to everyone the normal way (webrtc.js: one
// RTCPeerConnection per person, offers / answers / ICE candidates sent over
// the socket as EVENTS.RTC_SIGNAL). Here, each pretend participant answers
// those offers with a real RTCPeerConnection inside this same page, sending
// its drawn camera (cameras.js). So the app's own WebRTC
// code receives real video tracks — nothing is faked inside the app.
//
// The call screen always makes the offer (see `polite` in webrtc.js — the
// demo's ids make the visitor's side the offerer); a pretend participant
// only ever answers.

import { drawnCamera } from './cameras.js';

export class BotPeers {
  /**
   * @param {Function} send  (botId, { description } | { candidate }) -> to the app
   * @param {Function} look  botId -> { name, color }
   */
  constructor(send, look) {
    this.send = send;
    this.look = look;
    this.peers = new Map(); // botId -> { pc, chain, early: [] }
  }

  /** A signaling message from the app to one pretend participant. */
  handle(botId, msg) {
    let peer = this.peers.get(botId);
    if (!peer) {
      peer = { pc: null, chain: Promise.resolve(), early: [] };
      this.peers.set(botId, peer);
    }
    // one message at a time, in order (an offer before its candidates)
    peer.chain = peer.chain.then(() => this.apply(botId, peer, msg)).catch(() => {});
  }

  async apply(botId, peer, { description, candidate }) {
    if (description?.type === 'offer') {
      try {
        await this.answer(botId, peer, description);
      } catch {
        // The app rebuilt its side of the connection: start ours over too.
        this.close(botId, { keep: true });
        await this.answer(botId, peer, description);
      }
    } else if (candidate) {
      if (!peer.pc || !peer.pc.remoteDescription) {
        peer.early.push(candidate);
        return;
      }
      await peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async answer(botId, peer, offer) {
    if (!peer.pc) peer.pc = this.newPc(botId);
    const { pc } = peer;
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription();
    this.send(botId, { description: pc.localDescription });
    for (const c of peer.early.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  }

  newPc(botId) {
    // No STUN / TURN: both ends are in this page, so the local route works.
    const pc = new RTCPeerConnection({ iceServers: [] });
    const { name, color } = this.look(botId);
    const cam = drawnCamera(botId, name, color);
    // Video only: they're pretend (silent) anyway, and a video without sound
    // may start playing before the visitor's first click (browsers hold back
    // anything with sound until then).
    const stream = new MediaStream(cam.getVideoTracks());
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(botId, { candidate });
    };
    return pc;
  }

  /** Close one participant's connection (they left the visitor's room). */
  close(botId, { keep = false } = {}) {
    const peer = this.peers.get(botId);
    if (!peer) return;
    try {
      peer.pc?.close();
    } catch {
      // already closed
    }
    peer.pc = null;
    peer.early = [];
    if (!keep) this.peers.delete(botId);
  }

  /** Keep only the connections to people in the visitor's room. */
  keepOnly(ids) {
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.close(id);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.close(id);
  }
}
