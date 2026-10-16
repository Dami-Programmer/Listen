// Tests for chat attachments kept in storage (server/src/chatFiles.js).
// Without R2 settings (as here) storage is a temp folder, so these run
// anywhere without touching the real bucket.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatFileIdOf,
  deleteChatFile,
  deleteChatFilesOf,
  openChatFile,
  saveChatFile,
} from '../src/chatFiles.js';

const dataUrl = (type, text) => `data:${type};base64,${Buffer.from(text).toString('base64')}`;

async function read(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

describe('chat files', () => {
  test('a saved file comes back with its name, type and content', async () => {
    const saved = await saveChatFile(
      dataUrl('image/png', 'pretend png'),
      { name: 'pic.png', type: 'image/png' },
      1000,
    );
    const f = await openChatFile(saved.id);
    assert.equal(f.name, 'pic.png');
    assert.equal(f.type, 'image/png');
    assert.equal(f.inline, true); // photos open in the browser
    assert.equal(await read(f.body), 'pretend png');
    await deleteChatFile(saved.id);
  });

  test('anything that isn’t a photo or PDF is sent as a download', async () => {
    const saved = await saveChatFile(
      dataUrl('text/html', '<script>x</script>'),
      { name: 'page.html', type: 'text/html' },
      1000,
    );
    assert.equal((await openChatFile(saved.id)).inline, false);
    await deleteChatFile(saved.id);
  });

  test('too big or malformed: refused', async () => {
    assert.equal(await saveChatFile(dataUrl('image/png', 'x'.repeat(50)), { name: 'a' }, 10), null);
    assert.equal(await saveChatFile('not a data url', { name: 'a' }, 1000), null);
  });

  test('a deleted file is gone; made-up ids find nothing', async () => {
    const saved = await saveChatFile(
      dataUrl('image/png', 'bye'),
      { name: 'b.png', type: 'image/png' },
      1000,
    );
    await deleteChatFile(saved.id);
    assert.equal(await openChatFile(saved.id), null);
    assert.equal(await openChatFile('../../etc/passwd'), null);
    assert.equal(await openChatFile('00000000-0000-0000-0000-000000000000'), null);
  });

  test('a closed room’s files are all deleted', async () => {
    const a = await saveChatFile(
      dataUrl('image/png', 'a'),
      { name: 'a.png', type: 'image/png' },
      1000,
    );
    const b = await saveChatFile(
      dataUrl('image/png', 'b'),
      { name: 'b.png', type: 'image/png' },
      1000,
    );
    const url = (id) => `https://example.test/files/${id}`;
    await deleteChatFilesOf([
      { kind: 'file', file: { url: url(a.id) } },
      { kind: 'text', text: 'hi' },
      { kind: 'file', file: { url: url(b.id) } },
    ]);
    assert.equal(await openChatFile(a.id), null);
    assert.equal(await openChatFile(b.id), null);
  });

  test('the id is read back out of a chat file link', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    assert.equal(chatFileIdOf(`https://x.test/files/${id}`), id);
    assert.equal(chatFileIdOf(`https://x.test/files/${id}?download=1`), id);
    assert.equal(chatFileIdOf('data:image/png;base64,AAAA'), null);
  });
});
