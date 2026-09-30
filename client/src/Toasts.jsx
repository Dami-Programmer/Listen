// Pop-ups in the bottom-right corner, above the chat button: the person's
// avatar, name and what happened. Each one fades in over 1.5 s, stays 5 s and
// fades out over 1.5 s, rising the whole time (CSS); a toast is dropped when
// its animation ends. At most MAX_TOASTS on screen, newest at the bottom.
//
// Two kinds:
//  - chat: a new message, only while the chat panel is closed (opening it
//    clears them). Clicking one opens the panel. Edits show; an unsend
//    removes it.
//  - hand: someone raised their hand, whether the panel is open or not.
//
// Neither fires for your own actions, or for what was already there when you
// joined (chat history replayed on join, hands already up).

import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { Hand } from './icons.jsx';

const MAX_TOASTS = 3;

function preview(m) {
  if (m.kind === 'sticker') return <span className="toast-sticker">{m.text}</span>;
  if (m.kind === 'file') {
    return m.file?.type?.startsWith('image/') ? '📷 Photo' : `📎 ${m.file?.name ?? 'File'}`;
  }
  return m.text;
}

export default function Toasts({ chat, queue, selfId, participants, panelOpen, onOpen }) {
  // { key, kind: 'chat', id } | { key, kind: 'hand', personId }
  const [toasts, setToasts] = useState([]);
  const push = (items) => setToasts((list) => [...list, ...items].slice(-MAX_TOASTS));

  // Message ids already accounted for — seeded with whatever was in the chat
  // when the call opened, so the join history doesn't pop up.
  const seenMsgsRef = useRef(null);
  useEffect(() => {
    if (!seenMsgsRef.current) {
      seenMsgsRef.current = new Set(chat.map((m) => m.id));
      return;
    }
    const fresh = chat.filter((m) => !seenMsgsRef.current.has(m.id));
    fresh.forEach((m) => seenMsgsRef.current.add(m.id));
    const incoming = fresh.filter((m) => m.from !== selfId && !m.unsent);
    if (panelOpen || incoming.length === 0) return;
    push(incoming.map((m) => ({ key: `chat-${m.id}`, kind: 'chat', id: m.id })));
  }, [chat, selfId, panelOpen]);

  // Hands: anyone in the queue now who wasn't last time just raised theirs.
  // A counter keeps keys unique when someone lowers and raises again.
  const prevQueueRef = useRef(null);
  const handCountRef = useRef(0);
  useEffect(() => {
    const prev = prevQueueRef.current;
    prevQueueRef.current = queue;
    if (!prev) return;
    const raised = queue.filter((id) => !prev.includes(id) && id !== selfId);
    if (raised.length === 0) return;
    push(
      raised.map((id) => ({
        key: `hand-${id}-${++handCountRef.current}`,
        kind: 'hand',
        personId: id,
      })),
    );
  }, [queue, selfId]);

  // Opening the chat shows every message anyway; hand pop-ups stay.
  useEffect(() => {
    if (panelOpen) setToasts((list) => list.filter((t) => t.kind !== 'chat'));
  }, [panelOpen]);

  // Resolve each toast against live data: an edited message shows its new
  // text, an unsent one disappears.
  const shown = toasts
    .map((t) => {
      if (t.kind === 'chat') {
        const m = chat.find((x) => x.id === t.id);
        return m && !m.unsent ? { ...t, personId: m.from, name: m.name, body: preview(m) } : null;
      }
      const p = participants.find((x) => x.id === t.personId);
      return p
        ? {
            ...t,
            name: p.name,
            body: (
              <span className="toast-hand">
                <Hand /> raised their hand
              </span>
            ),
          }
        : null;
    })
    .filter(Boolean);
  if (shown.length === 0) return null;

  const dismiss = (key) => setToasts((list) => list.filter((t) => t.key !== key));

  return (
    <div className="toasts" aria-live="polite">
      {shown.map((t) => {
        const content = (
          <>
            <Avatar
              name={t.name}
              src={participants.find((p) => p.id === t.personId)?.avatar}
              size={40}
            />
            <span className="toast-body">
              <strong>{t.name}</strong>
              <span className="toast-text">{t.body}</span>
            </span>
          </>
        );
        // Rise and fade end together; removing twice is harmless.
        const onAnimationEnd = (e) => e.target === e.currentTarget && dismiss(t.key);
        return t.kind === 'chat' ? (
          <button
            key={t.key}
            type="button"
            className="toast"
            onClick={onOpen}
            onAnimationEnd={onAnimationEnd}
            title="Open chat"
          >
            {content}
          </button>
        ) : (
          <div key={t.key} className="toast toast-static" onAnimationEnd={onAnimationEnd}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
