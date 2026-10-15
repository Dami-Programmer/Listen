// A stand-in for the browser's RTCPeerConnection, used only on /demo.
//
// WHY: the demo used to connect the call screen to each pretend participant
// with a REAL video connection inside the page. That works, but the browser
// then compresses every drawn camera into video and decompresses it again on
// the other side — six or seven videos, many times a second, per demo frame.
// That's most of what made the landing page slow and hot on weaker machines.
//
// WHAT THIS DOES INSTEAD: the app's own call code (webrtc.js) runs exactly as
// in a real meeting — it still creates a connection per person, sends its
// offer over the (demo) socket, gets an answer back and waits for tracks. Only
// the connection object is this lightweight copy:
//
//   - the app's offer / answer are just small labels, no real video setup
//   - the pretend participant's answer names its drawn camera (see
//     offerCamera below), and the matching video is handed straight to the
//     app's `ontrack` — no compressing, no network, no decompressing
//   - the visitor's own camera is "sent" to nobody (the pretend people don't
//     look at it), so it costs nothing either
//
// It only covers what webrtc.js actually uses: addTrack / removeTrack /
// getSenders (+ replaceTrack), setLocalDescription / setRemoteDescription,
// addIceCandidate, restartIce, close, and the events onnegotiationneeded,
// onicecandidate (never fires — nothing to find), ontrack and
// onconnectionstatechange. If webrtc.js starts using more, add it here.

// --- the pretend participants' side --------------------------------------
// bots.js puts each answer's drawn camera here under a one-off label; the
// app's connection picks it up when that answer arrives.
const cameras = new Map(); // label -> MediaStream
let nextLabel = 1;

/**
 * Make a camera available to the app's connection. Returns the label to put
 * in the answer (`sdp`) — setRemoteDescription below looks it up.
 */
export function offerCamera(stream) {
  const label = `turnly-demo-camera:${nextLabel++}`;
  cameras.set(label, stream);
  return label;
}

/**
 * The pretend participant hung up: end its camera, the way a real remote
 * video ends. Stopping a track doesn't fire its 'ended' event by itself, so
 * we fire it — the app listens for it to drop that person's tile.
 */
export function endCamera(label) {
  const stream = cameras.get(label);
  if (!stream) return;
  cameras.delete(label);
  for (const track of stream.getTracks()) {
    track.stop();
    track.dispatchEvent(new Event('ended'));
  }
}

// --- the app's side -------------------------------------------------------

// One thing the app is sending (its camera, mic or screen). replaceTrack is
// how webrtc.js swaps a camera / mic without reconnecting.
class DemoSender {
  constructor(track) {
    this.track = track;
  }

  async replaceTrack(track) {
    this.track = track;
  }
}

export class DemoPeerConnection {
  constructor() {
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.senders = [];
    this.delivered = new Set(); // camera labels already handed to `ontrack`
    this.negotiationQueued = false; // changed mid-offer: offer again once stable
    this.negotiationScheduled = false; // a "negotiation needed" is about to fire
    // the events webrtc.js sets (all optional)
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }

  // --- what the app sends ---------------------------------------------------

  addTrack(track) {
    const sender = new DemoSender(track);
    this.senders.push(sender);
    this.needNegotiation();
    return sender;
  }

  removeTrack(sender) {
    this.senders = this.senders.filter((s) => s !== sender);
    this.needNegotiation();
  }

  getSenders() {
    return [...this.senders];
  }

  // --- offer / answer -------------------------------------------------------

  // Called with no argument (webrtc.js always does): make an offer, or the
  // answer to an offer we just received — same as the real thing.
  async setLocalDescription(description) {
    if (this.signalingState === 'closed') throw new Error('connection closed');
    if (description?.type === 'rollback') {
      this.signalingState = 'stable';
      return;
    }
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: 'turnly-demo-answer' };
      this.becomeStable();
    } else {
      this.localDescription = { type: 'offer', sdp: 'turnly-demo-offer' };
      this.signalingState = 'have-local-offer';
    }
  }

  async setRemoteDescription(description) {
    if (this.signalingState === 'closed') throw new Error('connection closed');
    this.remoteDescription = description;
    if (description.type === 'offer') {
      // (the pretend people never offer; kept so a stray offer can't break it)
      this.signalingState = 'have-remote-offer';
      return;
    }
    // An answer: connected. If it names a drawn camera we haven't handed
    // over yet, hand it over now — straight to the app, no video encoding.
    this.becomeStable();
    this.setConnection('connected');
    const stream = cameras.get(description.sdp);
    if (stream && !this.delivered.has(description.sdp)) {
      this.delivered.add(description.sdp);
      // a moment later, like real tracks arriving
      setTimeout(() => {
        if (this.signalingState === 'closed') return;
        for (const track of stream.getTracks()) {
          this.ontrack?.({ track, streams: [stream] });
        }
      }, 0);
    }
  }

  // Nothing to find or add: both "ends" are in this page.
  async addIceCandidate() {}

  // A restart just asks for a fresh offer, as in a real connection.
  restartIce() {
    this.needNegotiation();
  }

  close() {
    this.signalingState = 'closed';
    this.connectionState = 'closed'; // (a real one doesn't fire the event on close() either)
  }

  // --- helpers --------------------------------------------------------------

  becomeStable() {
    this.signalingState = 'stable';
    // anything that changed mid-offer gets its own offer now
    if (this.negotiationQueued) {
      this.negotiationQueued = false;
      this.needNegotiation();
    }
  }

  setConnection(state) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  // Like the browser: several changes in a row make ONE "negotiation needed",
  // a moment later, and only while no offer is in flight.
  needNegotiation() {
    if (this.signalingState === 'closed') return;
    if (this.signalingState !== 'stable') {
      this.negotiationQueued = true;
      return;
    }
    if (this.negotiationScheduled) return;
    this.negotiationScheduled = true;
    setTimeout(() => {
      this.negotiationScheduled = false;
      if (this.signalingState === 'stable') this.onnegotiationneeded?.();
      else this.negotiationQueued = true;
    }, 0);
  }
}
