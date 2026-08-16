# Vvynas Vane — Web

A web replica of the Vvynas Vane Android music player: your local song
library, playlists, folders, favorites, monthly/yearly recap, a video
player with auto-detected subtitles and multi-language audio, DJ Mode, and
a full-screen player with 42 animated backgrounds — all running in the
browser. No file is ever uploaded; everything plays straight from the
folder you grant access to, on-device.

## Files

```
index.html   Library / player / playlists / folders / favorites (main hub)
video.html   Video + M4A player, with subtitle and multi-audio-track support
recap.html   Monthly & yearly listening recap, purple starry theme + poster download
dj.html      DJ Mode — dual decks, crossfader, bass boost, 4 visualizer themes
shared.js    IndexedDB, 8-font manager, storage access, 42 animated themes,
             pixie dust, book-page transition, orbiting globe title, sigil art
app.js       Library page logic
video.js     Video page logic
recap.js     Recap page logic
dj.js        DJ Mode logic + visualizer
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
  added/play count. Folders, Playlists, Favorites, generated per-song gold
  sigil art, shuffle/repeat, up-next queue, full-screen player with
  lock-screen media controls.
- **42 animated backgrounds**, ported theme-by-theme from
  `AnimatedThemeView.java`, plus pixie-dust tap sparkles, a storybook
  page-turn transition, and an orbiting globe-title wordmark.
- **8-font customization** (Settings → Font), applied live app-wide.
- **Monthly & yearly recap** (`recap.html`): purple-starry screen matching
  `RecapActivity`'s own palette, with a downloadable poster.
- **Video player** (`video.html`) — see below for playback, subtitles, and
  multi-language audio.
- **DJ Mode** (`dj.html`): dual decks, real crossfader, bass boost, Auto
  Mix, Beat Sync, play-count shoutouts, a battle queue, and 4 beat-reactive
  visualizer themes running as a true full-page background — ported from
  `DJModeActivity.java` / `DJVisualizer.java`.
- **Connecting overlay**: an hourglass loader with cycling status text
  while granting/resuming folder access, instead of a frozen screen.
- **Installable**: manifest + service worker power "Add to Home Screen,"
  available from the sidebar/Settings — not pushed on first load.
- **Dark mode**: true near-black (`#000000`/`#050505`/`#0B0B0B`) across the
  whole app, with the gold/crimson accents kept intact.
- **Responsive**: sidebar + wide player on tablet/laptop, bottom tab bar +
  compact player on phones.

## Video playback & subtitles (`video.html`)

**MKV support.** Browsers don't have one universal answer for MKV — there's
no reliable, fully-stable way to force-decode a codec a browser genuinely
doesn't support without a heavy WASM transcoder, which isn't fast or
stable enough for a real player. Instead this uses the two changes that
actually move the needle and are dependency-free:

1. Every file is re-wrapped in a `Blob` with the *correct* MIME type
   (`video/x-matroska` for `.mkv`, etc.) before playback. Browsers/OSes
   frequently fail to auto-detect the right type for less common
   extensions — `.mkv` especially — which was silently breaking codec
   detection. This alone fixes playback for the large majority of MKV
   files (H.264 or VP9/VP8 video + AAC/Opus/Vorbis/MP3 audio — what most
   real-world MKV rips actually use).
2. If a video track still can't be decoded (most often an HEVC/H.265 MKV,
   which Chrome/Firefox don't support without OS-level codec support), the
   player **detects and explains it directly** — checking for
   `videoWidth === 0` on a file that isn't audio-only — instead of leaving
   a silent black screen while only audio plays. It tells you what's
   likely wrong and suggests VLC or re-encoding.

**Subtitles — auto-detected, with language recognition.** Implemented with
native `<track kind="subtitles">` + WebVTT — the one subtitle format every
browser supports with zero dependencies (no browser can extract embedded
subtitle streams from an MKV container, so this is the closest stable
equivalent):

- Drop one or more `.srt`/`.vtt` files next to a video with a matching
  filename and they're auto-detected the moment you play it. Language-
  tagged filenames are recognized automatically — `Movie.en.srt`,
  `Movie.fr.srt`, `Movie.spanish.srt`, etc. (20 common language codes/
  names) — and English is auto-selected and displayed first if present.
- Press **V** anytime to cycle subtitle languages (Off → each detected
  language → Off) — the same convention VLC uses.
- The **CC** button opens a picker showing every detected language by
  name, or lets you load any `.srt`/`.vtt` manually.

**Multi-language audio, with an English recommendation.** Uses the native
`HTMLMediaElement.audioTracks` API (Chrome/Edge/Opera; not exposed by
Firefox/Safari, so this quietly does nothing there rather than break):

- If a file has more than one embedded audio track (common for dubbed
  rips) and an English track is found, it's **switched to automatically**
  as the default, with a toast explaining what happened.
- If multiple tracks exist but none are taggable as English, you're
  prompted to pick one via the new **AUD** button (only shown when more
  than one track is present).

## DJ Mode (`dj.html`)

A full port of `DJModeActivity.java` + `DJVisualizer.java` — dual decks
each on their own Web Audio graph, a constant-power crossfader, an
808/bass-boost low-shelf filter, per-deck pitch control, Auto Mix with the
same phased crossfade timing as the source, Beat Sync, the original
Game-of-Thrones-flavored play-count shoutouts, a battle queue, and 4
beat-reactive visualizer themes (DRAGONFIRE / LANNISTER / STARK WINTER /
NIGHT KING) ported 1:1 from `DJVisualizer`'s layered grid/lasers/rings/
waveform bars/particles.

The visualizer runs as a full-page fixed background behind every screen in
DJ Mode. The deck/mixer/queue cards are glass panels (blurred, translucent)
rather than opaque, so the animation stays visible throughout — and its
own brightness/particle count are dialed back (an internal `INTENSITY`
multiplier) so it reads as ambient motion rather than competing with the
controls for attention.

Reachable from the sidebar, the Settings modal, or directly at `dj.html`.

## Fix log

- Removed the "Add to Home Screen" prompt from first-load onboarding
  (still reachable from Settings/sidebar).
- Added hourglass/orbit/track/dot loaders in fitting spots across the app.
- Fixed a mobile tab-bar visibility bug after resize/rotation.
- Fixed folder-picker cancellation during a rescan stranding you on the
  "Grant Access" screen instead of returning to your loaded library.
- Fixed a bug where "Grant Access" buttons had both a permanent click
  listener and a reassigned `.onclick` for "Resume Access," so a resume
  tap fired both at once. Every grant button now uses a single
  reassignable handler.
- Fixed MKV files frequently failing to show video (playing audio only) by
  correcting MIME-type detection.
- Added subtitle support with automatic sibling-file + language detection,
  SRT→VTT conversion, a "V" keyboard shortcut, and a CC picker.
- Added multi-language audio-track detection with an automatic English
  preference and an AUD picker for manual selection.
- Tuned DJ Mode's visualizer to run as a true full-page background with
  glass-panel cards and reduced animation intensity.
- Pushed dark mode to true near-black across the whole app.

## Still simplified

The lyrics view and ID3-embedded album art (this still uses generated
sigil art) aren't in this pass — say the word and they can be ported next
the same way, straight from the source.
