// The demo page (/demo?scene=…): the REAL Turnly call screen (CallView from
// App.jsx — and MobileCall inside it on a phone-sized frame), or the real
// lobby (PreJoin) for the room-link and scheduling scenes, running against
// the in-page demo server (demoServer.js) instead of the real one.
//
// The landing page shows this page in a frame (LandingDemos.jsx). It tells
// the landing page when it's ready, and starts over when asked to replay.
//
// This component does the job App.jsx does for a real meeting — join, then
// keep the room state and chat up to date from the socket's events — in a
// slimmed-down form (no reconnecting, no waiting room, no "you left" page).

import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS } from '@listen/shared';
import { socket } from '../socket.js';
import { CallView } from '../App.jsx';
import PreJoin from '../PreJoin.jsx';
import useIsMobile from '../useIsMobile.js';
import { createDemoServer } from './demoServer.js';
import { SCENES } from './scenes.js';

const tell = (type, extra = {}) => {
  if (window.parent !== window)
    window.parent.postMessage({ type, ...extra }, window.location.origin);
};

// Click a real button in the app, once it's on screen (by selector, and
// optionally the text it shows). Gives up quietly after a few seconds.
async function press(selector, text) {
  for (let i = 0; i < 50; i += 1) {
    const el = [...document.querySelectorAll(selector)].find(
      (b) => b.offsetParent !== null && (!text || b.textContent.includes(text)),
    );
    if (el) {
      el.click();
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export default function DemoApp() {
  const sceneId = new URLSearchParams(window.location.search).get('scene');
  const scene = SCENES[sceneId] ?? SCENES.raise;
  const phone = useIsMobile();

  const [phase, setPhase] = useState(scene.lobby ? 'lobby' : 'joining'); // lobby | joining | call | left
  const [selfId, setSelfId] = useState(null);
  const [state, setState] = useState(null);
  const [chat, setChat] = useState([]);
  const [typers, setTypers] = useState({});
  const [media, setMedia] = useState({ micOn: true, camOn: true });
  // the lobby's form
  const [name, setName] = useState('');
  const [title, setTitle] = useState(scene.title);
  const [avatar, setAvatar] = useState(null);
  // one pretend server for the page's life (stopped when the page goes away)
  const [server] = useState(() => createDemoServer(socket, scene));
  const opened = useRef(false);

  // The socket's events -> what's on screen (like App.jsx).
  useEffect(() => {
    socket.server = server;
    const onState = (snap) => setState(snap);
    const onMessage = (msg) => {
      setChat((c) => [...c, msg]);
      setTypers((t) => {
        if (!(msg.from in t)) return t;
        const next = { ...t };
        delete next[msg.from];
        return next;
      });
    };
    const onEdited = ({ id, text, editedAt }) =>
      setChat((c) => c.map((m) => (m.id === id ? { ...m, text, editedAt } : m)));
    const onUnsent = ({ id }) =>
      setChat((c) => c.map((m) => (m.id === id ? { ...m, unsent: true } : m)));
    const onTyping = ({ id, name: who, typing }) =>
      setTypers((t) => {
        const next = { ...t };
        if (typing) next[id] = who;
        else delete next[id];
        return next;
      });
    const onMoved = ({ selfId: id, state: snap, chat: history }) => {
      setSelfId(id);
      setState(snap);
      setChat(history ?? []);
    };
    socket.on(EVENTS.ROOM_STATE, onState);
    socket.on(EVENTS.CHAT_MESSAGE, onMessage);
    socket.on(EVENTS.CHAT_EDITED, onEdited);
    socket.on(EVENTS.CHAT_UNSENT, onUnsent);
    socket.on(EVENTS.CHAT_TYPING, onTyping);
    socket.on(EVENTS.MOVED, onMoved);
    const stop = () => server.stop();
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      socket.off(EVENTS.ROOM_STATE, onState);
      socket.off(EVENTS.CHAT_MESSAGE, onMessage);
      socket.off(EVENTS.CHAT_EDITED, onEdited);
      socket.off(EVENTS.CHAT_UNSENT, onUnsent);
      socket.off(EVENTS.CHAT_TYPING, onTyping);
      socket.off(EVENTS.MOVED, onMoved);
    };
  }, [server]);

  const join = useCallback((who) => {
    socket.connect();
    socket.emit(EVENTS.JOIN_ROOM, { roomId: 'demo', name: who || 'Alex' }, (ack) => {
      if (!ack?.ok) return;
      setSelfId(ack.selfId);
      setState(ack.state);
      setChat(ack.chat ?? []);
      setPhase('call');
    });
  }, []);

  // Straight into the call (every scene but the lobby ones).
  useEffect(() => {
    if (!scene.lobby) join('Alex');
  }, [scene, join]);

  // On screen: open the part of the app this scene is about, then tell the
  // landing page we're ready.
  useEffect(() => {
    if (opened.current) return;
    if (phase === 'lobby') {
      opened.current = true;
      (async () => {
        // .pj-row: the desktop lobby's link rows; .pj-claim: the phone lobby's links
        await press('.pj-row, .pj-claim', scene.lobby === 'claim' ? 'permanent link' : 'Schedule');
        tell('turnly-demo-ready', { scene: scene.id });
      })();
    } else if (phase === 'call' && state) {
      opened.current = true;
      (async () => {
        await new Promise((r) => setTimeout(r, 400));
        for (const [selector, text] of scene.open?.[phone ? 'phone' : 'desktop'] ?? []) {
          await press(selector, text);
          await new Promise((r) => setTimeout(r, 350));
        }
        tell('turnly-demo-ready', { scene: scene.id });
      })();
    }
  }, [phase, state, scene, phone]);

  const leave = useCallback(() => {
    socket.disconnect();
    setPhase('left');
  }, []);

  if (phase === 'lobby') {
    return (
      <PreJoin
        roomId=""
        name={name}
        title={title}
        avatar={avatar}
        onRoomId={() => {}}
        onName={setName}
        onTitle={setTitle}
        onAvatar={setAvatar}
        onSubmit={(e, prefs) => {
          e.preventDefault();
          if (prefs) setMedia(prefs);
          setPhase('joining');
          join(name.trim() || 'Alex');
        }}
      />
    );
  }

  if (phase === 'left') {
    return (
      <main className="demo-left">
        <h1>You left the demo meeting</h1>
        <p>Nothing was saved. It was all pretend.</p>
        <button
          type="button"
          className="ld-act primary"
          onClick={() => {
            tell('turnly-demo-replay');
            window.location.reload();
          }}
        >
          ↺ Start the demo again
        </button>
      </main>
    );
  }

  if (phase !== 'call' || !state) return <main className="demo-loading" aria-busy="true" />;

  return (
    <CallView
      state={state}
      chat={chat}
      typers={typers}
      selfId={selfId}
      onLeave={leave}
      media={media}
      iceServers={[]}
      rejoined // (no "Your meeting is ready — share the link" card in a demo)
    />
  );
}
