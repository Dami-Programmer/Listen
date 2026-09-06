// In-call text chat (added after Phase 7).
//
// A self-contained panel: message log + composer with an emoji picker and a
// sticker tray. Chat state (messages, and who is typing) lives up in <App/> —
// it seeds from the join-room ack and grows on each CHAT_MESSAGE / CHAT_TYPING —
// so this component is pure UI plus the "send" and "I'm typing" emits.

import { useEffect, useRef, useState } from 'react';
import { EVENTS, STICKERS } from '@listen/shared';
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

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// "Ada is typing" / "Ada and Boris are typing" / "Several people are typing".
function typingLabel(names) {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return 'Several people are typing';
}

export default function ChatPanel({ messages, typers, selfId }) {
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(null); // 'emoji' | 'sticker' | null
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  // Outbound typing state: whether we've told the room we're typing, when we
  // last said so (to throttle re-sends), and the idle timer that stops it.
  const typingRef = useRef({ active: false, lastSent: 0, idle: null });

  const typingNames = Object.entries(typers || {})
    .filter(([id]) => id !== selfId)
    .map(([, name]) => name);

  // Stick to the bottom as messages arrive — and as the typing row appears, so
  // it never hides just below the fold.
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
    // Send on the first keystroke, then at most once every 3s while typing
    // continues (well under the 5s expiry on the receiving side).
    if (!t.active || now - t.lastSent > 3000) {
      t.active = true;
      t.lastSent = now;
      socket.emit(EVENTS.CHAT_TYPING, { typing: true });
    }
    clearTimeout(t.idle);
    t.idle = setTimeout(stopTyping, 3500); // no keystroke for 3.5s -> stopped
  };

  // Make sure we retract "typing" if the panel unmounts (leave / disconnect).
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
              {m.kind === 'sticker' ? (
                <span className="chat-sticker" role="img" aria-label="sticker">
                  {m.text}
                </span>
              ) : (
                <span className="chat-bubble">{m.text}</span>
              )}
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
        <input
          ref={inputRef}
          value={text}
          onChange={onInputChange}
          onBlur={stopTyping}
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
