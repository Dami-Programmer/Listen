// One shared Socket.IO connection for the whole client.
// autoConnect is off so the join screen controls exactly when we dial in.

import { io } from 'socket.io-client';

// The server's address — also used for plain HTTP calls (e.g. sending a review).
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001';

export const socket = io(SIGNALING_URL, {
  autoConnect: false,
  transports: ['websocket'],
});
