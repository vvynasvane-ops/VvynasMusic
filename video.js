/* =========================================================================
   VVYNAS VANE — VIDEO PLAYER
   A simple, standard player for video (mp4/mkv/webm/mov/m4v/avi) and M4A
   files, plus subtitles. Deliberately undecorated — no animated theme, no
   page-turn transition.

   Playback strategy (deliberately conservative — "best all-time working
   methods" over anything experimental):
   - Wrap every file in a Blob with the CORRECT MIME type before creating
     an object URL. Browsers often can't guess the right type from a raw
     File for less common extensions (.mkv especially), which silently
     breaks codec/container detection.
   - Everything is first sniffed by content (magic bytes), not just by file
     name. MKV/WebM/MP4/MOV/3GP/OGV play natively wherever the browser's own
     demuxer + codecs allow it.
   - Anything else — AVI, WMV/ASF, FLV, MPEG-PS/TS, VOB, RealMedia, DV, MXF,
     HEVC or AC-3/DTS on browsers without them … — goes through vcompat.js:
     ffmpeg compiled to WebAssembly, running on the device (no upload). It
     repacks when the codecs are already browser-friendly (seconds, lossless),
     re-encodes only what must be, and for long videos plays a quick low-res
     preview while the full conversion finishes. See vformats.js (catalog +
     sniffer) and vcompat.js (engine).
   - When a video track fails to decode but audio keeps playing (the
     classic "MKV plays audio only" symptom), that's detected directly
     (videoWidth/videoHeight stay 0 on a file that isn't audio-only) and
     explained in the UI instead of leaving a silent blank frame.

   Subtitles: native <track kind="subtitles"> + WebVTT, the one subtitle
   format every browser supports natively with zero dependencies.
   - SRT files are auto-converted to VTT in-browser (well-established,
     mechanical conversion: header + comma-to-period timestamps).
   - Sibling subtitle files (same base filename as the video, in the same
     folder) are auto-detected from the same folder scan and offered
     immediately; any other .srt/.vtt file can also be loaded manually.
   ========================================================================= */
(() => {
"use strict";
const { idbGet, idbSet, fsApiSupported, verifyPermission, pickDirectory, getStoredHandle, walkDirectory,
        createVolumeController, volumeIconMarkup, renderShortcutList } = window.VV;

// Deliberately broad, same reasoning as AUDIO_EXT in shared.js: recognize
// every mainstream video container a person is likely to have on device,
// not just the handful that are guaranteed to actually decode. Whether a
// given file then *plays* still depends on the browser having a codec for
// what's inside it — playId below already warns up front via canPlayType()
// and explains per-error-code failures, so nothing gets silently skipped
// during a folder scan just because its extension wasn't on a short list.
const VIDEO_EXT = window.VVFormats.videoRegex;     // ~70 container / stream types — see vformats.js
const M4A_EXT = /\.m4a$/i;
const SUB_EXT = /\.(srt|vtt)$/i;
const ALL_EXT = window.VVFormats.allRegex;
// Explicit MIME map — File.type is frequently empty or wrong for less common extensions.
const MIME_BY_EXT = window.VVFormats.mimeMap;

// Language codes recognized in subtitle filenames, e.g. "Movie.en.srt",
// "Movie.eng.srt", "Movie.english.srt" — the standard convention most
// subtitle sites and rippers use. Keyed by every alias, so lookups are a
// single object hit regardless of which form the file uses.
const LANGUAGE_ALIASES = {
  en: "English", eng: "English", english: "English",
  fr: "French", fre: "French", fra: "French", french: "French",
  es: "Spanish", spa: "Spanish", spanish: "Spanish",
  de: "German", ger: "German", deu: "German", german: "German",
  it: "Italian", ita: "Italian", italian: "Italian",
  pt: "Portuguese", por: "Portuguese", portuguese: "Portuguese", "pt-br": "Portuguese (Brazil)",
  ja: "Japanese", jpn: "Japanese", japanese: "Japanese",
  ko: "Korean", kor: "Korean", korean: "Korean",
  zh: "Chinese", chi: "Chinese", zho: "Chinese", chinese: "Chinese",
  ar: "Arabic", ara: "Arabic", arabic: "Arabic",
  ru: "Russian", rus: "Russian", russian: "Russian",
  hi: "Hindi", hin: "Hindi", hindi: "Hindi",
  nl: "Dutch", dut: "Dutch", nld: "Dutch", dutch: "Dutch",
  sv: "Swedish", swe: "Swedish", swedish: "Swedish",
  tr: "Turkish", tur: "Turkish", turkish: "Turkish",
  pl: "Polish", pol: "Polish", polish: "Polish",
  vi: "Vietnamese", vie: "Vietnamese", vietnamese: "Vietnamese",
  th: "Thai", tha: "Thai", thai: "Thai",
};

/** Splits "Movie Name.en.srt" into { base: "movie name", lang: "English", langCode: "en" }.
 *  Falls back to base = full filename (no language tag) when nothing matches. */
function parseSubtitleName(filename) {
  const noExt = filename.replace(SUB_EXT, "");
  const parts = noExt.split(".");
  if (parts.length > 1) {
    const tag = parts[parts.length - 1].toLowerCase();
    if (LANGUAGE_ALIASES[tag]) {
      return { base: parts.slice(0, -1).join(".").toLowerCase(), lang: LANGUAGE_ALIASES[tag], langCode: tag };
    }
  }
  return { base: noExt.toLowerCase(), lang: null, langCode: null };
}

const state = {
  videos: [], m4as: [], subs: [], fileRefs: new Map(), subRefs: new Map(),
  queue: [], queueIndex: -1, usingFSApi: false, objectUrl: null,
  currentTrackEl: null, currentSubUrl: null, currentItem: null,
  subtitleMatches: [], subtitleIndex: -1,
  preferredAudioLang: "en",
  search: "",
  playToken: 0, looseCount: 0,
};

const $ = (s) => document.querySelector(s);
const els = {
  grantSection: $("#grantSection"), grantBtn: $("#grantBtn"), playerSection: $("#playerSection"),
  scanningSection: $("#scanningSection"), scanningStatus: $("#scanningStatus"),
  vpStage: $("#vpStage"), vpEmptyStage: $("#vpEmptyStage"), video: $("#vpVideo"),
  warning: $("#vpWarning"), warningText: $("#vpWarningText"),
  title: $("#vpTitle"), sub: $("#vpSub"),
  prevBtn: $("#vpPrevBtn"), playBtn: $("#vpPlayBtn"), playIcon: $("#vpPlayIcon"), nextBtn: $("#vpNextBtn"),
  seek: $("#vpSeek"), cur: $("#vpCur"), total: $("#vpTotal"),
  videoList: $("#videoList"), m4aList: $("#m4aList"), videoLabel: $("#videoLabel"), m4aLabel: $("#m4aLabel"),
  searchWrap: $("#vpSearchWrap"), searchInput: $("#vpSearchInput"), searchClear: $("#vpSearchClear"),
  backBtn: $("#backBtn"), fullscreenBtn: $("#fullscreenBtn"), folderFallback: $("#vpFolderFallback"),
  ccBtn: $("#ccBtn"), ccModalOverlay: $("#ccModalOverlay"), ccList: $("#ccList"),
  ccLoadFileRow: $("#ccLoadFileRow"), ccCloseBtn: $("#ccCloseBtn"), subtitleFileInput: $("#vpSubtitleFile"),
  audBtn: $("#audBtn"), audModalOverlay: $("#audModalOverlay"), audList: $("#audList"), audCloseBtn: $("#audCloseBtn"),
  toast: $("#toast"),
  osd: $("#vpOsd"),
  kbBtn: $("#kbBtn"), kbModalOverlay: $("#kbModalOverlay"), kbCloseBtn: $("#kbCloseBtn"),
  eqBtn: $("#eqBtn"),
};

/* Equalizer — same panel and saved settings as the music player. "lazy" = the video element is only
   routed through Web Audio once the EQ is actually engaged (from a tap), so people who never touch it
   get the browser's untouched native playback. */
if (window.VaneEQ && els.video && els.eqBtn) {
  window.VaneEQ.attach(els.video, { lazy: true }).then(() => {
    window.VaneEQ.subscribe((snap) => { els.eqBtn.classList.toggle("eq-on", snap.engaged); els.eqBtn.title = snap.engaged ? "Equalizer — on" : "Equalizer"; });
  });
  els.eqBtn.addEventListener("click", () => window.VaneEQ.toggle(els.eqBtn));
}

function toast(msg) { els.toast.textContent = msg; els.toast.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => els.toast.classList.remove("show"), 2400); }
function fmtTime(sec) { if (!isFinite(sec) || sec < 0) sec = 0; const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function extOf(name) { return (name.split(".").pop() || "").toLowerCase(); }
function baseName(name) { return name.replace(/\.[^./]+$/, "").toLowerCase(); }

els.backBtn.addEventListener("click", () => { window.location.href = "index.html"; });
/* Fullscreen targets the whole stage (not the bare <video>) so the on-screen
   display for volume / seek keeps showing, and the keyboard shortcuts keep
   working, while fullscreen. iPhone Safari only supports video-element
   fullscreen (with its own native controls), so it falls back to that. */
function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function toggleFullscreen() {
  if (!els.video.src) { toast("Pick a video first."); return; }
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
    return;
  }
  const stage = els.vpStage;
  const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (req) { const r = req.call(stage); if (r && r.catch) r.catch(() => toast("Fullscreen not available.")); }
  else if (els.video.webkitEnterFullscreen) els.video.webkitEnterFullscreen();
  else toast("Fullscreen not supported in this browser.");
}
els.fullscreenBtn.addEventListener("click", toggleFullscreen);

/* ---------------------------------------------------------------------
   Folder access / scanning
   --------------------------------------------------------------------- */
async function requestAccess() {
  if (fsApiSupported()) {
    const handle = await pickDirectory().catch(() => null);
    if (!handle) return;
    state.usingFSApi = true;
    await scanHandle(handle);
  } else {
    els.folderFallback.click();
  }
}
els.grantBtn.onclick = requestAccess; // single handler — reassigned on resume, never a second listener

els.folderFallback.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []).filter(f => ALL_EXT.test(f.name));
  if (!files.length) { toast("No video, M4A, or subtitle files found."); return; }
  state.usingFSApi = false;
  showScanning("Reading your folder…");
  const entries = files.map(f => ({ handle: f, path: f.webkitRelativePath || f.name }));
  buildLists(entries);
});

function showScanning(status) {
  els.grantSection.classList.add("hidden");
  els.playerSection.classList.add("hidden");
  els.scanningSection.classList.remove("hidden");
  if (status) els.scanningStatus.textContent = status;
}

async function scanHandle(handle) {
  showScanning("Searching your folder…");
  const entries = await walkDirectory(handle, ALL_EXT, (n) => { if (n % 15 === 0) els.scanningStatus.textContent = `Found ${n} files so far…`; }).catch(() => []);
  els.scanningStatus.textContent = `Cataloguing ${entries.length} file${entries.length === 1 ? "" : "s"}…`;
  buildLists(entries);
}

function buildLists(entries) {
  state.videos = []; state.m4as = []; state.subs = []; state.fileRefs.clear(); state.subRefs.clear();
  entries.forEach((e, i) => {
    const id = "v" + i + "_" + e.path.length;
    const name = e.path.split("/").pop();
    const folder = e.path.slice(0, e.path.length - name.length);
    if (SUB_EXT.test(name)) {
      state.subRefs.set(id, e.handle);
      const parsed = parseSubtitleName(name);
      state.subs.push({ id, name, folder, base: parsed.base, lang: parsed.lang, langCode: parsed.langCode });
    } else {
      state.fileRefs.set(id, e.handle);
      const item = { id, name, folder, ext: extOf(name), base: baseName(name) };
      if (M4A_EXT.test(name)) state.m4as.push(item); else state.videos.push(item);
    }
  });
  els.grantSection.classList.add("hidden");
  els.scanningSection.classList.add("hidden");
  els.playerSection.classList.remove("hidden");
  render();
}

function rowHtml(item, kind) {
  return `<div class="vp-row" data-id="${item.id}" data-kind="${kind}">
    <div class="thumb">${kind === "video"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 9l5-3v12l-5-3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>'}</div>
    <div class="name">${escapeHtml(item.name)}</div>
    <span class="kind">${kind === "video" ? item.ext.toUpperCase() : "M4A"}</span>
  </div>`;
}

function matchesSearch(item) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return item.name.toLowerCase().includes(q);
}

function render() {
  const q = state.search.trim();
  const filteredVideos = state.videos.filter(matchesSearch);
  const filteredM4as = state.m4as.filter(matchesSearch);

  els.videoLabel.textContent = q ? `Video Files (${filteredVideos.length} of ${state.videos.length})` : `Video Files (${state.videos.length})`;
  els.m4aLabel.textContent = q ? `M4A Files (${filteredM4as.length} of ${state.m4as.length})` : `M4A Files (${state.m4as.length})`;

  els.videoList.innerHTML = filteredVideos.length
    ? filteredVideos.map(v => rowHtml(v, "video")).join("")
    : `<div class="vp-no-results">${q ? "No video files match your search." : "No video files found."}</div>`;
  els.m4aList.innerHTML = filteredM4as.length
    ? filteredM4as.map(v => rowHtml(v, "m4a")).join("")
    : `<div class="vp-no-results">${q ? "No M4A files match your search." : "No M4A files found."}</div>`;

  [...els.videoList.querySelectorAll(".vp-row"), ...els.m4aList.querySelectorAll(".vp-row")].forEach(row => {
    row.classList.toggle("active", state.queue[state.queueIndex] === row.dataset.id);
  });
}

async function getFile(id) {
  const ref = state.fileRefs.get(id);
  if (!ref) return null;
  if (state.usingFSApi && ref.getFile) return await ref.getFile();
  return ref;
}
async function getSubFile(id) {
  const ref = state.subRefs.get(id);
  if (!ref) return null;
  if (state.usingFSApi && ref.getFile) return await ref.getFile();
  return ref;
}

/* ---------------------------------------------------------------------
   Playback
   --------------------------------------------------------------------- */
function warn(msg) { els.warning.classList.remove("hidden"); els.warningText.innerHTML = msg; }
function clearWarn() { els.warning.classList.add("hidden"); els.warningText.innerHTML = ""; }

async function playId(id) {
  const all = [...state.videos, ...state.m4as];
  state.queue = all.map(i => i.id);
  state.queueIndex = state.queue.indexOf(id);
  const item = all.find(i => i.id === id);
  state.currentItem = item;
  clearWarn();
  clearSubtitle();

  const rawFile = await getFile(id);
  if (!rawFile) { toast("Couldn't read that file."); return; }
  resume.begin(rawFile, item); // remembers/restores the playback position for this file
  const myTok = ++state.playToken;
  compat.reset();              // a conversion still running for the previous file is cancelled
  // Look inside the file, not just at its name: a wrong/missing extension no longer matters,
  // and non-video files that merely share an extension (.ts = TypeScript) are caught here.
  let sniffed = null;
  try { sniffed = await F.sniff(rawFile); } catch (e) { /* unreadable header — fall back to the name */ }
  if (myTok !== state.playToken) return;       // the person already picked something else
  if (sniffed && /^(image|text|other)$/.test(sniffed.kind)) {
    toast(`“${item.name}” doesn't look like a video (${sniffed.label.toLowerCase()}).`, 3200); return;
  }
  const effExt = F.effectiveExt(item.ext, sniffed);
  if (sniffed && sniffed.kind === "video") item.container = sniffed.label;
  // Re-wrap with the correct MIME type — this is the key fix for MKV and
  // other extensions browsers/OSes frequently fail to auto-detect.
  const mime = MIME_BY_EXT[effExt] || rawFile.type || "";
  els.title.textContent = item.name;
  els.sub.textContent = (M4A_EXT.test(item.name) ? "Audio (M4A)" : "Video") + (item.container ? " · " + item.container : "");

  // Containers no browser demuxes (AVI, WMV, FLV, MPEG-TS/PS, RealMedia, DV, MXF …):
  // skip the doomed native attempt and go straight to the on-device converter.
  if (F.neverNative(effExt) && mime && els.video.canPlayType(mime) === "" && VC && VC.supported()) {
    stopCurrentPlayback();
    render();
    autoLoadSiblingSubtitle(item);
    compat.tried.add(item.id);
    startCompat(item, rawFile, { why: `.${effExt.toUpperCase()} isn't a format this browser can play directly` });
    return;
  }
  const typedBlob = mime && rawFile.type !== mime ? rawFile.slice(0, rawFile.size, mime) : rawFile;

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(typedBlob);

  els.vpEmptyStage.classList.add("hidden");
  els.video.classList.remove("hidden");

  // Warn up front if the browser has no chance at all with this container/type.
  if (mime && els.video.canPlayType(mime) === "" && !(VC && VC.supported())) {
    warn(`<strong>Heads up:</strong> your browser reports no support at all for <strong>.${item.ext.toUpperCase()}</strong> files. Playback may fail outright — try Chrome/Edge/Firefox, or convert the file.`);
  }

  els.video.src = state.objectUrl;
  resetBufferedUI(); // otherwise the new file starts with the PREVIOUS one's loaded-so-far band still showing
  els.video.load();
  els.video.play().catch(() => {});
  render();

  // After metadata loads, detect the classic "video track unsupported,
  // audio plays fine" case directly from the decoded dimensions.
  els.video.addEventListener("loadedmetadata", function checkVideoTrack() {
    els.video.removeEventListener("loadedmetadata", checkVideoTrack);
    const looksLikeAudioOnly = M4A_EXT.test(item.name);
    if (!looksLikeAudioOnly && els.video.videoWidth === 0 && els.video.videoHeight === 0 && els.video.duration > 0) {
      if (!tryCompat(item, "the video track can't be decoded by this browser", { videoFailed: true }))
        warn(`<strong>Audio only:</strong> the video track in this ${item.ext.toUpperCase()} couldn't be decoded — likely an unsupported codec (HEVC/H.265 is the most common culprit in Matroska/MKV files). Audio will keep playing. For full video, try VLC, or re-encode with H.264/VP9 video.`);
    }
    handleAudioTracks();
  }, { once: true });

  autoLoadSiblingSubtitle(item);
}

/* ---------------------------------------------------------------------
   Multi-language audio tracks — native HTMLMediaElement.audioTracks.
   Supported by Chrome/Edge/Opera for local files with multiple embedded
   audio streams (common for dubbed MKV/MP4 rips); Firefox/Safari don't
   expose it, so this quietly does nothing there rather than break.
   Default preference: switch to English automatically when more than one
   audio track is present and English isn't already the active one, and
   tell the person that happened (with a one-tap way to undo it).
   --------------------------------------------------------------------- */
function handleAudioTracks() {
  const tracks = els.video.audioTracks;
  if (!tracks || tracks.length <= 1) { els.audBtn.classList.add("hidden"); return; }
  els.audBtn.classList.remove("hidden");

  const isEnglish = (t) => /^en\b/i.test(t.language || "") || /english/i.test(t.label || "");
  let currentIdx = 0, englishIdx = -1;
  for (let i = 0; i < tracks.length; i++) { if (tracks[i].enabled) currentIdx = i; if (isEnglish(tracks[i])) englishIdx = i; }

  if (englishIdx !== -1 && englishIdx !== currentIdx) {
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = (i === englishIdx);
    toast(`Switched to English audio (${tracks.length} tracks found) — tap AUD to change`);
  } else if (englishIdx === -1) {
    toast(`${tracks.length} audio tracks found — tap AUD to choose a language`);
  }
}
function audioTrackLabel(t, i) {
  if (t.label) return t.label;
  if (t.language) return (LANGUAGE_ALIASES[t.language.toLowerCase()] || t.language.toUpperCase());
  return `Track ${i + 1}`;
}
function openAudModal() {
  const tracks = els.video.audioTracks;
  if (!tracks || !tracks.length) { els.audModalOverlay.classList.remove("open"); return; }
  const rows = [];
  for (let i = 0; i < tracks.length; i++) {
    rows.push(`<div class="cc-row ${tracks[i].enabled ? "active" : ""}" data-aud-idx="${i}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/></svg>
      ${escapeHtml(audioTrackLabel(tracks[i], i))}</div>`);
  }
  els.audList.innerHTML = rows.join("");
  els.audModalOverlay.classList.add("open");
}
els.audBtn.addEventListener("click", openAudModal);
els.audCloseBtn.addEventListener("click", () => els.audModalOverlay.classList.remove("open"));
els.audModalOverlay.addEventListener("click", (e) => { if (e.target === els.audModalOverlay) els.audModalOverlay.classList.remove("open"); });
els.audList.addEventListener("click", (e) => {
  const row = e.target.closest("[data-aud-idx]");
  if (!row) return;
  const tracks = els.video.audioTracks;
  const idx = Number(row.dataset.audIdx);
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = (i === idx);
  toast(`Audio: ${audioTrackLabel(tracks[idx], idx)}`);
  els.audModalOverlay.classList.remove("open");
});

function togglePlay() { if (!els.video.src) return; if (els.video.paused) els.video.play(); else els.video.pause(); }
function next() { if (!state.queue.length) return; let i = state.queueIndex + 1; if (i >= state.queue.length) i = 0; playId(state.queue[i]); }
function prev() { if (!state.queue.length) return; let i = state.queueIndex - 1; if (i < 0) i = state.queue.length - 1; playId(state.queue[i]); }

els.playBtn.addEventListener("click", togglePlay);
els.nextBtn.addEventListener("click", next);
els.prevBtn.addEventListener("click", prev);
els.video.addEventListener("play", () => { els.playIcon.innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'; });
els.video.addEventListener("pause", () => { els.playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>'; });
els.video.addEventListener("ended", () => {
  // A short preview reaching its end is NOT the end of the video: hold here until the full conversion swaps in.
  if (compat.previewing) { showOsd("⏳ Preview over — full video almost ready"); return; }
  next();
});
els.video.addEventListener("error", () => {
  const err = els.video.error;
  const codes = { 1: "loading was aborted", 2: "a network error occurred", 3: "the file is corrupt or uses an unsupported codec", 4: "this format/codec isn't supported by your browser" };
  if (!compat.playingConverted && err && (err.code === 3 || err.code === 4) && tryCompat(state.currentItem, "the browser couldn't decode it", { videoFailed: true })) return;
  warn(`<strong>Playback error:</strong> ${err ? (codes[err.code] || "playback failed") : "playback failed"}. ${compat.playingConverted ? "Even the converted copy failed — " : ""}Try VLC for full compatibility with unusual codecs.`);
});
els.video.addEventListener("timeupdate", () => {
  if (!els.video.duration) return;
  els.seek.value = (els.video.currentTime / els.video.duration) * 100;
  els.cur.textContent = fmtTime(els.video.currentTime);
  els.total.textContent = fmtTime(els.video.duration);
  updateSeekBuffered(); // cheap enough per tick, and keeps the buffered band live even on browsers that fire "progress" only sparsely
});
els.seek.addEventListener("input", () => { if (els.video.duration) els.video.currentTime = (els.seek.value / 100) * els.video.duration; });

/* ---------------------------------------------------------------------
   Buffered/loading indicator — same idea as the music player's
   .seek-buffered (see app.js), adapted for this page's native
   <input type=range> scrubber: two CSS custom properties, --play-pct
   and --buf-pct, drive the .vp-seek gradient in style.css, so one bar
   shows both how far playback has reached (solid --accent) AND how
   much of the file has actually finished loading (softer --accent-dim)
   at once, instead of the old flat "it's all here" assumption.
   --------------------------------------------------------------------- */
/** Reads els.video.buffered (a list of disjoint loaded time ranges — a
 *  seek can leave a gap between what was already loaded and what's
 *  loading now) and pushes both the playback and buffered percentages
 *  onto the scrub bar's CSS variables. Also toggles .fully-loaded for a
 *  small settle-glow once the whole file has actually finished loading. */
function updateSeekBuffered() {
  if (!els.video.duration || !isFinite(els.video.duration)) return;
  const playPct = (els.video.currentTime / els.video.duration) * 100;
  const ranges = els.video.buffered;
  let end = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (els.video.currentTime >= ranges.start(i) && els.video.currentTime <= ranges.end(i)) { end = ranges.end(i); break; }
    end = Math.max(end, ranges.end(i));
  }
  const bufPct = Math.min(100, (end / els.video.duration) * 100);
  els.seek.style.setProperty("--play-pct", playPct + "%");
  els.seek.style.setProperty("--buf-pct", Math.max(playPct, bufPct) + "%"); // never let rounding show the loaded band trailing behind the playhead
  els.seek.classList.toggle("fully-loaded", bufPct >= 99.9);
}
/** Called right after a new src is assigned, so the scrubber doesn't
 *  keep showing the PREVIOUS file's loaded-so-far band for the instant
 *  before the new file's first progress/loadedmetadata event corrects it. */
function resetBufferedUI() {
  els.seek.style.setProperty("--play-pct", "0%");
  els.seek.style.setProperty("--buf-pct", "0%");
  els.seek.classList.remove("fully-loaded");
}
els.video.addEventListener("progress", updateSeekBuffered);
els.video.addEventListener("loadedmetadata", updateSeekBuffered);
els.video.addEventListener("canplaythrough", updateSeekBuffered); // browsers that report one late "fully buffered" range rather than incremental ticks still land on an accurate final state

[els.videoList, els.m4aList].forEach(list => list.addEventListener("click", (e) => {
  const row = e.target.closest(".vp-row");
  if (row) playId(row.dataset.id);
}));

/* ---------------------------------------------------------------------
   Search — filters both the Video Files and M4A Files lists live.
   --------------------------------------------------------------------- */
els.searchInput.addEventListener("input", () => {
  state.search = els.searchInput.value;
  els.searchWrap.classList.toggle("has-text", !!state.search);
  render();
});
els.searchClear.addEventListener("click", () => {
  state.search = ""; els.searchInput.value = "";
  els.searchWrap.classList.remove("has-text");
  render();
  els.searchInput.focus();
});
window.addEventListener("keydown", (e) => {
  // "/" focuses search, like most list-heavy web apps — but never steal it
  // from an input the person is already typing in.
  const tag = (e.target && e.target.tagName) || "";
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); els.searchInput.focus(); }
  else if (e.key === "Escape" && document.activeElement === els.searchInput && state.search) {
    state.search = ""; els.searchInput.value = ""; els.searchWrap.classList.remove("has-text"); render();
  }
});

/* ---------------------------------------------------------------------
   Subtitles — WebVTT via <track>, the one subtitle format every browser
   supports natively with no dependencies. SRT is auto-converted.
   --------------------------------------------------------------------- */
function srtToVtt(text) {
  let body = text.replace(/\r+/g, "").trim();
  // Strip a UTF-8 BOM if present.
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
  body = body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + body + "\n";
}
function looksLikeVtt(text) { return /^\uFEFF?WEBVTT/.test(text.trim()); }

function clearSubtitle() {
  if (state.currentTrackEl) { state.currentTrackEl.remove(); state.currentTrackEl = null; }
  if (state.currentSubUrl) { URL.revokeObjectURL(state.currentSubUrl); state.currentSubUrl = null; }
  els.ccBtn.classList.remove("active-cc");
}

async function applySubtitleFromText(text, label) {
  clearSubtitle();
  const vttText = looksLikeVtt(text) ? text : srtToVtt(text);
  const blob = new Blob([vttText], { type: "text/vtt" });
  const url = URL.createObjectURL(blob);
  const track = document.createElement("track");
  track.kind = "subtitles"; track.label = label || "Subtitles"; track.srclang = "en"; track.default = true;
  track.src = url;
  els.video.appendChild(track);
  state.currentTrackEl = track; state.currentSubUrl = url;
  // Chrome/Firefox need the mode set explicitly after the track loads.
  track.addEventListener("load", () => { if (track.track) track.track.mode = "showing"; });
  setTimeout(() => { if (track.track) track.track.mode = "showing"; }, 150);
  els.ccBtn.classList.add("active-cc");
}

function findSiblingSubtitles(item) {
  const matches = state.subs.filter(s => s.folder === item.folder && s.base === item.base);
  // English first (if present), then other named languages alphabetically, then unlabeled tracks last.
  return matches.sort((a, b) => {
    if (a.lang === "English") return -1;
    if (b.lang === "English") return 1;
    if (a.lang && b.lang) return a.lang.localeCompare(b.lang);
    if (a.lang) return -1;
    if (b.lang) return 1;
    return a.name.localeCompare(b.name);
  });
}
function subtitleLabel(m) { return m.lang ? m.lang : m.name; }

async function autoLoadSiblingSubtitle(item) {
  state.subtitleMatches = findSiblingSubtitles(item);
  state.subtitleIndex = -1; // -1 = off
  if (!state.subtitleMatches.length) return;
  await selectSubtitleByIndex(0, true);
}

async function selectSubtitleByIndex(idx, silent) {
  const matches = state.subtitleMatches || [];
  if (idx < 0 || idx >= matches.length) {
    clearSubtitle();
    state.subtitleIndex = -1;
    if (!silent) toast("Subtitles: Off");
    return;
  }
  const m = matches[idx];
  const file = await getSubFile(m.id);
  if (!file) { toast("Couldn't read that subtitle file."); return; }
  const text = await file.text();
  await applySubtitleFromText(text, subtitleLabel(m));
  state.subtitleIndex = idx;
  if (!silent) toast(`Subtitles: ${subtitleLabel(m)}`);
}

/** VLC-style "V" key — cycles Off → each detected language → Off. */
function cycleSubtitleTrack() {
  const matches = state.subtitleMatches || [];
  if (!matches.length) { toast("No subtitles detected for this video."); return; }
  const next = (state.subtitleIndex + 1 >= matches.length) ? -1 : state.subtitleIndex + 1;
  selectSubtitleByIndex(next, false);
}

/* CC picker modal — shows every auto-detected language, click to display it immediately */
function openCcModal() {
  const matches = state.subtitleMatches || [];
  const rows = [];
  rows.push(`<div class="cc-row ${state.subtitleIndex === -1 ? "active" : ""}" data-action="off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg> Off</div>`);
  matches.forEach((m, i) => rows.push(`<div class="cc-row ${state.subtitleIndex === i ? "active" : ""}" data-sub-idx="${i}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/></svg>
    ${escapeHtml(subtitleLabel(m))} ${m.lang ? `<span class="src-tag">${escapeHtml(m.name)}</span>` : `<span class="src-tag">detected</span>`}</div>`));
  if (!matches.length) rows.push(`<div class="cc-row" style="color:var(--text-muted);cursor:default;">No subtitles auto-detected for this video</div>`);
  els.ccList.innerHTML = rows.join("");
  els.ccModalOverlay.classList.add("open");
}
els.ccBtn.addEventListener("click", openCcModal);
els.ccCloseBtn.addEventListener("click", () => els.ccModalOverlay.classList.remove("open"));
els.ccModalOverlay.addEventListener("click", (e) => { if (e.target === els.ccModalOverlay) els.ccModalOverlay.classList.remove("open"); });
els.ccList.addEventListener("click", async (e) => {
  const off = e.target.closest('[data-action="off"]');
  if (off) { await selectSubtitleByIndex(-1, true); els.ccModalOverlay.classList.remove("open"); return; }
  const row = e.target.closest("[data-sub-idx]");
  if (row) { await selectSubtitleByIndex(Number(row.dataset.subIdx), true); els.ccModalOverlay.classList.remove("open"); }
});
els.ccLoadFileRow.addEventListener("click", () => { els.ccModalOverlay.classList.remove("open"); els.subtitleFileInput.click(); });
els.subtitleFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!SUB_EXT.test(file.name)) { toast("Please choose a .srt or .vtt file."); return; }
  const text = await file.text();
  await applySubtitleFromText(text, file.name);
  toast(`Loaded subtitles: ${file.name}`);
  e.target.value = "";
});

/* ---------------------------------------------------------------------
   Volume control — one controller drives the slider, the mute button and
   the keyboard shortcuts. Remembered between visits (not the mute flag),
   separately from the music player's volume.
   --------------------------------------------------------------------- */
const volume = createVolumeController(els.video, { storageKey: "volume-video", step: 5 });
const volUI = { slider: $("#vpVolSlider"), button: $("#vpMuteBtn"), icon: $("#vpVolIcon"), value: $("#vpVolValue"), row: $("#vpVolumeRow") };
volume.subscribe((v) => {
  volUI.slider.value = v.level;
  volUI.slider.style.setProperty("--vol-pct", v.level + "%");
  volUI.slider.setAttribute("aria-valuetext", v.muted ? "Muted" : v.volume + " percent");
  volUI.icon.innerHTML = volumeIconMarkup(v.level);
  volUI.button.classList.toggle("muted", v.level === 0);
  volUI.value.textContent = v.muted ? "Muted" : v.volume + "%";
  volUI.row.classList.toggle("no-volume-slider", !v.supported);
});
volUI.slider.addEventListener("input", () => volume.set(Number(volUI.slider.value)));
volUI.button.addEventListener("click", () => volume.toggleMute());

/** Small on-screen display inside the stage — visible in fullscreen too,
 *  where the page's toast and sliders are not. */
function showOsd(text, barPct) {
  els.osd.innerHTML = `<span>${text}</span>` + (barPct == null ? "" : `<span class="osd-bar"><i style="width:${barPct}%"></i></span>`);
  els.osd.classList.add("show");
  clearTimeout(showOsd._t);
  showOsd._t = setTimeout(() => els.osd.classList.remove("show"), 1100);
}
function showVolumeOsd() {
  const v = volume.state;
  showOsd(v.level === 0 ? (v.muted ? "🔇 Muted" : "🔇 Volume 0%") : `🔊 Volume ${v.volume}%`, v.level);
}

/* ---------------------------------------------------------------------
   Keyboard shortcuts — this map is what the ⌨ Shortcuts panel shows
   (catalog: SHORTCUTS.video in shared.js). Keep the two in sync.
     Space          play / pause          M   mute / unmute
     Shift + ↑ / ↓  volume ±5%            F   fullscreen on / off
     ← / →          seek ∓5s              V   cycle subtitle language
     Shift + ← / →  previous / next video       S   save a snapshot of the current frame
   Plain arrows are not used for volume because they scroll the file list.
   --------------------------------------------------------------------- */
function isTypingTarget(t) {
  if (!(t instanceof window.Element)) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName !== "INPUT") return false;
  return !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"].includes((t.type || "").toLowerCase());
}
function closeShortcutsPanel() { els.kbModalOverlay.classList.remove("open"); }
els.kbBtn.addEventListener("click", () => els.kbModalOverlay.classList.add("open"));
els.kbCloseBtn.addEventListener("click", closeShortcutsPanel);
els.kbModalOverlay.addEventListener("click", (e) => { if (e.target === els.kbModalOverlay) closeShortcutsPanel(); });
renderShortcutList($("#shortcutList"), "video", $("#shortcutNote"));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.kbModalOverlay.classList.contains("open")) { closeShortcutsPanel(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return; // never steal browser/OS combos
  const t = e.target;
  if (isTypingTarget(t)) return;
  const key = e.key;
  const isRange = t instanceof window.Element && t.tagName === "INPUT" && t.type === "range";
  const isVolSlider = isRange && t.classList.contains("vol-slider");
  const hasMedia = !!els.video.src;

  // Space — the app-wide play/pause toggle, unconditionally, same as the
  // music player: it works no matter what's focused (a button, a link, a
  // row) or what state the page is in. isTypingTarget above is the only
  // carve-out. togglePlay() already no-ops safely if nothing's loaded
  // yet, so this doesn't need its own "no media" guard either — Space
  // just does nothing rather than sometimes toggling, sometimes scrolling.
  if (e.code === "Space") {
    if (e.repeat) return;
    e.preventDefault(); togglePlay();
    return;
  }

  if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
    if (isRange && !(isVolSlider && e.shiftKey && (key === "ArrowUp" || key === "ArrowDown"))) return; // sliders keep their own arrow keys
    if (modalOpen()) return;
    if (e.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
      e.preventDefault();
      if (!volume.supported) { toast("Volume is controlled by your device's buttons in this browser."); return; }
      volume.nudge(key === "ArrowUp" ? 1 : -1);
      showVolumeOsd();
    } else if (e.shiftKey && key === "ArrowRight") { if (!e.repeat) { e.preventDefault(); next(); } }
    else if (e.shiftKey && key === "ArrowLeft") { if (!e.repeat) { e.preventDefault(); prev(); } }
    else if (!e.shiftKey) {
      if (!hasMedia || !isFinite(els.video.duration)) return;
      e.preventDefault();
      const d = key === "ArrowRight" ? 5 : -5;
      els.video.currentTime = Math.max(0, Math.min(els.video.duration, els.video.currentTime + d));
      showOsd(`${d > 0 ? "⏩ +5s" : "⏪ −5s"} · ${fmtTime(els.video.currentTime)}`);
    }
    return;
  }

  if (e.shiftKey || e.repeat) return;
  // Arrow keys already back off while the Shortcuts panel is open (above);
  // the letter shortcuts need the same guard so "f"/"v"/"m"/"e" can't fire
  // on the player underneath while that panel is the thing on screen.
  if (modalOpen()) return;
  const k = key.toLowerCase();
  if (k === "m") { e.preventDefault(); volume.toggleMute(); showVolumeOsd(); }
  else if (k === "f") { e.preventDefault(); toggleFullscreen(); }
  else if (k === "v") { e.preventDefault(); cycleSubtitleTrack(); }
  else if (k === "e") { e.preventDefault(); window.VaneEQ && window.VaneEQ.toggle(els.eqBtn); }
  else if (k === "s") { e.preventDefault(); takeSnapshot(); }
});

/* ---------------------------------------------------------------------
   Stage extras — five additions, each wrapped so a failure in one can
   never take playback down with it:
     1. Tap / click the picture  → play / pause (with a flash icon)
     2. Double-tap left / right  → −10s / +10s (keeps chaining: tap tap tap = ±30s)
        Double-tap centre or double-click anywhere → fullscreen
     3. Press & hold             → 2× speed while held, snaps back on release
     4. Resume where you left off (remembered per file, on this device only)
     5. Snapshot                 → saves the current frame as a PNG  (S key / camera button)
   --------------------------------------------------------------------- */
function safely(name, fn) {
  return function () {
    try { return fn.apply(this, arguments); }
    catch (err) { console.warn("[Video extras] " + name + " failed:", err); }
  };
}
function stageHasPicture() { return !!els.video.src && !els.video.classList.contains("hidden"); }
function makeEl(cls, html) { const d = document.createElement("div"); d.className = cls; if (html != null) d.innerHTML = html; return d; }

/* ---- shared little visuals: flash icon, ±seconds ripple, boost badge ---- */
const ICON_PLAY  = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
function flash(kind, html) {               // kind: "center" | "left" | "right"
  const old = els.vpStage.querySelectorAll(".vp-flash." + kind);
  old.forEach(n => n.remove());            // never stack the same flash on itself
  const el = makeEl("vp-flash " + kind, html);
  els.vpStage.appendChild(el);
  setTimeout(() => el.remove(), 750);
}
const boostBadge = makeEl("vp-boost", "⏩ <b>2×</b> speed");
els.vpStage.appendChild(boostBadge);

/* ---- 1 + 2 + 3 : tap, double-tap, hold ---- */
const gesture = (() => {
  const DOUBLE_MS = 250, HOLD_MS = 420, TAP_MAX_MS = 380, SLOP = 12, SKIP = 10, BOOST = 2;
  let down = null, holdTimer = null, singleTimer = null;
  let lastTap = { t: 0, zone: "" };
  let boosted = false, prevRate = 1;
  let skipAcc = 0, skipAccTimer = null, lastType = "mouse";

  function eligible(e) {
    if (!e.isPrimary) return false;                                  // ignore the 2nd finger of a pinch
    if (e.pointerType === "mouse" && e.button !== 0) return false;  // left button only
    if (e.target && e.target.closest && e.target.closest(".vp-pill, .vp-convert")) return false;
    return stageHasPicture();
  }
  function zoneOf(e) {
    const r = els.vpStage.getBoundingClientRect();
    if (!r.width) return "center";
    const x = (e.clientX - r.left) / r.width;
    return x < 0.33 ? "left" : x > 0.67 ? "right" : "center";
  }

  function tapToggle() {
    const v = els.video; if (!stageHasPicture()) return;
    if (v.paused || v.ended) { const p = v.play(); if (p && p.catch) p.catch(() => {}); flash("center", ICON_PLAY); }
    else { v.pause(); flash("center", ICON_PAUSE); }
  }
  function skip(dir) {
    const v = els.video;
    if (!isFinite(v.duration) || v.duration <= 0) return;
    const goingRight = dir > 0;
    if (skipAcc !== 0 && (skipAcc > 0) !== goingRight) skipAcc = 0;   // direction changed → restart the tally
    skipAcc += dir * SKIP;
    clearTimeout(skipAccTimer); skipAccTimer = setTimeout(() => { skipAcc = 0; }, 800);
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + dir * SKIP));
    flash(goingRight ? "right" : "left", `<span>${goingRight ? "⏩" : "⏪"}</span><span>${skipAcc > 0 ? "+" : "−"}${Math.abs(skipAcc)}s</span>`);
  }

  function registerTap(e, type) {
    const now = performance.now();
    const zone = type === "mouse" ? "any" : zoneOf(e);
    const isSecond = lastTap.t && (now - lastTap.t) < DOUBLE_MS && lastTap.zone === zone;
    clearTimeout(singleTimer);
    if (isSecond) {
      if (zone === "left")  { skip(-1); lastTap = { t: now, zone }; }          // chain: a 3rd, 4th tap keeps skipping
      else if (zone === "right") { skip(1); lastTap = { t: now, zone }; }
      else { lastTap = { t: 0, zone: "" }; toggleFullscreen(); }               // centre tap-tap / mouse double-click
    } else {
      lastTap = { t: now, zone };
      singleTimer = setTimeout(safely("tap", () => { lastTap = { t: 0, zone: "" }; tapToggle(); }), DOUBLE_MS);
    }
  }

  function startBoost() {
    const v = els.video;
    if (!down || down.moved || boosted || !stageHasPicture() || v.paused || v.ended) return;
    prevRate = v.playbackRate || 1;
    try { v.playbackRate = BOOST; } catch (e) { return; }
    boosted = true; down.held = true;
    clearTimeout(singleTimer); lastTap = { t: 0, zone: "" };
    const pill = els.vpStage.querySelector(".vp-pill"); if (pill) pill.remove();
    boostBadge.classList.add("show");
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* cosmetic */ }
  }
  function endBoost() {
    if (!boosted) return;
    boosted = false;
    try { els.video.playbackRate = prevRate || 1; } catch (e) { /* element gone */ }
    boostBadge.classList.remove("show");
  }
  function cleanupPointer() {
    clearTimeout(holdTimer);
    if (down) { try { els.vpStage.releasePointerCapture(down.id); } catch (e) { /* not captured */ } }
    down = null;
  }

  els.vpStage.addEventListener("pointerdown", safely("down", (e) => {
    if (!eligible(e)) return;
    lastType = e.pointerType || "mouse";
    cleanupPointer(); endBoost();
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), type: lastType, moved: false, held: false };
    try { els.vpStage.setPointerCapture(e.pointerId); } catch (err) { /* fine without it */ }
    holdTimer = setTimeout(safely("hold", startBoost), HOLD_MS);
  }));
  els.vpStage.addEventListener("pointermove", safely("move", (e) => {
    if (!down || e.pointerId !== down.id || down.moved) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > SLOP) { down.moved = true; if (!boosted) clearTimeout(holdTimer); }
  }));
  els.vpStage.addEventListener("pointerup", safely("up", (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down, wasBoosted = boosted;
    cleanupPointer();
    if (wasBoosted) { endBoost(); return; }                          // a hold is never also a tap
    if (d.moved || (performance.now() - d.t) > TAP_MAX_MS) return;  // drag / long press that didn't boost
    registerTap(e, d.type);
  }));
  const abort = safely("abort", () => { cleanupPointer(); endBoost(); });
  els.vpStage.addEventListener("pointercancel", abort);
  // Anything that could leave 2× stuck on: tab hidden, window blur, new file, pause, page leaving.
  window.addEventListener("blur", abort);
  window.addEventListener("pagehide", abort);
  document.addEventListener("visibilitychange", () => { if (document.hidden) abort(); });
  ["emptied", "pause", "ended", "error"].forEach(ev => els.video.addEventListener(ev, safely("boost-reset", endBoost)));
  // Long-press on touch screens otherwise opens the browser's "save video" menu.
  els.vpStage.addEventListener("contextmenu", (e) => { if (down || boosted || lastType !== "mouse") e.preventDefault(); });
  // Safety net: the stage's own double-click (mouse) must not also trigger the browser's default text selection.
  els.vpStage.addEventListener("mousedown", (e) => { if (e.detail > 1 && stageHasPicture()) e.preventDefault(); });
})();

/* ---- 4 : resume where you left off ---- */
const resume = (() => {
  const KEY = "vane.video.resume.v1", MAX_ENTRIES = 80, MIN_LEN = 30, EDGE = 10;
  let key = null, pending = null, armed = false, lastWrite = 0, pillTimer = null, held = false;

  function readAll() {
    try { const o = JSON.parse(localStorage.getItem(KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
    catch (e) { return {}; }
  }
  function writeAll(o) {
    try {
      const ks = Object.keys(o);
      if (ks.length > MAX_ENTRIES) ks.sort((a, b) => (o[a].ts || 0) - (o[b].ts || 0)).slice(0, ks.length - MAX_ENTRIES).forEach(k => delete o[k]);
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch (e) { /* storage full or blocked — resume just won't be remembered */ }
  }
  function hidePill() { clearTimeout(pillTimer); const p = els.vpStage.querySelector(".vp-pill"); if (p) p.remove(); }
  function showPill(t) {
    hidePill();
    const pill = makeEl("vp-pill");
    const label = document.createElement("span"); label.textContent = "↩ Resumed at " + fmtTime(t);
    const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Start over";
    btn.addEventListener("click", safely("startover", () => { els.video.currentTime = 0; clearEntry(); hidePill(); showOsd("⏮ From the start"); }));
    pill.append(label, btn);
    els.vpStage.appendChild(pill);
    pillTimer = setTimeout(hidePill, 8000);
  }
  function clearEntry() { if (!key) return; const o = readAll(); if (o[key]) { delete o[key]; writeAll(o); } }

  return {
    /** Called from playId() once the file is known (before the new src is assigned). */
    begin: safely("resume.begin", (file, item) => {
      hidePill();
      armed = false; held = false; lastWrite = 0;
      key = [(item && item.name) || file.name, file.size, file.lastModified || 0].join("|");
      pending = readAll()[key] || null;
    }),
    /** loadedmetadata: jump to the remembered spot (if it still makes sense), then start recording. */
    onMetadata: safely("resume.meta", () => {
      const v = els.video, dur = v.duration;
      if (!key || held) return;
      if (pending && isFinite(dur) && dur > MIN_LEN && Math.abs((pending.d || 0) - dur) < 3 && pending.t >= 5 && pending.t < dur - EDGE) {
        v.currentTime = pending.t;
        showPill(pending.t);
      }
      pending = null; armed = true;
    }),
    save: safely("resume.save", (force) => {
      const v = els.video, dur = v.duration;
      if (!key || !armed || held || !isFinite(dur) || dur <= MIN_LEN) return;
      const now = Date.now();
      if (!force && now - lastWrite < 4000) return;
      lastWrite = now;
      const t = v.currentTime, o = readAll();
      if (t >= dur - EDGE) { if (o[key]) { delete o[key]; writeAll(o); } return; }   // finished → forget it
      if (t < 5) return;                                                             // barely started → keep any older spot
      o[key] = { t: Math.floor(t), d: Math.round(dur), ts: now };
      writeAll(o);
    }),
    finished: safely("resume.finished", clearEntry),
    /** Pause recording/restoring (a short preview is playing, its length isn't the file's). */
    hold: () => { held = true; armed = false; },
    /** The real video is in place: start recording again, don't jump anywhere. */
    release: () => { held = false; pending = null; armed = true; },
  };
})();
els.video.addEventListener("loadedmetadata", resume.onMetadata);
els.video.addEventListener("timeupdate", () => resume.save(false));
els.video.addEventListener("pause", () => resume.save(true));
els.video.addEventListener("ended", resume.finished);
window.addEventListener("pagehide", () => resume.save(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) resume.save(true); });

/* ---- 5 : snapshot ---- */
const snapBtn = $("#snapBtn");
const takeSnapshot = safely("snapshot", () => {
  const v = els.video;
  if (!stageHasPicture()) { toast("Pick a video first."); return; }
  if (!v.videoWidth || !v.videoHeight || v.readyState < 2) { toast("No picture to capture yet."); return; }
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  let ctx = null;
  try { ctx = c.getContext("2d"); ctx.drawImage(v, 0, 0, c.width, c.height); }
  catch (err) { toast("Snapshot isn't available for this video."); return; }
  const stamp = fmtTime(v.currentTime).replace(":", "m") + "s";
  const base = ((state.currentItem && state.currentItem.name) || "video").replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "video";
  c.toBlob(safely("snapshot-blob", (blob) => {
    c.width = c.height = 0;                                  // hand the big bitmap back right away
    if (!blob) { toast("Couldn't capture that frame."); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${base} @ ${stamp}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const shutter = makeEl("vp-shutter"); els.vpStage.appendChild(shutter); setTimeout(() => shutter.remove(), 400);
    showOsd("📸 Snapshot saved");
  }), "image/png");
});
if (snapBtn) snapBtn.addEventListener("click", takeSnapshot);

/* ---------------------------------------------------------------------
   Universal playback — the "plays anything" layer.
   Route for every file:  sniff real container → native if the browser can
   → otherwise repack / convert on-device (vcompat.js, ffmpeg.wasm).
   Also: "no sound" detection + fix, "Open any file", and a Supported
   Formats panel. Everything here is wrapped so a failure falls back to the
   normal player instead of breaking it.
   --------------------------------------------------------------------- */
function modalOpen() {
  const fm = document.getElementById("fmtModalOverlay");
  return els.kbModalOverlay.classList.contains("open") || !!(fm && fm.classList.contains("open"));
}
function fmtBytes(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(n / 1e6)) + " MB"; }
function sizeLimit() { const mem = navigator.deviceMemory; return Math.min(1.5e9, mem ? mem * 0.25e9 : 1.5e9); }
function modeText(mode) { return mode === "remux" ? "fast repack, no quality loss" : mode === "remux-audio" ? "repack + audio conversion" : "re-encoding video"; }

function stopCurrentPlayback() {
  const v = els.video;
  try { v.pause(); } catch (e) { /* nothing playing */ }
  v.removeAttribute("src");
  try { v.load(); } catch (e) { /* ignore */ }
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  v.classList.add("hidden"); els.vpEmptyStage.classList.remove("hidden");
  resetBufferedUI();
}

/* ---- the progress / ask card that sits on the stage ---- */
const cv = (() => {
  const el = makeEl("vp-convert hidden", '<div class="vc-title"></div><div class="vc-sub"></div><div class="vc-bar"><i></i></div><div class="vc-meta"></div>' +
    '<div class="vc-actions"><button type="button" class="vc-go">Convert &amp; play</button><button type="button" class="vc-cancel">Cancel</button></div>');
  els.vpStage.appendChild(el);
  const q = (s) => el.querySelector(s);
  let goFn = null, cancelFn = null;
  q(".vc-go").addEventListener("click", () => { try { goFn && goFn(); } catch (e) { console.warn(e); } });
  q(".vc-cancel").addEventListener("click", () => { try { cancelFn && cancelFn(); } catch (e) { console.warn(e); } });
  const api = {
    ask(o) { goFn = o.go; cancelFn = o.cancel || api.hide; el.className = "vp-convert ask"; q(".vc-title").textContent = o.title; q(".vc-sub").textContent = o.sub || ""; q(".vc-meta").textContent = ""; q(".vc-cancel").textContent = "Not now"; },
    work(o) { goFn = null; cancelFn = o.cancel; el.className = "vp-convert work"; q(".vc-title").textContent = o.title; q(".vc-sub").textContent = o.sub || ""; q(".vc-meta").textContent = "Starting…"; q(".vc-cancel").textContent = "Cancel"; q(".vc-bar").classList.add("indet"); q(".vc-bar i").style.width = "0%"; },
    status(msg) { q(".vc-meta").textContent = msg; },
    sub(msg) { q(".vc-sub").textContent = msg; },
    progress(pct, elapsed, phase) {
      const bar = q(".vc-bar");
      if (pct == null) bar.classList.add("indet"); else { bar.classList.remove("indet"); q(".vc-bar i").style.width = Math.round(pct * 100) + "%"; }
      const eta = pct && pct > 0.04 ? " · about " + fmtTime(elapsed * (1 - pct) / pct) + " left" : "";
      q(".vc-meta").textContent = (phase === "preview" ? "Quick preview: " : "") + (pct == null ? "working… " + fmtTime(elapsed) : Math.round(pct * 100) + "%" + eta);
      if (el.classList.contains("mini")) q(".vc-title").textContent = "Converting full video… " + (pct == null ? "" : Math.round(pct * 100) + "%");
    },
    mini(on) { el.classList.toggle("mini", !!on); if (on) { q(".vc-title").textContent = "Converting full video…"; q(".vc-sub").textContent = "Preview is playing — it switches to the full video automatically."; } },
    hide() { el.className = "vp-convert hidden"; goFn = cancelFn = null; },
  };
  return api;
})();

/* ---- little action pill (reuses the resume pill's look) ---- */
function actionPill(text, btnLabel, onClick, ms) {
  const old = els.vpStage.querySelector(".vp-pill"); if (old) old.remove();
  const pill = makeEl("vp-pill");
  const label = document.createElement("span"); label.textContent = text;
  const btn = document.createElement("button"); btn.type = "button"; btn.textContent = btnLabel;
  btn.addEventListener("click", () => { pill.remove(); try { onClick(); } catch (e) { console.warn(e); } });
  pill.append(label, btn); els.vpStage.appendChild(pill);
  setTimeout(() => pill.remove(), ms || 9000);
}

/* ---- orchestrator ---- */
const F = window.VVFormats, VC = window.VVCompat;
const compat = {
  token: 0, url: null, playingConverted: false, previewing: false, tried: new Set(), silentT: 0, silentAsked: null,
  reset() {
    this.token++; if (VC && VC.busy()) VC.cancel();
    cv.hide(); this.previewing = false; this.playingConverted = false; this.tried.clear();
    if (this.url) { const u = this.url; this.url = null; setTimeout(() => URL.revokeObjectURL(u), 1500); }
  },
};

function applyConverted(blob, item, o) {
  const v = els.video;
  const wasPlaying = o.keep ? (!v.paused || v.ended) : true;   // a preview that ran out counts as "was playing"
  const t = o.keep ? (o.seekTo != null ? o.seekTo : v.currentTime) : 0;
  const oldConv = compat.url, oldNative = state.objectUrl;
  compat.url = URL.createObjectURL(blob); state.objectUrl = null;
  els.vpEmptyStage.classList.add("hidden"); v.classList.remove("hidden");
  compat.playingConverted = true;
  if (o.hold) resume.hold();
  v.src = compat.url; resetBufferedUI(); v.load();
  v.addEventListener("loadedmetadata", () => {
    try { if (o.keep && t > 0 && isFinite(v.duration)) v.currentTime = Math.min(t, Math.max(0, v.duration - 0.5)); } catch (e) { /* keep going from 0 */ }
    if (o.release) resume.release();
    handleAudioTracks();
  }, { once: true });
  if (wasPlaying) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  setTimeout(() => { if (oldConv) URL.revokeObjectURL(oldConv); if (oldNative) URL.revokeObjectURL(oldNative); }, 4000);
}

async function startCompat(item, rawFile, o) {
  o = o || {};
  const tok = ++compat.token;
  const why = o.why || "this browser can't play it directly";
  if (rawFile.size > sizeLimit() && !o.force) {
    cv.ask({ title: "Large file", sub: `${item.name} is ${fmtBytes(rawFile.size)}. Converting it in the browser needs a lot of memory and may be slow — ${why}.`,
      go: () => startCompat(item, rawFile, Object.assign({}, o, { force: true })) });
    return;
  }
  if (o.audioFix) resume.save(true);
  const startAt = o.audioFix ? els.video.currentTime : 0;
  const cancelNow = () => {
    VC.cancel(); compat.token++; compat.previewing = false;
    if (compat.playingConverted) { cv.hide(); toast("Stopped — the preview keeps playing."); }
    else cv.ask({ title: "Conversion cancelled", sub: item.name, go: () => startCompat(item, rawFile, o) });
  };
  cv.work({ title: o.audioFix ? "Fixing the audio…" : "Making this playable…", sub: why.charAt(0).toUpperCase() + why.slice(1) + ".", cancel: cancelNow });
  let previewShown = false;
  try {
    const res = await VC.prepare(rawFile, {
      status: (m) => { if (tok === compat.token) cv.status(m); },
      info: (info, p) => {
        if (tok !== compat.token) return;
        item.container = (info.container || "").split(",")[0].toUpperCase() || item.container;
        cv.sub(`${item.container} · ${p.label} · ${modeText(p.mode)}`);
      },
      progress: ({ pct, elapsed, phase }) => { if (tok === compat.token) cv.progress(pct, elapsed, phase); },
      preview: async (blob) => {
        if (tok !== compat.token) return;
        previewShown = true; compat.previewing = true;
        applyConverted(blob, item, { keep: false, hold: true });
        cv.mini(true);
        showOsd("▶ Preview — full video converting");
      },
    }, { forceTranscode: !!o.videoFailed, reencodeAudio: !!o.audioFix, noPreview: !!o.audioFix, startAt, audioFix: !!o.audioFix });
    if (tok !== compat.token) return;
    if (!previewShown && !o.audioFix) resume.begin(rawFile, item);     // re-read the saved position; a failed native attempt may have used it up
    applyConverted(res.blob, item, { keep: previewShown || !!o.audioFix, seekTo: (!previewShown && o.audioFix) ? startAt : undefined, release: previewShown || !!o.audioFix });
    compat.previewing = false;
    cv.hide();
    els.sub.textContent = "Video · " + (item.container || "") + " (converted for playback)";
    showOsd(res.plan.mode === "transcode" ? "✓ Converted" : "✓ Repacked");
  } catch (err) {
    if (tok !== compat.token) return;
    compat.previewing = false;
    if (err && err.cancelled) { return; }
    cv.hide();
    if (err && err.benign) { toast(err.message, 3500); return; }
    console.warn("[VVCompat]", err);
    warn(`<strong>Couldn't convert this file:</strong> ${escapeHtml((err && err.message) || String(err))} Try VLC for very unusual codecs.`);
  }
}

/** Starts (or offers) a conversion after the native attempt failed. Returns false if that isn't possible. */
function tryCompat(item, why, opts) {
  opts = opts || {};
  const key = item && (item.id + (opts.audioFix ? ":a" : ""));
  if (!item || !VC || !VC.supported() || compat.playingConverted || compat.tried.has(key)) return false;
  compat.tried.add(key);
  getFile(item.id).then(f => { if (f) startCompat(item, f, Object.assign({ why }, opts)); }).catch(() => {});
  return true;
}

/* ---- "no sound" detector (Chrome / Edge / Safari expose decoded-audio byte counts) ---- */
els.video.addEventListener("playing", () => { clearTimeout(compat.silentT); compat.silentT = setTimeout(safely("silence", checkSilence), 3200); });
function checkSilence() {
  const v = els.video, it = state.currentItem;
  if (!it || !VC || !VC.supported() || compat.playingConverted || v.paused || v.muted || v.volume === 0 || v.currentTime < 2) return;
  if (typeof v.webkitAudioDecodedByteCount !== "number" || v.webkitAudioDecodedByteCount > 0) return;
  if (compat.silentAsked === it.id) return;
  compat.silentAsked = it.id;
  actionPill("🔇 No sound detected", "Check audio", () => tryCompat(it, "its audio format isn't supported here", { audioFix: true }), 10000);
}

/* ---- Open any file (works for files with odd or missing extensions) ---- */
const anyInput = document.getElementById("vpAnyFile");
async function addLooseFiles(list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  let firstId = null, added = 0;
  state.looseCount = state.looseCount || 0;
  for (const f of files) {
    if (SUB_EXT.test(f.name)) continue;
    let ok = VIDEO_EXT.test(f.name) || M4A_EXT.test(f.name);
    if (!ok) { try { const s = await F.sniff(f); ok = s.kind === "video"; } catch (e) { ok = false; } }
    if (!ok) continue;
    const id = "x" + (state.looseCount++) + "_" + f.name.length;
    state.fileRefs.set(id, f);
    const item = { id, name: f.name, folder: "", ext: extOf(f.name) || "file", base: baseName(f.name) };
    (M4A_EXT.test(f.name) ? state.m4as : state.videos).push(item);
    firstId = firstId || id; added++;
  }
  if (!added) { toast("Those don't look like video files."); return; }
  els.grantSection.classList.add("hidden"); els.scanningSection.classList.add("hidden"); els.playerSection.classList.remove("hidden");
  render();
  playId(firstId);
}
["openAnyBtnA", "openAnyBtnB"].forEach(id => { const b = document.getElementById(id); if (b && anyInput) b.addEventListener("click", () => anyInput.click()); });
if (anyInput) anyInput.addEventListener("change", () => { addLooseFiles(anyInput.files).catch(err => console.warn(err)); anyInput.value = ""; });

/* ---- Supported formats panel ---- */
const fmtOverlay = document.getElementById("fmtModalOverlay");
function openFormats() {
  if (!fmtOverlay) return;
  const body = document.getElementById("fmtBody");
  const nativeNow = (mime) => !!mime && els.video.canPlayType(mime) !== "";
  const total = F.count;
  const groupsHtml = F.groups().map(g => `<div class="fmt-group"><div class="fmt-family">${escapeHtml(g.family)}</div><div class="fmt-chips">${
    g.items.map(i => `<span class="fmt-chip ${(!i.never && nativeNow(i.mime)) ? "native" : "conv"}" title="${escapeHtml(i.name)} — ${(!i.never && nativeNow(i.mime)) ? "plays directly in this browser (codec permitting)" : "converted on your device when opened"}">.${escapeHtml(i.ext)}</span>`).join("")}</div></div>`).join("");
  body.innerHTML = `<p class="fmt-lead"><strong>${total} video formats</strong> are recognised. Anything your browser can't play directly is repacked or converted on your device — nothing is uploaded.</p>
    <div class="fmt-legend"><span class="fmt-chip native">plays directly</span><span class="fmt-chip conv">converted on-device</span></div>${groupsHtml}
    <div class="fmt-group"><div class="fmt-family">Codecs the converter can read</div><div class="fmt-note">Video: H.264, HEVC / H.265, VP8, VP9, AV1, MPEG-1/2/4, DivX / Xvid, WMV / VC-1, RealVideo, Sorenson / FLV, Theora, ProRes, DNxHD, MJPEG, Cinepak and more.<br>Audio: AAC, MP3, MP2, AC-3, E-AC-3, DTS, TrueHD, WMA, Vorbis, Opus, FLAC, ALAC, AMR, PCM and more.</div></div>
    <div class="fmt-group"><div class="fmt-family">Good to know</div><div class="fmt-note">Files with a wrong or missing extension are recognised by their contents — use <strong>Open any file</strong>. Embedded subtitles inside converted files aren't carried over; sibling .srt / .vtt files still work. Very large files may exceed what a browser can convert.</div></div>`;
  fmtOverlay.classList.add("open");
}
const fmtBtn = document.getElementById("fmtBtn");
if (fmtBtn) fmtBtn.addEventListener("click", openFormats);
const fmtClose = document.getElementById("fmtCloseBtn");
if (fmtClose) fmtClose.addEventListener("click", () => fmtOverlay.classList.remove("open"));
if (fmtOverlay) fmtOverlay.addEventListener("click", (e) => { if (e.target === fmtOverlay) fmtOverlay.classList.remove("open"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && fmtOverlay && fmtOverlay.classList.contains("open")) fmtOverlay.classList.remove("open"); });

/* ---------------------------------------------------------------------
   Custom accent colors — mirrors the picker in Settings on the main
   library page, so the CC/AUD buttons and active states here match.
   --------------------------------------------------------------------- */
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 201, g: 168, b: 76 };
}
function rgbToHex(r, g, b) { return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join(""); }
function shadeColor(hex, factor) { const { r, g, b } = hexToRgb(hex); return rgbToHex(r * factor, g * factor, b * factor); }
function rgbaStr(hex, alpha) { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${alpha})`; }
async function applyStoredAccentColors() {
  const settings = await idbGet("kv", "settings");
  if (!settings) return;
  const root = document.documentElement.style;
  const a = settings.accentColor || "#C9A84C";
  const a2 = settings.accent2Color || "#B22222";
  root.setProperty("--accent", a);
  root.setProperty("--accent-dark", shadeColor(a, 0.68));
  root.setProperty("--accent-dim", rgbaStr(a, 0.33));
  root.setProperty("--ripple", rgbaStr(a, 0.13));
  root.setProperty("--accent2", a2);
  root.setProperty("--accent2-dim", rgbaStr(a2, 0.33));
  if (settings.light) document.documentElement.setAttribute("data-theme", "light");
}

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
async function boot() {
  volume.load();
  await applyStoredAccentColors();
  const handle = await getStoredHandle();
  if (handle) {
    const granted = await verifyPermission(handle, false);
    if (granted) { state.usingFSApi = true; await scanHandle(handle); return; }
    els.grantBtn.textContent = "Resume Access to Videos";
    els.grantBtn.onclick = async () => {
      const ok = await verifyPermission(handle, true);
      if (ok) { state.usingFSApi = true; await scanHandle(handle); }
      else toast("Access wasn't granted.");
    };
    window.VV.watchForSilentReconnect(handle, async () => { state.usingFSApi = true; await scanHandle(handle); });
  }
}
boot();
})();
