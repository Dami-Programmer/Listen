// Talking to Cloudflare's SFU ("Realtime SFU") — the video desk.
//
// Without an SFU, every browser sends its camera straight to every other
// browser ("mesh"): fine for a handful of people, too much upload for more.
// With it, each browser sends each of its tracks ONCE, to Cloudflare, and
// Cloudflare copies it to whoever should receive it.
//
// Cloudflare's API needs the app's SECRET, so browsers never call it
// themselves: they ask this server (the SFU_* socket events in index.js),
// which checks they're allowed, then makes the call here. That's also what
// makes moderation real: the server simply won't publish or pass on audio
// from a listener.
//
// Configured in the env (Cloudflare dashboard -> Realtime -> SFU):
//   CLOUDFLARE_SFU_APP_ID      the SFU app's ID
//   CLOUDFLARE_SFU_APP_SECRET  the SFU app's secret (API token)
// Without them, sfuEnabled() is false and calls use the old mesh.
//
// API reference: https://developers.cloudflare.com/realtime/sfu/https-api/

// Read when used, not when this file loads: index.js loads the .env file
// AFTER its imports (this file included) have run.
const appId = () => process.env.CLOUDFLARE_SFU_APP_ID;
const secret = () => process.env.CLOUDFLARE_SFU_APP_SECRET;

// A browser is waiting on every one of these (its video starts or changes
// when it returns), so never let a slow Cloudflare hang it for long.
const TIMEOUT_MS = 8000;

export const sfuEnabled = () => Boolean(appId() && secret());

// One Cloudflare API call. Throws on an HTTP error, or when Cloudflare
// reports an error for the whole request (`errorCode` at the top level).
// Per-track errors are left in the result for the caller to read.
async function call(method, path, body) {
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // not JSON — the status line below says what went wrong
  }
  if (!res.ok || data.errorCode) {
    throw new Error(
      `Cloudflare SFU ${method} ${path.replace(/[0-9a-f]{20,}/g, '…')} failed: ` +
        `${res.status} ${data.errorCode ?? ''} ${data.errorDescription ?? text.slice(0, 200)}`,
    );
  }
  return data;
}

// Only `type` + `sdp` go to Cloudflare, and the SDP must be a real string —
// it comes straight from a browser.
function description(type, sdp) {
  if (typeof sdp !== 'string' || !sdp || sdp.length > 200_000) {
    throw new Error('bad session description');
  }
  return { type, sdp };
}

/** A new Cloudflare session (one per browser connection). Returns its id. */
export async function newSession() {
  const data = await call('POST', '/sessions/new');
  return data.sessionId;
}

/**
 * Start sending tracks. `offerSdp` is the browser's offer; `tracks` is
 * [{ mid, trackName }]. Returns { sdp (answer), tracks (per-track results) }.
 */
export async function publish(sessionId, offerSdp, tracks) {
  const data = await call('POST', `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: description('offer', offerSdp),
    tracks: tracks.map(({ mid, trackName }) => ({ location: 'local', mid, trackName })),
  });
  return { sdp: data.sessionDescription?.sdp ?? null, tracks: data.tracks ?? [] };
}

/**
 * Start receiving other people's tracks. `sources` is
 * [{ sessionId (the sender's), trackName }]. Cloudflare answers with an OFFER
 * for the browser (or none if nothing changed), plus each track's mid.
 * Returns { sdp, renegotiate, tracks }.
 */
export async function pull(sessionId, sources) {
  const data = await call('POST', `/sessions/${sessionId}/tracks/new`, {
    tracks: sources.map((s) => ({
      location: 'remote',
      sessionId: s.sessionId,
      trackName: s.trackName,
    })),
  });
  return {
    sdp: data.sessionDescription?.sdp ?? null,
    renegotiate: Boolean(data.requiresImmediateRenegotiation),
    tracks: data.tracks ?? [],
  };
}

/** The browser's answer to the offer `pull` returned. */
export async function answer(sessionId, answerSdp) {
  await call('PUT', `/sessions/${sessionId}/renegotiate`, {
    sessionDescription: description('answer', answerSdp),
  });
}

/**
 * Stop tracks (sending or receiving) on these mids. With the browser's offer
 * it's a normal, negotiated close and returns Cloudflare's answer. Without
 * one (`offerSdp` null) it's FORCED: Cloudflare just drops the tracks — how
 * the server cuts off a listener's audio whatever their browser does.
 */
export async function close(sessionId, mids, offerSdp = null) {
  const data = await call('PUT', `/sessions/${sessionId}/tracks/close`, {
    tracks: mids.map((mid) => ({ mid: String(mid) })),
    ...(offerSdp ? { sessionDescription: description('offer', offerSdp) } : {}),
    force: !offerSdp,
  });
  return { sdp: data.sessionDescription?.sdp ?? null };
}
