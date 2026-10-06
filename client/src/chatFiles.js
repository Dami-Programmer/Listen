// Chat attachments, shared by the desktop chat panel and the mobile call
// screen: read a picked file into the { name, type, size, url } the server
// expects, shrinking photos first, and send it to the room.

import { CHAT_FILE_MAX_BYTES, EVENTS } from '@listen/shared';
import { socket } from './socket.js';

const MAX_IMAGE_DIM = 1600;

export function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Read a File into { name, type, size, url } — downscaling raster images to a
// reasonable JPEG so a phone photo doesn't blow the size cap.
export function prepareFile(file) {
  const readAsDataUrl = () =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });

  const canDownscale = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  if (!canDownscale) {
    return readAsDataUrl().then((url) => ({
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      url,
    }));
  }

  return readAsDataUrl().then(
    (src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
          if (scale === 1 && file.size <= 400 * 1024) {
            resolve({ name: file.name, type: file.type, size: file.size, url: src });
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const url = canvas.toDataURL('image/jpeg', 0.82);
          resolve({
            name: file.name.replace(/\.(png|webp)$/i, '.jpg'),
            type: 'image/jpeg',
            size: Math.round(url.length * 0.75),
            url,
          });
        };
        img.onerror = () =>
          resolve({ name: file.name, type: file.type, size: file.size, url: src });
        img.src = src;
      }),
  );
}


// Prepare + send one file to the room chat. Resolves with an error message to
// show, or null when it went through.
export function sendChatFile(file) {
  if (!file) return Promise.resolve(null);
  if (file.size > CHAT_FILE_MAX_BYTES && !file.type.startsWith('image/')) {
    return Promise.resolve(`"${file.name}" is too large (max ${formatBytes(CHAT_FILE_MAX_BYTES)}).`);
  }
  return prepareFile(file)
    .then((prepared) => {
      if (prepared.url.length > CHAT_FILE_MAX_BYTES * 1.4) {
        return `"${file.name}" is too large after processing.`;
      }
      return new Promise((resolve) => {
        socket.emit(EVENTS.CHAT_SEND, { kind: 'file', file: prepared }, (ack) => {
          resolve(ack?.ok ? null : (ack?.error ?? 'Could not send the file.'));
        });
      });
    })
    .catch(() => 'Could not read the file.');
}
