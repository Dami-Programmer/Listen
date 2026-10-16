// Live captions: what people say, as text, along the bottom of the call.
//
// How it works (the free, in-browser way):
//   - Anyone can switch captions on for themselves (the CC button). While at
//     least one person in the room has them on, room-state says `captionsOn`
//     (server/src/rooms.js) and everyone sees "Captions on".
//   - Then each SPEAKER's own browser turns their speech into text
//     (useTranscriber, with the browser's built-in speech recognition) and
//     sends it to the room as EVENTS.CAPTION. Never stored anywhere.
//   - Everyone with captions on shows the latest lines (useCaptionLines).
//
// Only while it's right to: captions on in the room, YOUR mic on, and you
// allowed to speak (not a listener in a moderated room). Mic off = nothing is
// transcribed.
//
// Limits (the browser's, not ours):
//   - Speech recognition exists in Chrome, Edge and Safari — not Firefox.
//     Firefox users can still SEE captions; they just aren't transcribed.
//   - The browser sends the audio to its own speech service (Google's in
//     Chrome / Edge, Apple's in Safari) to do it — the privacy page says so.
//   - It listens to the computer's default microphone, not one picked in
//     Turnly's settings.
//   - Phones show captions but don't transcribe: running speech recognition
//     next to a call on a phone often fights over the microphone and breaks
//     the call's own audio.

import { useEffect, useState } from 'react';
import { EVENTS } from '@listen/shared';
import { socket } from './socket.js';

const Recognition =
  typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition;

/** Can this browser turn speech into text at all? */
export const canTranscribe = Boolean(Recognition);

const SHOW_MS = 6000; // a line stays this long after its last update
const MAX_PEOPLE = 2; // lines shown at once (the two most recent talkers)
const SEND_EVERY_MS = 350; // at most ~3 updates a second while talking

/**
 * The caption lines to show: [{ id, name, text, final, at }], oldest first.
 * Empty (and not listening) while `enabled` is false.
 */
export function useCaptionLines(enabled) {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (!enabled) {
      setLines([]);
      return undefined;
    }
    const onCaption = (c) =>
      setLines((prev) =>
        // one line per person: their newest words replace their older ones
        [...prev.filter((l) => l.id !== c.id), { ...c, at: Date.now() }].slice(-MAX_PEOPLE),
      );
    socket.on(EVENTS.CAPTION, onCaption);
    // fade out whoever stopped talking a while ago
    const tidy = setInterval(() => {
      setLines((prev) => {
        const kept = prev.filter((l) => Date.now() - l.at < SHOW_MS);
        return kept.length === prev.length ? prev : kept;
      });
    }, 1000);
    return () => {
      socket.off(EVENTS.CAPTION, onCaption);
      clearInterval(tidy);
    };
  }, [enabled]);
  return lines;
}

/**
 * Turn MY speech into text and send it to the room, while `active`. Starts
 * and stops with it — e.g. muting the mic stops it straight away.
 */
export function useTranscriber(active) {
  useEffect(() => {
    if (!active || !Recognition) return undefined;
    let stopped = false;
    let rec = null;
    let lastSent = 0;
    let pending = null; // the newest unsent in-between text
    let timer = null;
    let failures = 0; // back off if the speech service keeps failing

    const send = (text, final) => {
      socket.emit(EVENTS.CAPTION, { text, final });
      lastSent = Date.now();
    };

    const start = () => {
      rec = new Recognition();
      rec.continuous = true;
      rec.interimResults = true; // words as they're spoken, not just at the end
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (e) => {
        failures = 0;
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const result = e.results[i];
          const text = result[0].transcript.trim();
          if (!text) continue;
          if (result.isFinal) {
            // a finished sentence: send it now
            clearTimeout(timer);
            timer = null;
            pending = null;
            send(text, true);
          } else if (Date.now() - lastSent >= SEND_EVERY_MS) {
            send(text, false);
          } else {
            // too soon after the last update: send the newest text shortly
            pending = text;
            timer ??= setTimeout(() => {
              timer = null;
              if (pending) send(pending, false);
              pending = null;
            }, SEND_EVERY_MS);
          }
        }
      };
      rec.onerror = (e) => {
        // The person (or the browser) said no to the microphone: give up.
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopped = true;
        else failures += 1;
      };
      // The browser stops listening after a pause or about a minute — keep
      // going while captions are still wanted.
      rec.onend = () => {
        if (stopped) return;
        setTimeout(() => !stopped && start(), Math.min(10_000, 300 * 2 ** failures));
      };
      try {
        rec.start();
      } catch {
        // already starting — the onend restart will pick it up
      }
    };

    start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      try {
        rec?.abort();
      } catch {
        // already stopped
      }
    };
  }, [active]);
}
