// Ask the server for the meeting report (host / co-host only — see
// EVENTS.REPORT_GET). Shown by MeetingReport.jsx.

import { EVENTS } from '@listen/shared';
import { socket } from './socket.js';

/** The report now, or null (not a moderator / no answer in time). */
export async function fetchReport(timeoutMs = 4000) {
  try {
    const ack = await socket.timeout(timeoutMs).emitWithAck(EVENTS.REPORT_GET, {});
    return ack?.ok ? ack.report : null;
  } catch {
    return null;
  }
}
