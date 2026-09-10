// The Room Chat body — message log + composer. It renders WITHOUT its own card
// or header; the side panel around it provides the Room Chat / Participant tabs.
//
// Composer, per the design: [emoji] [input] [send]. Stickers and file
// attachments live behind the emoji tray (its own little tab row), so the
// composer stays clean while every feature is still reachable.

import { useEffect, useRef, useState } from 'react';
import { CHAT_FILE_MAX_BYTES, EVENTS, STICKERS } from '@listen/shared';
import { socket } from './socket.js';
import { Smile, Send, Paperclip } from './icons.jsx';

const EMOJIS = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🙂', '🙃',
  '😉', '😊', '😍', '😘', '😜', '🤪', '🤔', '🤗',
  '🤩', '🥳', '😎', '😢', '😭', '😤', '😠', '🥲',
  '👍', '👎', '👏', '🙌', '🙏', '👋', '🤝', '💪',
  '🔥', '✨', '🎉', '💯', '❤️', '🧡', '💛', '💚',
  '💙', '💜', '👀', '🚀', '⭐', '✅', '❌', '⚡',
];
const MAX_IMAGE_DIM = 1600;

const timeOf = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function typingLabel(names) {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return 'Several people are typing';
}

function prepareFile(file) {
  const read = () =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return read().then((url) => ({
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      url,
    }));
  }
  return read().then(
    (src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
          if (scale === 1 && file.size <= 400 * 1024) {
            resolve({ name: file.name, type: file.type, size: file.size, url: src });
            return;
          }
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const url = c.toDataURL('image/jpeg', 0.82);
          resolve({
            name: file.name.replace(/\.(png|webp)$/i, '.jpg'),
            type: 'image/jpeg',
            size: Math.round(url.length * 0.75),
            url,
          });
        };
        img.onerror = () => resolve({ name: file.name, type: file.type, size: file.size, url: src });
        img.src = src;
      }),
  );
}

export default function ChatPanel({ messages, typers, selfId }) {
  const [text, setText] = useState('');
  const [tray, setTray] = useState(null); // null | 'emoji' | 'sticker'
  const [attachError, setAttachError] = useState(null);
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const typingRef = useRef({ active: false, lastSent: 0, idle: null });
  // Message ids we've already rendered — anything new gets the iMessage-style
  // "pop in" animation exactly once. Whatever's in the log on first mount is
  // treated as already seen so history doesn't all animate at once.
  const seenRef = useRef(new Set());
  const primedRef = useRef(false);

  const typingNames = Object.entries(typers || {})
    .filter(([id]) => id !== selfId)
    .map(([, name]) => name);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typingNames.length]);

  useEffect(() => {
    messages.forEach((m) => seenRef.current.add(m.id));
    primedRef.current = true;
  }, [messages]);

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

  function onInput(e) {
    const v = e.target.value;
    setText(v);
    if (v.trim()) pingTyping();
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
    setTray(null);
    stopTyping();
  }
  function sendSticker(s) {
    socket.emit(EVENTS.CHAT_SEND, { text: s, kind: 'sticker' }, (ack) => {
      if (!ack?.ok) console.warn('[chat-send] rejected:', ack?.error);
    });
    setTray(null);
  }
  function addEmoji(e) {
    setText((t) => t + e);
    inputRef.current?.focus();
    pingTyping();
  }
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
        setTray(null);
      })
      .catch(() => setAttachError('Could not read the file.'));
  }
  function onPaste(e) {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file');
    if (item) {
      e.preventDefault();
      sendFile(item.getAsFile());
    }
  }

  return (
    <>
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && <p className="muted">No messages yet. Say hi 👋</p>}
        {messages.map((m) => {
          const mine = m.from === selfId;
          const fresh = primedRef.current && !seenRef.current.has(m.id);
          return (
            <div
              key={m.id}
              className={`msg${mine ? ' mine' : ''}${fresh ? ' msg--enter' : ''}`}
            >
              <div className="msg-head">
                <span className="msg-name">{mine ? 'You' : m.name}</span>
                <span className="msg-time">{timeOf(m.ts)}</span>
              </div>
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
            </div>
          );
        })}
        {typingNames.length > 0 && (
          <div className="chat-typing" aria-live="polite">
            <span>{typingLabel(typingNames)}</span>
            <span className="typing-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>

      {attachError && <p className="err attach-err">{attachError}</p>}

      {tray && (
        <>
          <div className="picker-tabs">
            <button className={tray === 'emoji' ? 'on' : ''} onClick={() => setTray('emoji')}>
              Emoji
            </button>
            <button className={tray === 'sticker' ? 'on' : ''} onClick={() => setTray('sticker')}>
              Stickers
            </button>
            <button onClick={() => fileRef.current?.click()}>File / photo</button>
          </div>
          {tray === 'emoji' && (
            <div className="picker emoji-picker">
              {EMOJIS.map((e) => (
                <button key={e} type="button" onClick={() => addEmoji(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}
          {tray === 'sticker' && (
            <div className="picker sticker-picker">
              {STICKERS.map((st) => (
                <button key={st} type="button" onClick={() => sendSticker(st)}>
                  {st}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <form className="composer" onSubmit={sendText}>
        <button
          type="button"
          className={`icon-btn${tray ? ' on' : ''}`}
          aria-label="Emoji, stickers, attachments"
          onClick={() => setTray((t) => (t ? null : 'emoji'))}
        >
          <Smile />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Attach a file"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip />
        </button>
        <input ref={fileRef} type="file" hidden onChange={(e) => { sendFile(e.target.files?.[0]); e.target.value = ''; }} />
        <input
          ref={inputRef}
          value={text}
          onChange={onInput}
          onBlur={stopTyping}
          onPaste={onPaste}
          placeholder="Type message here..."
          maxLength={2000}
          autoComplete="off"
        />
        <button type="submit" className="send" aria-label="Send" disabled={!text.trim()}>
          <Send />
        </button>
      </form>
    </>
  );
}
