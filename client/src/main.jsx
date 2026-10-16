import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import './index.css';
import { installPressFx } from './pressFx.js';
import { installErrorReporting } from './errorReport.js';
import { installAnalytics } from './analytics.js';

// Anything that goes wrong in the browser is reported to the server's logs
// (errorReport.js) — first thing, so even a crash while starting up is caught.
installErrorReporting();

// Each page's code is downloaded only when that page is opened. The landing
// page used to carry the WHOLE app (call screen, recording page, the server
// connection…) before it could show anything — now it loads just itself, and
// the app's code comes later, when someone starts or joins a meeting (or the
// demo in a frame asks for it).
const App = lazy(() => import('./App.jsx'));
const RecordingPage = lazy(() => import('./RecordingPage.jsx'));
const PrivacyPage = lazy(() => import('./PrivacyPage.jsx'));
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
//   /privacy                   the privacy page + terms of use (PrivacyPage.jsx)
//   /start, ?room=…, /name     the app (home screen, or straight into a meeting)
const params = new URLSearchParams(window.location.search);
const recordingId = params.get('rec');
const isLanding = window.location.pathname === '/' && !params.get('room') && !params.has('profile');

let page;
let kind; // for the error screen: which page this is (it picks its buttons by it)
if (IS_DEMO) {
  page = <DemoApp />;
  kind = 'demo';
} else if (recordingId) {
  page = <RecordingPage id={recordingId} />;
  kind = 'recording';
} else if (isLanding) {
  page = <Landing />;
  kind = 'landing';
} else if (window.location.pathname === '/privacy') {
  page = <PrivacyPage />; // privacy + terms of use
  kind = 'landing'; // (for the error screen: a plain page, just "Reload")
} else {
  page = <App />;
  // the app's home screen, or a meeting (a room in the address)
  kind = window.location.pathname === '/start' && !params.get('room') ? 'home' : 'meeting';
}

// (Suspense: nothing on screen for the moment a page's code is downloading.)
// ErrorBoundary: if the page crashes — or its code can't be downloaded, e.g.
// right after a new version went live — "Something went wrong" instead of a
// blank screen (ErrorBoundary.jsx).
// Visitor counts (analytics.js — off unless Umami's website ID is set). The
// privacy page counts as itself, not as "landing".
installAnalytics(window.location.pathname === '/privacy' ? 'privacy' : kind);

const render = () =>
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ErrorBoundary page={kind}>
        <Suspense fallback={null}>{page}</Suspense>
      </ErrorBoundary>
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
