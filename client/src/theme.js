// Light / dark theme: remembers the user's choice and applies it to the page.
//
// The user's CHOICE is one of three:
//   'system' — follow the device's own light/dark setting (the default)
//   'light'  — always light
//   'dark'   — always dark
//
// The APPLIED theme is always just 'light' or 'dark'. It goes on <html> as
// data-theme="light" / "dark", and index.css switches every color from that.
// For 'system' we ask the browser which one the device prefers, and keep
// listening, so flipping the OS setting mid-call re-themes the app live.
//
// The same few lines also run in index.html before the app loads, so the first
// paint is already in the right theme (no dark flash for light-mode users).
// If you change the storage key or the values here, change them there too.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'listen.theme';
const CHOICES = ['system', 'light', 'dark'];

// The device's preference, as a live "media query" we can read and watch.
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

// Read the saved choice. Storage can throw (private mode, blocked site data),
// so any failure just means "no saved choice" → follow the device.
function readChoice() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return CHOICES.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

function saveChoice(choice) {
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Not saved — the choice still applies for this visit.
  }
}

// Turn a choice into the theme actually shown, and put it on <html>.
function apply(choice) {
  const theme = choice === 'system' ? (prefersLight.matches ? 'light' : 'dark') : choice;
  document.documentElement.dataset.theme = theme;
}

/**
 * React hook for the theme button.
 * @returns {[string, () => void]} the current choice ('system' | 'light' |
 *   'dark') and a function that moves to the next one in that order.
 */
export function useTheme() {
  const [choice, setChoice] = useState(readChoice);

  // Apply whenever the choice changes. While following the device, also
  // re-apply whenever the device's setting changes.
  useEffect(() => {
    apply(choice);
    if (choice !== 'system') return undefined;
    const onDeviceChange = () => apply('system');
    prefersLight.addEventListener('change', onDeviceChange);
    return () => prefersLight.removeEventListener('change', onDeviceChange);
  }, [choice]);

  const cycle = () => {
    const next = CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length];
    saveChoice(next);
    setChoice(next);
  };

  return [choice, cycle];
}
