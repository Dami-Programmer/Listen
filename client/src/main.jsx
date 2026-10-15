import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import RecordingPage from './RecordingPage.jsx';
import Landing from './Landing.jsx';
import { IS_DEMO } from './socket.js';
import { installDemoEnv } from './demo/env.js';
import './index.css';
import { installPressFx } from './pressFx.js';

// The landing page's live demo: the real app against a pretend server, loaded
// only on /demo (see demo/DemoApp.jsx).
const DemoApp = lazy(() => import('./demo/DemoApp.jsx'));

// Every button gets a smooth press-and-spring-back (pressFx.js).
installPressFx();

// Which page:
//   ?rec=<id>                  the recording page
//   / (nothing else)           the landing page (Landing.jsx) — for people
//                              who've never heard of Turnly
//   /demo?scene=…              the landing page's live demo (in a frame)
//   /start, ?room=…, /name     the app (home screen, or straight into a meeting)
const params = new URLSearchParams(window.location.search);
const recordingId = params.get('rec');
const isLanding = window.location.pathname === '/' && !params.get('room') && !params.has('profile');

// The demo's sandbox goes up before anything renders (storage, camera, mic
// and server calls stay inside the page — see demo/env.js).
if (IS_DEMO) installDemoEnv({ theme: params.get('theme') });

let page;
if (IS_DEMO) {
  page = (
    <Suspense fallback={null}>
      <DemoApp />
    </Suspense>
  );
} else if (recordingId) page = <RecordingPage id={recordingId} />;
else if (isLanding) page = <Landing />;
else page = <App />;

createRoot(document.getElementById('root')).render(<StrictMode>{page}</StrictMode>);
