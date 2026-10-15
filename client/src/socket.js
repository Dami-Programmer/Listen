// One shared Socket.IO connection for the whole client.
// autoConnect is off so the join screen controls exactly when we dial in.

import { io } from 'socket.io-client';
import { DemoSocket } from './demo/demoSocket.js';

// The server's address — also used for plain HTTP calls (e.g. sending a review).
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001';

// The landing page's live demo (/demo) gets a stand-in that never leaves the
// page — the app inside it talks to a pretend server (demo/demoServer.js).
export const IS_DEMO = typeof window !== 'undefined' && window.location.pathname === '/demo';

export const socket = IS_DEMO
  ? new DemoSocket()
  : io(SIGNALING_URL, {
      autoConnect: false,
      transports: ['websocket'],
    });
