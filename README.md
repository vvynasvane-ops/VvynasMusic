# Vvynas Vane — Web

A web replica of the Vvynas Vane Android music player: your local song
library, playlists, folders, favorites, monthly/yearly recap, a simple
video player, and a full-screen player with 42 animated backgrounds — all
running in the browser. No file is ever uploaded; everything plays straight
from the folder you grant access to, on-device.

## Files

```
index.html   Library / player / playlists / folders / favorites (main hub)
video.html   Simple, standard video + M4A player — no animation, no transitions
recap.html   Monthly & yearly listening recap, purple starry theme + poster download
shared.js    IndexedDB, 8-font manager, storage access, 42 animated themes,
             pixie dust, book-page transition, orbiting globe title
app.js       Library page logic
video.js     Video page logic
recap.js     Recap page logic
style.css    Shared styling
manifest.json / sw.js   PWA install + offline app shell
```

## Running it

Serve over **HTTPS or `localhost`** — a browser requirement for the
storage-access and install features, not something specific to this app.

```bash
cd vvynas-vane-web
python3 -m http.server 8080
# open http://localhost:8080
```

To deploy for real (so "Add to Home Screen" works everywhere), push this
folder to GitHub Pages, Netlify, Vercel, or any static host — no build
step required.

## Features

- **Library**: search + sort by title/artist/album/duration/size/year/date
  added/play count.
- **Folders, Playlists, Favorites**, generated per-song gold sigil art,
  shuffle/repeat, up-next queue, full-screen player with lock-screen media
  controls.
- **42 animated backgrounds**, ported theme-by-theme from
  `AnimatedThemeView.java` (same colors, same layout, same motion) —
  select one from Settings → Animated Background. Only shows on the full
  player screen, matching the Android app.
- **Pixie dust** tap sparkles, a **storybook page-turn** transition on
  every song change, and an orbiting **globe title** wordmark — all ported
  from their own Android view classes.
- **8-font customization** (Settings → Font): Monospace (the real app's
  actual default), Serif, Sans-serif, Condensed, Sans-serif Light/Medium/
  Black, and Casual — applied live across the whole app.
- **Monthly & yearly recap** (`recap.html`): a separate purple-starry
  screen (matching `RecapActivity`'s own palette) with listening time,
  songs played, top track, a month-by-month bar chart, and a downloadable
  poster image. Stats accumulate automatically as you listen.
- **Video player** (`video.html`): deliberately plain — standard controls,
  a Video/M4A file list, no animated backdrop or transitions.
- **Connecting overlay**: granting or resuming folder access shows a gold
  hourglass loader with cycling status text and a small traveling-car
  progress motif, so it's clear something real is happening in the
  background — rather than a frozen screen.
- **Installable**: manifest + service worker power native "Add to Home
  Screen" on Android/desktop, with in-app instructions for iOS Safari.
  This is available anytime from the sidebar or Settings — it's not pushed
  on first load.
- **Responsive**: sidebar + wide player on tablet/laptop, bottom tab bar +
  compact player on phones.

## Recent fixes

- Removed the "Add to Home Screen" prompt from the first-load onboarding
  screen (still reachable from Settings/sidebar).
- Added the hourglass/orbit/track/dot loaders across the app: hourglass +
  traveling car for the main connecting flow, an orbiting-particle spinner
  while the video page scans a folder, and a purple jelly-dot stream while
  the recap page reads your listening history.
- Fixed a mobile tab-bar visibility bug that could leave it in the wrong
  state after a resize/rotation.
- Fixed folder-picker cancellation during a *rescan* incorrectly stranding
  you on the "Grant Access" screen instead of returning to your already-
  loaded library.

## Still simplified

DJ Mode and its visualizer, the lyrics view, and ID3-embedded album art
(this still uses generated sigil art) aren't in this pass — say the word
and they can be ported next the same way, straight from the source.
