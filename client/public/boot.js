// Runs first, before the page draws (index.html loads it in <head>, not
// deferred). Two small jobs that can't wait for the app's code:
//
//   1. light or dark — so a light-mode visitor never sees a flash of dark
//      while the app loads. Same rule as theme.js: the saved choice
//      ('light' / 'dark'), or else the device's own setting. Keep the key
//      'listen.theme' in sync with theme.js.
//   2. only the fonts this page uses (it used to load all five families on
//      every page), picked from the address — the same pages main.jsx shows:
//        landing page (/) + privacy page   Barlow, Manrope, IBM Plex Mono
//        everything else (the app: home    Inter, Plus Jakarta Sans
//        screen, meetings, recordings,
//        the landing page's demo frames)
//
// (A file of its own rather than inline in index.html, so the site's
// security policy can allow "scripts from this site" without having to
// list a fingerprint of each inline script.)
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem('listen.theme');
  } catch {
    /* storage blocked: follow the device */
  }
  if (choice !== 'light' && choice !== 'dark') {
    choice = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = choice;

  var path = location.pathname;
  var q = new URLSearchParams(location.search);
  var landing =
    path === '/privacy' || (path === '/' && !q.get('room') && !q.has('profile') && !q.get('rec'));
  var families = landing
    ? 'family=Barlow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800'
    : 'family=Inter:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800';
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?' + families + '&display=swap';
  document.head.appendChild(link);
})();
