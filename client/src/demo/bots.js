// The pretend participants' side of the video connections (demo only).
//
// The real call screen connects to everyone the normal way (webrtc.js: one
// connection per person, offers / answers / ICE candidates sent over the
// socket as EVENTS.RTC_SIGNAL). Here, each pretend participant answers those
// offers. On /demo the app's connections are the lightweight stand-in from
// fakePeer.js (env.js swaps it in), so an "answer" is just a label naming
// this person's drawn camera (cameras.js) — the stand-in hands that video
// straight to the app. No real video connection, so nothing gets compressed
// and decompressed: that's what used to make the demo heavy.
//
// The call screen always makes the offer (see `polite` in webrtc.js — the
// demo's ids make the visitor's side the offerer); a pretend participant
// only ever answers.

import { drawnCamera } from './cameras.js';
import { endCamera, offerCamera } from './fakePeer.js';

export class BotPeers {
  /**
   * @param {Function} send  (botId, { description }) -> to the app
   * @param {Function} look  botId -> { name, color }
   */
  constructor(send, look) {
    this.send = send;
    this.look = look;
    this.peers = new Map(); // botId -> label of the camera they're "sending"
  }

  /** A signaling message from the app to one pretend participant. */
  handle(botId, { description }) {
    // Only offers need a reply; ICE candidates mean nothing to the stand-in.
    if (description?.type !== 'offer') return;
    // Same camera for every offer on one connection (the app re-offers when,
    // say, it starts sharing a screen) — the stand-in won't hand it over twice.
    let label = this.peers.get(botId);
    if (!label) {
      const { name, color } = this.look(botId);
      // Video only: they're pretend (silent) anyway, and a video without
      // sound may start playing before the visitor's first click (browsers
      // hold back anything with sound until then).
      const stream = new MediaStream(drawnCamera(botId, name, color).getVideoTracks());
      label = offerCamera(stream);
      this.peers.set(botId, label);
    }
    // (a moment later, like a real reply)
    setTimeout(() => this.send(botId, { description: { type: 'answer', sdp: label } }), 0);
  }

  /** Close one participant's connection (they left the visitor's room). */
  close(botId) {
    const label = this.peers.get(botId);
    if (!label) return;
    endCamera(label); // their video ends on the app's side, like a hang-up
    this.peers.delete(botId);
  }

  /** Keep only the connections to people in the visitor's room. */
  keepOnly(ids) {
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.close(id);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.close(id);
  }
}
