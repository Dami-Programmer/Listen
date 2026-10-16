// Visitor counts with Umami (umami.is) — privacy-friendly: no cookies, no
// personal data, nothing to accept. Switched OFF unless the website ID is set:
// on Render, the website (Listen-2) needs the environment variable
//   VITE_UMAMI_WEBSITE_ID = <the id Umami shows for the site>
// and a redeploy (it's read when the site is built). Without it, nothing
// here does anything.
//
// What's reported — never a page's address, so room names stay private:
//   a page view, as the KIND of page: /landing, /home, /meeting,
//   /recording, /privacy
//   a few moments (trackEvent): "start clicked", "demo played",
//   "joined meeting" (as host or guest), "knocked" (waiting room)
// Skipped entirely inside the landing page's demo frames (pretend meetings
// aren't visitors), and for browsers that ask not to be tracked.

const WEBSITE_ID = import.meta.env.VITE_UMAMI_WEBSITE_ID;

/** Load Umami and count this page view. `kind` is the page kind from main.jsx. */
export function installAnalytics(kind) {
  if (!WEBSITE_ID || kind === 'demo') return;
  const script = document.createElement('script');
  script.defer = true;
  script.src = 'https://cloud.umami.is/script.js';
  script.dataset.websiteId = WEBSITE_ID;
  script.dataset.autoTrack = 'false'; // we send the page view ourselves (below)
  script.dataset.doNotTrack = 'true'; // respect the browser's "do not track"
  script.onload = () => {
    window.umami?.track((props) => ({
      ...props,
      // the kind of page, never the real address (it can hold a room name)
      url: `/${kind}`,
      title: `Turnly · ${kind}`,
      // where they came from — only if it's another site (our own pages'
      // addresses could hold a room name)
      referrer: externalReferrer(),
    }));
  };
  document.head.appendChild(script);
}

function externalReferrer() {
  try {
    const ref = new URL(document.referrer);
    return ref.origin === window.location.origin ? '' : ref.origin;
  } catch {
    return '';
  }
}

/** Count a moment ("joined meeting", …), with a little non-personal detail. */
export function trackEvent(name, data) {
  try {
    window.umami?.track(name, data);
  } catch {
    // counting must never break anything
  }
}
