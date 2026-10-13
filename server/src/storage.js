// Where recordings are kept: Cloudflare R2 (cloud file storage), or a folder
// on this computer when R2 isn't set up (local development).
//
// Browsers never talk to R2 themselves — some networks can't reach R2's
// address at all — so everything goes through this server: recordings come in
// over the socket (recordings.js) and go out over HTTP (index.js).
//
// Configured in the env (Cloudflare dashboard -> R2):
//   R2_ACCOUNT_ID         the Cloudflare account ID
//   R2_ACCESS_KEY_ID      an R2 API token's access key ID
//   R2_SECRET_ACCESS_KEY  ...and its secret access key
//   R2_BUCKET             the bucket's name (e.g. listen-recordings)
// R2 speaks Amazon S3's language; aws4fetch signs each request with the keys.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AwsClient } from 'aws4fetch';

// Read when used, not when this file loads (index.js loads the .env file
// after its imports have run).
const env = () => ({
  account: process.env.R2_ACCOUNT_ID,
  id: process.env.R2_ACCESS_KEY_ID,
  secret: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
});

export function usingR2() {
  const e = env();
  return Boolean(e.account && e.id && e.secret && e.bucket);
}

// Local development without R2: a folder in the system's temp directory.
const DISK_DIR = path.join(os.tmpdir(), 'listen-recordings');
const diskPath = (key) => path.join(DISK_DIR, ...key.split('/'));

// R2 needs every piece of a big upload except the last to be at least 5 MB.
const PART_BYTES = 5 * 1024 * 1024;

let client = null;
function r2() {
  const e = env();
  client ??= new AwsClient({
    accessKeyId: e.id,
    secretAccessKey: e.secret,
    service: 's3',
    region: 'auto',
  });
  return client;
}
const objectUrl = (key, query = '') => {
  const e = env();
  const k = key.split('/').map(encodeURIComponent).join('/');
  return `https://${e.account}.r2.cloudflarestorage.com/${e.bucket}/${k}${query}`;
};

// One R2 request. Throws with R2's error text on failure.
async function call(url, init = {}) {
  const res = await r2().fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `R2 ${init.method ?? 'GET'} failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  return res;
}

// The few bits of R2's XML replies we need.
const xmlValues = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);

/** Save a whole (small) file. */
export async function putObject(key, body, type) {
  if (!usingR2()) {
    await fsp.mkdir(path.dirname(diskPath(key)), { recursive: true });
    await fsp.writeFile(diskPath(key), body);
    return;
  }
  await call(objectUrl(key), { method: 'PUT', body, headers: { 'Content-Type': type } });
}

/** A small file's text, or null if it isn't there. */
export async function getText(key) {
  if (!usingR2()) {
    try {
      return await fsp.readFile(diskPath(key), 'utf8');
    } catch {
      return null;
    }
  }
  const res = await call(objectUrl(key));
  return res.status === 404 ? null : res.text();
}

/**
 * Read a file for playback / download, optionally just a byte range (what
 * video players ask for when you skip ahead). Returns null if it isn't there,
 * otherwise { status (200 or 206), size, start, end, body (a Node stream) }.
 */
export async function getObject(key, range) {
  if (!usingR2()) {
    let size;
    try {
      size = (await fsp.stat(diskPath(key))).size;
    } catch {
      return null;
    }
    const { start, end } = range ? clampRange(range, size) : { start: 0, end: size - 1 };
    return {
      status: range ? 206 : 200,
      size,
      start,
      end,
      body: fs.createReadStream(diskPath(key), { start, end }),
    };
  }
  const headers = range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {};
  const res = await call(objectUrl(key), { headers });
  if (res.status === 404) return null;
  const total = Number(
    res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length'),
  );
  const [start, end] = (
    res.headers
      .get('content-range')
      ?.match(/(\d+)-(\d+)/)
      ?.slice(1) ?? [0, total - 1]
  ).map(Number);
  return { status: res.status, size: total, start, end, body: Readable.fromWeb(res.body) };
}

function clampRange({ start, end }, size) {
  const s = Math.min(start, size - 1);
  return { start: s, end: Math.min(end ?? size - 1, size - 1) };
}

/** Delete a file (no error if it's already gone). */
export async function deleteObject(key) {
  if (!usingR2()) {
    await fsp.rm(diskPath(key), { force: true });
    return;
  }
  await call(objectUrl(key), { method: 'DELETE' });
}

/** Every file whose name starts with `prefix`: [{ key, modified (ms) }]. */
export async function listKeys(prefix) {
  if (!usingR2()) {
    const out = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(full);
        else {
          const key = path.relative(DISK_DIR, full).split(path.sep).join('/');
          if (key.startsWith(prefix)) out.push({ key, modified: (await fsp.stat(full)).mtimeMs });
        }
      }
    };
    await walk(DISK_DIR);
    return out;
  }
  const out = [];
  let token = '';
  do {
    const q = `?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
    const e = env();
    const xml = await (
      await call(`https://${e.account}.r2.cloudflarestorage.com/${e.bucket}${q}`)
    ).text();
    const keys = xmlValues(xml, 'Key');
    const dates = xmlValues(xml, 'LastModified');
    keys.forEach((key, i) => out.push({ key, modified: Date.parse(dates[i]) }));
    token = xml.includes('<IsTruncated>true</IsTruncated>')
      ? (xmlValues(xml, 'NextContinuationToken')[0] ?? '')
      : '';
  } while (token);
  return out;
}

/**
 * A file that arrives a piece at a time (a recording, as it's made).
 * write(buffer) adds to the end; finish() completes it and returns its size;
 * abort() throws it away. Calls must not overlap — the caller waits on each.
 *
 * In R2 it's a "multipart upload": pieces are collected here until there are
 * 5 MB, then sent as one part; finish() sends the rest and joins them up.
 */
export function openUpload(key, type) {
  let size = 0;

  if (!usingR2()) {
    let ready = fsp.mkdir(path.dirname(diskPath(key)), { recursive: true });
    return {
      async write(buf) {
        await ready;
        ready = Promise.resolve();
        await fsp.appendFile(diskPath(key), buf);
        size += buf.length;
      },
      async finish() {
        await ready;
        if (!size) await fsp.writeFile(diskPath(key), Buffer.alloc(0));
        return size;
      },
      async abort() {
        await fsp.rm(diskPath(key), { force: true });
      },
    };
  }

  let uploadId = null;
  let pending = [];
  let pendingBytes = 0;
  const parts = []; // { n, etag }

  async function start() {
    if (uploadId) return;
    const res = await call(objectUrl(key, '?uploads'), {
      method: 'POST',
      headers: { 'Content-Type': type },
    });
    uploadId = xmlValues(await res.text(), 'UploadId')[0];
    if (!uploadId) throw new Error('R2 did not start the upload');
  }
  // Send one part. R2 insists every part except the LAST is exactly the same
  // size, so a middle part is cut at exactly PART_BYTES and whatever is left
  // over waits for the next one; the last part (`last`) takes everything.
  async function sendPart(last = false) {
    if (!pendingBytes) return;
    await start();
    const n = parts.length + 1;
    const all = Buffer.concat(pending);
    const body = last ? all : all.subarray(0, PART_BYTES);
    const rest = last ? Buffer.alloc(0) : all.subarray(PART_BYTES);
    pending = rest.length ? [rest] : [];
    pendingBytes = rest.length;
    const res = await call(
      objectUrl(key, `?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`),
      {
        method: 'PUT',
        body,
      },
    );
    parts.push({ n, etag: res.headers.get('etag') });
  }

  return {
    async write(buf) {
      pending.push(buf);
      pendingBytes += buf.length;
      size += buf.length;
      while (pendingBytes >= PART_BYTES) await sendPart();
    },
    async finish() {
      if (!uploadId && pendingBytes < PART_BYTES) {
        // Small enough for one ordinary upload.
        await putObject(key, Buffer.concat(pending), type);
        return size;
      }
      await sendPart(true);
      const xml =
        '<CompleteMultipartUpload>' +
        parts
          .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`)
          .join('') +
        '</CompleteMultipartUpload>';
      await call(objectUrl(key, `?uploadId=${encodeURIComponent(uploadId)}`), {
        method: 'POST',
        body: xml,
        headers: { 'Content-Type': 'application/xml' },
      });
      return size;
    },
    async abort() {
      if (uploadId) {
        await call(objectUrl(key, `?uploadId=${encodeURIComponent(uploadId)}`), {
          method: 'DELETE',
        });
      }
    },
  };
}

/** Startup check: can we write to storage? Logs the answer. */
export async function checkStorage() {
  const where = usingR2() ? 'Cloudflare R2' : `this computer (${DISK_DIR})`;
  try {
    await putObject('check/hello.txt', Buffer.from('ok'), 'text/plain');
    await deleteObject('check/hello.txt');
    console.log(`[server] recordings are saved to ${where}`);
  } catch (err) {
    console.error(`[server] recordings can't be saved to ${where}:`, err.message);
  }
}
