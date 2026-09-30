// Profile picture picker for the pre-join lobby. Two ways to get one:
//
//  - Upload: any image file, center-cropped and downscaled right here to a
//    small square JPEG data: URL (it rides in every room-state snapshot, so it
//    has to stay tiny).
//  - Search: type a character's name and pick from images found on Wikipedia
//    (any character, person or thing with an article) and MyAnimeList (anime /
//    manga characters). Both APIs allow browser requests, so no server is
//    involved; the chosen image URL is used as-is.
//
// The server re-checks whatever we send (cleanAvatar in @listen/shared).

import { useEffect, useRef, useState } from 'react';
import { AVATAR_MAX_CHARS, AVATAR_SIZE_PX } from '@listen/shared';
import Avatar from './Avatar.jsx';

// Crop the middle square out of an image file and shrink it to a JPEG data URL.
async function fileToAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE_PX;
  canvas
    .getContext('2d')
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE_PX,
      AVATAR_SIZE_PX,
    );
  bitmap.close();
  // Step the quality down until it fits (almost always the first try).
  for (const quality of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= AVATAR_MAX_CHARS) return url;
  }
  throw new Error('too big');
}

// fetch() that gives up after `ms` — one slow source mustn't stall the other —
// and still honors the caller's abort (a newer query replaced this one).
async function fetchJson(url, signal, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const stop = () => ctrl.abort();
  signal.addEventListener('abort', stop);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}

async function searchWikipedia(q, signal) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'search',
    gsrsearch: q,
    gsrlimit: '12',
    prop: 'pageimages',
    piprop: 'thumbnail',
    pithumbsize: '200',
    pilicense: 'any', // character art is usually non-free; include it
  });
  const data = await fetchJson(`https://en.wikipedia.org/w/api.php?${params}`, signal);
  return (data.query?.pages ?? [])
    .filter((p) => p.thumbnail?.source)
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ name: p.title, url: p.thumbnail.source, source: 'Wikipedia' }));
}

async function searchAnime(q, signal) {
  const params = new URLSearchParams({ q, limit: '12', order_by: 'favorites', sort: 'desc' });
  const data = await fetchJson(`https://api.jikan.moe/v4/characters?${params}`, signal);
  return (data.data ?? [])
    .map((c) => ({ name: c.name, url: c.images?.jpg?.image_url, source: 'MyAnimeList' }))
    .filter((c) => c.url && !c.url.includes('questionmark')); // MAL's "no image"
}

// Both searches at once; either may fail on its own. Results alternate
// between the two sources so neither buries the other.
async function searchCharacters(q, signal) {
  const [anime, wiki] = await Promise.allSettled([
    searchAnime(q, signal),
    searchWikipedia(q, signal),
  ]);
  const lists = [anime, wiki].map((r) => (r.status === 'fulfilled' ? r.value : []));
  const seen = new Set();
  const merged = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) {
    for (const list of lists) {
      const item = list[i];
      if (item && !seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    }
  }
  return merged;
}

export default function AvatarPicker({ name, avatar, onChange }) {
  const fileRef = useRef(null);
  const [searching, setSearching] = useState(false); // the search panel is open
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [uploadError, setUploadError] = useState(null);

  // Debounced search: wait for a pause in typing, and cancel the previous
  // request when the query changes.
  useEffect(() => {
    const q = query.trim();
    if (!searching || q.length < 2) {
      setResults([]);
      setStatus('idle');
      return undefined;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setStatus('loading');
      searchCharacters(q, ctrl.signal)
        .then((list) => {
          setResults(list);
          setStatus('done');
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setStatus('error');
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, searching]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // picking the same file again still fires onChange
    if (!file) return;
    setUploadError(null);
    if (!file.type.startsWith('image/')) {
      setUploadError('That isn’t an image.');
      return;
    }
    try {
      onChange(await fileToAvatar(file));
      setSearching(false);
    } catch {
      setUploadError('Couldn’t read that image. Try a JPG or PNG.');
    }
  }

  function pick(url) {
    onChange(url);
    setSearching(false);
    setQuery('');
  }

  return (
    <div className="ap">
      <span className="ap-label">Your picture</span>
      <div className="ap-row">
        <Avatar name={name.trim() || '?'} src={avatar} size={56} />
        <div className="ap-actions">
          <button type="button" className="ap-btn" onClick={() => fileRef.current?.click()}>
            Upload photo
          </button>
          <button
            type="button"
            className={`ap-btn${searching ? ' on' : ''}`}
            onClick={() => setSearching((v) => !v)}
            aria-expanded={searching}
          >
            Find a character
          </button>
          {avatar && (
            <button type="button" className="ap-btn ap-remove" onClick={() => onChange(null)}>
              Remove
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
      </div>
      {uploadError && <p className="err">{uploadError}</p>}

      {searching && (
        <div className="ap-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Naruto, Batman, Mario"
            autoComplete="off"
            autoFocus
            aria-label="Search for a character"
          />
          {status === 'loading' && <p className="ap-hint">Searching…</p>}
          {status === 'error' && <p className="ap-hint">Search failed. Check your connection.</p>}
          {status === 'done' && results.length === 0 && (
            <p className="ap-hint">No pictures found for “{query.trim()}”.</p>
          )}
          {results.length > 0 && (
            <div className="ap-results">
              {results.map((r) => (
                <button
                  type="button"
                  key={r.url}
                  className={`ap-result${r.url === avatar ? ' on' : ''}`}
                  onClick={() => pick(r.url)}
                  title={`${r.name} · ${r.source}`}
                >
                  <img src={r.url} alt="" loading="lazy" />
                  <span>{r.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
