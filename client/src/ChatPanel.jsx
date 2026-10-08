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
//
// Look (matches the "Design Sprint Meeting" chat design):
//   - other people's messages sit on the left with their avatar; yours sit on
//     the right with no avatar
//   - consecutive messages from the same person are GROUPED: one avatar and
//     one "• Name 11:34 AM" line under the whole group, and short bubbles flow
//     side by side (like "Meetingnote.doct" + "Aa" in the design)
//   - bubbles are outlined, not filled
//   - the composer is one rounded box: text on top, attach on the bottom-left,
//     emoji + send on the bottom-right. Stickers live in a tab of the emoji
//     picker (the design has no separate sticker button).

import { useEffect, useRef, useState } from 'react';
import { CHAT_FILE_MAX_BYTES, EVENTS, STICKERS } from '@listen/shared';
import { socket } from './socket.js';
import { formatBytes, prepareFile } from './chatFiles.js';
import ImageViewer from './ImageViewer.jsx';
import Avatar from './Avatar.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import {
  Download,
  FileDoc,
  ImageIcon,
  Paperclip,
  Pencil,
  Send,
  Smile,
  Trash,
  TypeT,
} from './icons.jsx';

// A small curated palette — no dependency, no full Unicode picker.
const EMOJIS = [
  '😀',
  '😃',
  '😄',
  '😁',
  '😅',
  '😂',
  '🙂',
  '🙃',
  '😉',
  '😊',
  '😍',
  '😘',
  '😜',
  '🤪',
  '🤔',
  '🤗',
  '🤩',
  '🥳',
  '😎',
  '😢',
  '😭',
  '😤',
  '😠',
  '🥲',
  '👍',
  '👎',
  '👏',
  '🙌',
  '🙏',
  '👋',
  '🤝',
  '💪',
  '🔥',
  '✨',
  '🎉',
  '💯',
  '❤️',
  '🧡',
  '💛',
  '💚',
  '💙',
  '💜',
  '👀',
  '🚀',
  '⭐',
  '✅',
  '❌',
  '⚡',
];

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Who's typing, split into the bold part (names) and the plain part, so the
// row can read "**Lisa** is typing". No "..." — the bouncing dots after it
// play that role.
function typingParts(names) {
  if (names.length === 1) return [names[0], 'is typing'];
  if (names.length === 2) return [`${names[0]} and ${names[1]}`, 'are typing'];
  return ['Several people', 'are typing'];
}

// Messages from the same person less than this far apart share one group.
const GROUP_GAP_MS = 5 * 60 * 1000;

// Turn the flat message list into runs of consecutive messages from the same
// sender: [{ from, name, items: [msg, msg, ...] }, ...]. A new group starts
// when the sender changes, or when the same sender goes quiet for a while.
function groupMessages(messages) {
  const groups = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    const lastMsg = last?.items[last.items.length - 1];
    if (last && last.from === m.from && m.ts - lastMsg.ts < GROUP_GAP_MS) {
      last.items.push(m);
    } else {
      groups.push({ from: m.from, name: m.name, items: [m] });
    }
  }
  return groups;
}

/**
 * @param {object}   props
 * @param {object[]} props.messages  chat history, oldest first
 * @param {object}   props.typers    socketId -> name of everyone typing
 * @param {string}   props.selfId    my socket id (decides left vs right)
 * @param {object[]} [props.participants] who's in the call now (for their
 *                                   profile pictures)
 */
export default function ChatPanel({ messages, typers, selfId, participants = [] }) {
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(null); // 'emoji' | 'sticker' | null
  const [attachError, setAttachError] = useState(null);
  // The chat image currently open full-screen ({ url, name }), or null.
  const [viewing, setViewing] = useState(null);
  const logRef = useRef(null);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const fileInputRef = useRef(null); // hidden <input type=file>: any file
  const imageInputRef = useRef(null); // hidden <input type=file>: images only
  // Outbound typing state.
  const typingRef = useRef({ active: false, lastSent: 0, idle: null });
  // Messages already here when the panel opened don't animate; anything that
  // arrives after gets the bounce-in.
  const [initialIds] = useState(() => new Set(messages.map((m) => m.id)));

  // --- edit / unsend (your own messages only) ----------------------------
  // Unsent messages arrive flagged `unsent` (see App.jsx). They play a
  // fade-out, and once that ends their id goes in here and they're no longer
  // drawn at all. Anything unsent before the panel opened is gone from the
  // start — no point animating it.
  const [goneIds, setGoneIds] = useState(
    () => new Set(messages.filter((m) => m.unsent).map((m) => m.id)),
  );
  // Safety net for the fade-out: browsers PAUSE animations in background tabs,
  // so if someone unsends while this tab is hidden, the fade never ends and
  // onAnimationEnd never fires. A plain timer (a little longer than the 0.3s
  // fade) removes the message anyway. Normally the animation wins the race.
  useEffect(() => {
    const pending = messages.filter((m) => m.unsent && !goneIds.has(m.id));
    if (pending.length === 0) return undefined;
    const timer = setTimeout(() => {
      setGoneIds((ids) => {
        const next = new Set(ids);
        pending.forEach((m) => next.add(m.id));
        return next;
      });
    }, 450);
    return () => clearTimeout(timer);
  }, [messages, goneIds]);

  // Which of my messages is being edited (its id), and the draft text.
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  // Touch screens have no hover, so tapping one of your messages toggles its
  // ✎ / 🗑 buttons instead. This is the id currently showing them.
  const [actionsFor, setActionsFor] = useState(null);

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

  // Enter sends, Shift+Enter makes a new line (the box is a multi-line
  // <textarea> now, like the design's tall message box).
  function onComposeKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) sendText(e);
  }

  // Their profile picture, while they're still here (initials otherwise).
  const avatarOf = (id) => participants.find((p) => p.id === id)?.avatar;

  // Everything still on screen (unsent messages stay until their fade ends).
  const visible = messages.filter((m) => !goneIds.has(m.id));
  const groups = groupMessages(visible);
  const [typingWho, typingWhat] = typingParts(typingNames);

  function startEdit(m) {
    setEditingId(m.id);
    setEditText(m.text);
    setActionsFor(null);
  }
  const cancelEdit = () => setEditingId(null);

  // Send the edit. The server re-checks it's really yours, then tells the
  // whole room (CHAT_EDITED) — including us, which is how our own copy updates.
  function saveEdit(m) {
    const body = editText.trim();
    if (!body) return;
    if (body !== m.text) {
      socket.emit(EVENTS.CHAT_EDIT, { id: m.id, text: body }, (ack) => {
        if (!ack?.ok) setAttachError(ack?.error ?? 'Could not edit the message.');
      });
    }
    cancelEdit();
  }

  // Unsend = delete for everyone. Confirm first — there's no undo.
  async function unsend(m) {
    setActionsFor(null);
    const ok = await confirmDialog({
      title: 'Unsend this message?',
      message: 'It will be removed for everyone.',
      confirmLabel: 'Unsend',
      danger: true,
    });
    if (!ok) return;
    socket.emit(EVENTS.CHAT_UNSEND, { id: m.id }, (ack) => {
      if (!ack?.ok) setAttachError(ack?.error ?? 'Could not unsend the message.');
    });
  }

  // The inline editor that replaces a bubble while you edit it.
  function renderEditor(m) {
    return (
      // stopPropagation: clicks inside the editor mustn't toggle the
      // message's action buttons (the onClick on the message around it).
      <div className="cp-edit" onClick={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          // put the cursor at the END of the text, not the start
          onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault(); // no newline
              saveEdit(m);
            } else if (e.key === 'Escape') {
              e.stopPropagation(); // don't also close a picker / dropdown
              cancelEdit();
            }
          }}
          rows={2}
          maxLength={2000}
          aria-label="Edit message"
        />
        <div className="cp-edit-bar">
          <span className="cp-edit-hint" title="Enter saves · Esc cancels">
            Enter ↵ · Esc
          </span>
          <button type="button" className="cp-edit-btn" onClick={cancelEdit}>
            Cancel
          </button>
          <button
            type="button"
            className="cp-edit-btn save"
            onClick={() => saveEdit(m)}
            disabled={!editText.trim()}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  // What goes inside one message: a sticker, an image, a file pill, or text.
  function renderBody(m) {
    if (m.kind === 'sticker') {
      return (
        <span className="cp-sticker" role="img" aria-label="sticker">
          {m.text}
        </span>
      );
    }
    if (m.kind === 'file' && m.file?.type?.startsWith('image/')) {
      // Two controls over one picture:
      //  - the thumbnail itself is a button that opens the full-screen viewer
      //  - a small round download link sits in its top-right corner (shown
      //    on hover). It's a SIBLING of the button, not inside it, so
      //    clicking it only downloads — it never also opens the viewer.
      return (
        <div className="cp-image-wrap">
          <button
            type="button"
            className="chat-image-btn"
            onClick={() => setViewing({ url: m.file.url, name: m.file.name })}
            aria-label={`View ${m.file.name}`}
          >
            <img className="chat-image" src={m.file.url} alt={m.file.name} />
          </button>
          {/* <a download> saves the file instead of navigating to it. The
              image is a data: URL already in memory, so no server trip. */}
          <a
            className="cp-image-dl"
            href={m.file.url}
            download={m.file.name}
            aria-label={`Download ${m.file.name}`}
            title="Download"
          >
            <Download />
          </a>
        </div>
      );
    }
    if (m.kind === 'file') {
      // Any other file: the design's pill — blue document icon + file name,
      // and a download arrow at the end so it's obvious what a click does.
      // The size shows in the hover tooltip.
      return (
        <a
          className="cp-bubble cp-file"
          href={m.file.url}
          download={m.file.name}
          title={`${m.file.name} · ${formatBytes(m.file.size)} · click to download`}
        >
          <span className="cp-file-icon">
            <FileDoc />
          </span>
          <span className="cp-file-name">{m.file.name}</span>
          <Download className="cp-file-dl" aria-hidden="true" />
        </a>
      );
    }
    return (
      <span className="cp-bubble">
        {m.text}
        {/* shown to everyone once the sender has changed the text */}
        {m.editedAt && <span className="cp-edited"> (edited)</span>}
      </span>
    );
  }

  return (
    <div className="cp-chat" ref={rootRef}>
      <div className="cp-log" ref={logRef}>
        {visible.length === 0 && <p className="cp-empty">No messages yet. Say hi 👋</p>}

        {groups.map((g) => {
          const mine = g.from === selfId;
          const lastTs = g.items[g.items.length - 1].ts;
          // Every message in this group is being unsent -> fade the whole
          // group (avatar + "• Name time" line too), not just the bubbles.
          const allUnsent = g.items.every((m) => m.unsent);
          return (
            // Keyed by the group's first message id: stays stable as it grows.
            <div
              key={g.items[0].id}
              className={`cp-group${mine ? ' mine' : ''}${allUnsent ? ' unsending' : ''}`}
            >
              <div className="cp-group-row">
                {/* Avatar only for other people; it sits at the bottom of the
                    group, next to their latest message. */}
                {!mine && <Avatar name={g.name} src={avatarOf(g.from)} size={38} />}
                <div className="cp-bubbles">
                  {g.items.map((m) => {
                    const editing = editingId === m.id;
                    // My own, still-live message, not mid-edit -> it gets the
                    // ✎ Edit (text only) and 🗑 Unsend buttons.
                    const canAct = mine && !m.unsent && !editing;
                    return (
                      <div
                        key={m.id}
                        className={[
                          'cp-item',
                          // Messages already here when the panel opened
                          // don't animate; new arrivals get the bounce-in.
                          !initialIds.has(m.id) && 'chat-new',
                          m.unsent && 'unsending',
                          actionsFor === m.id && 'show-actions',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        // Touch screens: tap your message to show its buttons.
                        onClick={
                          canAct
                            ? () => setActionsFor((id) => (id === m.id ? null : m.id))
                            : undefined
                        }
                        // When the unsend fade-out finishes, stop drawing it.
                        // (Only the item's OWN animation — not ones bubbling
                        // up from inside it, like the bounce-in's.)
                        onAnimationEnd={(e) => {
                          if (m.unsent && e.target === e.currentTarget) {
                            setGoneIds((ids) => new Set(ids).add(m.id));
                          }
                        }}
                      >
                        {canAct && (
                          // Sits on the bubble's left (mine are right-aligned).
                          // Hidden until you hover the message (see CSS).
                          <span className="cp-actions">
                            {m.kind === 'text' && (
                              <button
                                type="button"
                                className="cp-action"
                                onClick={(e) => {
                                  e.stopPropagation(); // don't toggle the buttons
                                  startEdit(m);
                                }}
                                aria-label="Edit message"
                                title="Edit"
                              >
                                <Pencil />
                              </button>
                            )}
                            <button
                              type="button"
                              className="cp-action danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                unsend(m);
                              }}
                              aria-label="Unsend message"
                              title="Unsend"
                            >
                              <Trash />
                            </button>
                          </span>
                        )}
                        {editing ? renderEditor(m) : renderBody(m)}
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* "• Christiana Jona 11:34 AM" / "• You 12:00 PM" */}
              <div className="cp-meta">
                <span className="cp-meta-dot" aria-hidden="true" />
                {mine ? 'You' : g.name} {timeOf(lastTs)}
              </div>
            </div>
          );
        })}
      </div>

      {attachError && <p className="err cp-attach-err">{attachError}</p>}

      {/* "T  Lisa is typing (• • •)" — just above the message box, with the
          original iMessage-style bouncing dots as the animation. */}
      {typingNames.length > 0 && (
        <div className="cp-typing" aria-live="polite">
          <TypeT className="cp-typing-icon" />
          <b>{typingWho}</b> {typingWhat}
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}

      {/* One picker with two tabs. `picker` says which tab is showing
          ('emoji' | 'sticker'), or null when it's closed. */}
      {picker && (
        <div className="cp-picker">
          <div className="cp-picker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={picker === 'emoji'}
              className={picker === 'emoji' ? 'on' : ''}
              onClick={() => setPicker('emoji')}
            >
              Emoji
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={picker === 'sticker'}
              className={picker === 'sticker' ? 'on' : ''}
              onClick={() => setPicker('sticker')}
            >
              Stickers
            </button>
          </div>
          {picker === 'emoji' ? (
            <div className="cp-picker-grid emoji" role="listbox" aria-label="Emojis">
              {EMOJIS.map((e) => (
                <button key={e} type="button" onClick={() => addEmoji(e)}>
                  {e}
                </button>
              ))}
            </div>
          ) : (
            <div className="cp-picker-grid sticker" role="listbox" aria-label="Stickers">
              {STICKERS.map((s) => (
                <button key={s} type="button" onClick={() => sendSticker(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The composer: one rounded box — text on top, tools along the bottom. */}
      <form className="cp-compose" onSubmit={sendText}>
        <textarea
          ref={inputRef}
          value={text}
          onChange={onInputChange}
          onKeyDown={onComposeKeyDown}
          onBlur={stopTyping}
          onPaste={onPaste}
          placeholder="Message..."
          maxLength={2000}
          rows={2}
          aria-label="Message the room"
        />
        <div className="cp-compose-tools">
          {/* Two attach buttons, each clicking its own hidden file input:
              - the picture opens the file picker filtered to images
              - the paperclip accepts ANY file (PDF, doc, zip, ...)
              Both go through the same onFilePick -> sendFile path, so images
              still get downscaled and everything respects the size cap.
              (Pasting a file into the message box works too — see onPaste.) */}
          <span className="cp-compose-left">
            <button
              type="button"
              className="cp-tool"
              aria-label="Send a photo"
              title="Send a photo"
              onClick={() => imageInputRef.current?.click()}
            >
              <ImageIcon />
            </button>
            <button
              type="button"
              className="cp-tool"
              aria-label="Send a file"
              title="Send a file"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip />
            </button>
          </span>
          <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={onFilePick} />
          <input ref={fileInputRef} type="file" hidden onChange={onFilePick} />

          <span className="cp-compose-right">
            <button
              type="button"
              className={`cp-tool${picker ? ' on' : ''}`}
              aria-label="Emoji and stickers"
              title="Emoji and stickers"
              onClick={() => setPicker((p) => (p ? null : 'emoji'))}
            >
              <Smile />
            </button>
            <button
              type="submit"
              className="cp-tool cp-send"
              disabled={!text.trim()}
              aria-label="Send"
              title="Send"
            >
              <Send />
            </button>
          </span>
        </div>
      </form>

      {/* Full-screen viewer for a clicked chat image. It portals itself into
          <body>, so where it sits here doesn't matter — it's just the natural
          owner of the `viewing` state. `onClose` fires after its zoom-out. */}
      {viewing && (
        <ImageViewer src={viewing.url} alt={viewing.name} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
