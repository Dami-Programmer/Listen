// In-call text chat (added after Phase 7).
//
// A self-contained panel: message log + composer with an emoji picker, a
// sticker tray, and attachments (images + files). Chat state (messages, and who
// is typing) lives up in <App/> — it seeds from the join-room ack and grows on
// each CHAT_MESSAGE / CHAT_TYPING — so this component is pure UI plus the
// "send" / "attach" / "I'm typing" emits.
//
// Attachments travel as data: URLs over Socket.IO (no file storage, matching
// the app's in-memory model). Images are downscaled to <=1600px JPEG before
// sending, so the CHAT_FILE_MAX_BYTES cap mostly bites non-image files.

import { useEffect, useRef, useState } from 'react';
import { CHAT_FILE_MAX_BYTES, EVENTS, STICKERS } from '@listen/shared';
import { socket } from './socket.js';

// A small curated palette — no dependency, no full Unicode picker.
const EMOJIS = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🙂', '🙃',
  '😉', '😊', '😍', '😘', '😜', '🤪', '🤔', '🤗',
  '🤩', '🥳', '😎', '😢', '😭', '😤', '😠', '🥲',
  '👍', '👎', '👏', '🙌', '🙏', '👋', '🤝', '💪',
  '🔥', '✨', '🎉', '💯', '❤️', '🧡', '💛', '💚',
  '💙', '💜', '👀', '🚀', '⭐', '✅', '❌', '⚡',
];

const MAX_IMAGE_DIM = 1600;

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// "Ada is typing" / "Ada and Boris are typing" / "Several people are typing".
function typingLabel(names) {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return 'Several people are typing';
}

// Read a File into { name, type, size, url } — downscaling raster images to a
// reasonable JPEG so a phone photo doesn't blow the size cap.
function prepareFile(file) {
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

export default function ChatPanel({ messages, typers, selfId }) {
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(null); // 'emoji' | 'sticker' | null
  const [attachError, setAttachError] = useState(null);
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const fileInputRef = useRef(null);
  // Outbound typing state.
  const typingRef = useRef({ active: false, lastSent: 0, idle: null });

  const typingNames = Object.entries(typers || {})
    .filter(([id]) => id !== selfId)
    .map(([, name]) => name);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typingNames.length]);

  // Click / Escape anywhere outside closes an open picker.
  useEffect(() => {
    if (!picker) return undefined;
    function onDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setPicker(null);
    }
    function onKey(e) {
      if (e.key === 'Escape') setPicker(null);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [picker]);

  // --- outbound "is typing" ping ------------------------------------------
  const stopTyping = () => {
    const t = typingRef.current;
    clearTimeout(t.idle);
    t.idle = null;
    if (t.active) {
      t.active = false;
      socket.emit(EVENTS.CHAT_TYPING, { typing: false });
    }
  };

  const pingTyping = () => {
    const t = typingRef.current;
    const now = Date.now();
    if (!t.active || now - t.lastSent > 3000) {
      t.active = true;
      t.lastSent = now;
      socket.emit(EVENTS.CHAT_TYPING, { typing: true });
    }
    clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, 3500);
  };

  useEffect(() => stopTyping, []);

  function onInputChange(e) {
    const value = e.target.value;
    setText(value);
    if (value.trim()) pingTyping();
    else stopTyping();
  }

  function sendText(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    socket.emit(EVENTS.CHAT_SEND, { text: body }, (ack) => {
      if (!ack?.ok) console.warn('[chat-send] rejected:', ack?.error);
    });
    setText('');
    setPicker(null);
    stopTyping();
  }

  function sendSticker(sticker) {
    socket.emit(EVENTS.CHAT_SEND, { text: sticker, kind: 'sticker' }, (ack) => {
      if (!ack?.ok) console.warn('[chat-send] rejected:', ack?.error);
    });
    setPicker(null);
  }

  function addEmoji(emoji) {
    setText((t) => t + emoji);
    inputRef.current?.focus();
    pingTyping();
  }

  // --- attachments -------------------------------------------------------
  function sendFile(file) {
    if (!file) return;
    setAttachError(null);
    if (file.size > CHAT_FILE_MAX_BYTES && !file.type.startsWith('image/')) {
      setAttachError(`"${file.name}" is too large (max ${formatBytes(CHAT_FILE_MAX_BYTES)}).`);
      return;
    }
    prepareFile(file)
      .then((prepared) => {
        if (prepared.url.length > CHAT_FILE_MAX_BYTES * 1.4) {
          setAttachError(`"${file.name}" is too large after processing.`);
          return;
        }
        socket.emit(EVENTS.CHAT_SEND, { kind: 'file', file: prepared }, (ack) => {
          if (!ack?.ok) setAttachError(ack?.error ?? 'Could not send the file.');
        });
      })
      .catch(() => setAttachError('Could not read the file.'));
  }

  function onFilePick(e) {
    const [file] = e.target.files ?? [];
    sendFile(file);
    e.target.value = ''; // let the same file be picked again
  }

  function onPaste(e) {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file');
    if (item) {
      e.preventDefault();
      sendFile(item.getAsFile());
    }
  }

  return (
    <div className="card chat" ref={rootRef}>
      <div className="row header">
        <span>Chat ({messages.length})</span>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && <p className="muted">No messages yet. Say hi 👋</p>}
        {messages.map((m) => {
          const mine = m.from === selfId;
          return (
            <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}`}>
              {!mine && <span className="chat-name">{m.name}</span>}
              {m.kind === 'sticker' && (
                <span className="chat-sticker" role="img" aria-label="sticker">
                  {m.text}
                </span>
              )}
              {m.kind === 'file' && m.file?.type?.startsWith('image/') && (
                <a href={m.file.url} target="_blank" rel="noopener noreferrer">
                  <img className="chat-image" src={m.file.url} alt={m.file.name} />
                </a>
              )}
              {m.kind === 'file' && !m.file?.type?.startsWith('image/') && (
                <a className="chat-file" href={m.file.url} download={m.file.name}>
                  <span className="chat-file-icon">📄</span>
                  <span className="chat-file-meta">
                    <span className="chat-file-name">{m.file.name}</span>
                    <span className="chat-file-size">{formatBytes(m.file.size)} · download</span>
                  </span>
                </a>
              )}
              {(!m.kind || m.kind === 'text') && <span className="chat-bubble">{m.text}</span>}
              <span className="chat-time">{timeOf(m.ts)}</span>
            </div>
          );
        })}

        {typingNames.length > 0 && (
          <div className="chat-typing" aria-live="polite">
            <span className="chat-name">{typingLabel(typingNames)}</span>
            <span className="typing-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>

      {attachError && <p className="err chat-attach-err">{attachError}</p>}

      {picker === 'emoji' && (
        <div className="picker emoji-picker" role="listbox" aria-label="Emojis">
          {EMOJIS.map((e) => (
            <button key={e} type="button" onClick={() => addEmoji(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
      {picker === 'sticker' && (
        <div className="picker sticker-picker" role="listbox" aria-label="Stickers">
          {STICKERS.map((s) => (
            <button key={s} type="button" onClick={() => sendSticker(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <form className="chat-compose" onSubmit={sendText}>
        <button
          type="button"
          className={`chat-tool${picker === 'emoji' ? ' on' : ''}`}
          aria-label="Emoji"
          onClick={() => setPicker((p) => (p === 'emoji' ? null : 'emoji'))}
        >
          😊
        </button>
        <button
          type="button"
          className={`chat-tool${picker === 'sticker' ? ' on' : ''}`}
          aria-label="Stickers"
          onClick={() => setPicker((p) => (p === 'sticker' ? null : 'sticker'))}
        >
          🏷️
        </button>
        <button
          type="button"
          className="chat-tool"
          aria-label="Attach a photo or file"
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <input ref={fileInputRef} type="file" hidden onChange={onFilePick} />
        <input
          ref={inputRef}
          value={text}
          onChange={onInputChange}
          onBlur={stopTyping}
          onPaste={onPaste}
          placeholder="Message the room…"
          maxLength={2000}
          autoComplete="off"
        />
        <button type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
