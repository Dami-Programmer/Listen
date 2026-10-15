// The demo page's stand-in for the app's Socket.IO connection (socket.js
// hands this out instead of a real one on /demo).
//
// It speaks the same little API the app uses — on / off / emit (with an
// acknowledgement callback), timeout().emitWithAck(), connect / disconnect,
// connected — but nothing leaves the page: every message goes to the demo
// server running in this tab (demoServer.js), which answers like the real
// one. The real app code can't tell the difference.

export class DemoSocket {
  constructor() {
    this.id = 'demo-you';
    this.connected = false;
    this.sendBuffer = [];
    this.io = { opts: {}, on() {}, off() {} };
    this.listeners = new Map();
    this.server = null; // attached by DemoApp
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    if (fn) this.listeners.get(event)?.delete(fn);
    else this.listeners.delete(event);
    return this;
  }

  /** The server -> app direction. */
  deliver(event, ...args) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error('[demo] listener failed', event, err);
      }
    }
  }

  connect() {
    if (!this.connected) {
      this.connected = true;
      queueMicrotask(() => this.deliver('connect'));
    }
    return this;
  }

  disconnect() {
    if (this.connected) {
      this.connected = false;
      this.server?.leave(this.id);
      queueMicrotask(() => this.deliver('disconnect', 'io client disconnect'));
    }
    return this;
  }

  /** The app -> server direction. A last function argument is the ack. */
  emit(event, ...args) {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    // a moment later, like a real round trip
    setTimeout(() => {
      if (!this.server) return ack?.({ ok: false, error: 'demo not ready' });
      this.server.handle(this.id, event, args[0], ack ?? undefined);
    }, 15);
    return this;
  }

  timeout() {
    return { emitWithAck: (event, payload) => this.emitWithAck(event, payload) };
  }

  emitWithAck(event, payload) {
    return new Promise((resolve) => this.emit(event, payload, resolve));
  }
}
