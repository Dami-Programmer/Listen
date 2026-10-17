// "Start a meeting" was just clicked — remembered across the page change to
// /start, so the start page knows to show the water-filling splash
// (StartSplash.jsx). Session storage: this tab only, gone when it closes.
//
//   landing page: the start buttons call markStartClick() as they're clicked
//   start page:   main.jsx calls takeStartClick() — the click time, or null
//
// Open /start any other way (a bookmark, back button, a shared link) and
// there's no click to find, so no splash.

export const SPLASH_MS = 3000; // how long the splash lasts, from the click — change here
const KEY = 'turnly.startClick'; // when "Start a meeting" was clicked (ms)

/** Landing page: remember that "Start a meeting" was just clicked. */
export function markStartClick() {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage blocked: no splash, the start page just opens */
  }
}

/**
 * Start page: was "Start a meeting" just clicked? Returns the click time (and
 * forgets it, so a reload or the back button doesn't show the splash again),
 * or null. Older than SPLASH_MS = it would be over already, so null; "in
 * the future" (the clock was changed) = not trusted, so null too.
 */
export function takeStartClick() {
  try {
    const at = Number(sessionStorage.getItem(KEY));
    sessionStorage.removeItem(KEY);
    const age = Date.now() - at;
    return at && age >= 0 && age < SPLASH_MS ? at : null;
  } catch {
    return null;
  }
}
