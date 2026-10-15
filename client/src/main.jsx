import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing.jsx';
import './index.css';
import { installPressFx } from './pressFx.js';

// Each page's code is downloaded only when that page is opened. The landing
// page used to carry the WHOLE app (call screen, recording page, the server
// connection…) before it could show anything — now it loads just itself, and
// the app's code comes later, when someone starts or joins a meeting (or the
// demo in a frame asks for it).
const App = lazy(() => import('./App.jsx'));
const RecordingPage = lazy(() => import('./RecordingPage.jsx'));
// The landing page's live demo: the real app against a pretend server, loaded
// only on /demo (see demo/DemoApp.jsx).
const DemoApp = lazy(() => import('./demo/DemoApp.jsx'));

// Same test as socket.js's IS_DEMO — repeated here so the landing page
// doesn't have to download socket.js (and the server connection) just to ask.
const IS_DEMO = window.location.pathname === '/demo';

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

let page;
if (IS_DEMO) page = <DemoApp />;
else if (recordingId) page = <RecordingPage id={recordingId} />;
else if (isLanding) page = <Landing />;
else page = <App />;

// (Suspense: nothing on screen for the moment a page's code is downloading.)
const render = () =>
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <Suspense fallback={null}>{page}</Suspense>
    </StrictMode>,
  );

// The demo's sandbox goes up before anything renders (storage, camera, mic,
// video connections and server calls stay inside the page — see demo/env.js).
// It's loaded only on /demo, then the demo starts.
if (IS_DEMO) {
  import('./demo/env.js').then(({ installDemoEnv }) => {
    installDemoEnv({ theme: params.get('theme') });
    render();
  });
} else render();
