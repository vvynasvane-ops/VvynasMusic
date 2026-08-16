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
   - MKV plays natively wherever the browser's own Matroska demuxer
     supports the codecs inside it (Chrome/Edge/Firefox: H.264 or VP9/VP8
     video + AAC/Opus/Vorbis/MP3 audio — the large majority of real-world
     MKV rips). There is no reliable, stable, purely-client-side way to
     decode codecs a browser doesn't support (e.g. HEVC in Chrome) without
     a heavy WASM transcoder that is neither fast nor stable enough for a
     general video player, so this deliberately does NOT attempt that.
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
const { idbGet, idbSet, fsApiSupported, verifyPermission, pickDirectory, getStoredHandle, walkDirectory } = window.VV;

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|avi)$/i;
const M4A_EXT = /\.m4a$/i;
const SUB_EXT = /\.(srt|vtt)$/i;
const ALL_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|m4a|srt|vtt)$/i;

// Explicit MIME map — do not rely on File.type, which is frequently empty
// or wrong for less common extensions (.mkv above all) depending on OS/browser.
const MIME_BY_EXT = {
  mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska",
  mov: "video/quicktime", avi: "video/x-msvideo", m4a: "audio/mp4",
};

const state = {
  videos: [], m4as: [], subs: [], fileRefs: new Map(), subRefs: new Map(),
  queue: [], queueIndex: -1, usingFSApi: false, objectUrl: null,
  currentTrackEl: null, currentSubUrl: null, currentItem: null,
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
  backBtn: $("#backBtn"), fullscreenBtn: $("#fullscreenBtn"), folderFallback: $("#vpFolderFallback"),
  ccBtn: $("#ccBtn"), ccModalOverlay: $("#ccModalOverlay"), ccList: $("#ccList"),
  ccLoadFileRow: $("#ccLoadFileRow"), ccCloseBtn: $("#ccCloseBtn"), subtitleFileInput: $("#vpSubtitleFile"),
  toast: $("#toast"),
};

function toast(msg) { els.toast.textContent = msg; els.toast.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => els.toast.classList.remove("show"), 2400); }
function fmtTime(sec) { if (!isFinite(sec) || sec < 0) sec = 0; const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function extOf(name) { return (name.split(".").pop() || "").toLowerCase(); }
function baseName(name) { return name.replace(/\.[^./]+$/, "").toLowerCase(); }

els.backBtn.addEventListener("click", () => { window.location.href = "index.html"; });
els.fullscreenBtn.addEventListener("click", () => {
  if (els.video.requestFullscreen) els.video.requestFullscreen().catch(() => toast("Fullscreen not available."));
  else toast("Fullscreen not supported in this browser.");
});

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
      state.subs.push({ id, name, folder, base: baseName(name) });
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

function render() {
  els.videoLabel.textContent = `Video Files (${state.videos.length})`;
  els.m4aLabel.textContent = `M4A Files (${state.m4as.length})`;
  els.videoList.innerHTML = state.videos.length
    ? state.videos.map(v => rowHtml(v, "video")).join("")
    : `<div style="padding:16px;color:var(--text-muted);font-size:13px;">No video files found.</div>`;
  els.m4aList.innerHTML = state.m4as.length
    ? state.m4as.map(v => rowHtml(v, "m4a")).join("")
    : `<div style="padding:16px;color:var(--text-muted);font-size:13px;">No M4A files found.</div>`;
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
  // Re-wrap with the correct MIME type — this is the key fix for MKV and
  // other extensions browsers/OSes frequently fail to auto-detect.
  const mime = MIME_BY_EXT[item.ext] || rawFile.type || "";
  const typedBlob = mime && rawFile.type !== mime ? rawFile.slice(0, rawFile.size, mime) : rawFile;

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(typedBlob);

  els.vpEmptyStage.classList.add("hidden");
  els.video.classList.remove("hidden");

  // Warn up front if the browser has no chance at all with this container/type.
  if (mime && els.video.canPlayType(mime) === "") {
    warn(`<strong>Heads up:</strong> your browser reports no support at all for <strong>.${item.ext.toUpperCase()}</strong> files. Playback may fail outright — try Chrome/Edge/Firefox, or convert the file.`);
  }

  els.video.src = state.objectUrl;
  els.video.load();
  els.video.play().catch(() => {});
  els.title.textContent = item.name;
  els.sub.textContent = M4A_EXT.test(item.name) ? "Audio (M4A)" : "Video";
  render();

  // After metadata loads, detect the classic "video track unsupported,
  // audio plays fine" case directly from the decoded dimensions.
  els.video.addEventListener("loadedmetadata", function checkVideoTrack() {
    els.video.removeEventListener("loadedmetadata", checkVideoTrack);
    const looksLikeAudioOnly = M4A_EXT.test(item.name);
    if (!looksLikeAudioOnly && els.video.videoWidth === 0 && els.video.videoHeight === 0 && els.video.duration > 0) {
      warn(`<strong>Audio only:</strong> the video track in this ${item.ext.toUpperCase()} couldn't be decoded — likely an unsupported codec (HEVC/H.265 is the most common culprit in Matroska/MKV files). Audio will keep playing. For full video, try VLC, or re-encode with H.264/VP9 video.`);
    }
  }, { once: true });

  autoLoadSiblingSubtitle(item);
}

function togglePlay() { if (!els.video.src) return; if (els.video.paused) els.video.play(); else els.video.pause(); }
function next() { if (!state.queue.length) return; let i = state.queueIndex + 1; if (i >= state.queue.length) i = 0; playId(state.queue[i]); }
function prev() { if (!state.queue.length) return; let i = state.queueIndex - 1; if (i < 0) i = state.queue.length - 1; playId(state.queue[i]); }

els.playBtn.addEventListener("click", togglePlay);
els.nextBtn.addEventListener("click", next);
els.prevBtn.addEventListener("click", prev);
els.video.addEventListener("play", () => { els.playIcon.innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'; });
els.video.addEventListener("pause", () => { els.playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>'; });
els.video.addEventListener("ended", next);
els.video.addEventListener("error", () => {
  const err = els.video.error;
  const codes = { 1: "loading was aborted", 2: "a network error occurred", 3: "the file is corrupt or uses an unsupported codec", 4: "this format/codec isn't supported by your browser" };
  warn(`<strong>Playback error:</strong> ${err ? (codes[err.code] || "playback failed") : "playback failed"}. Try VLC for full compatibility with unusual codecs.`);
});
els.video.addEventListener("timeupdate", () => {
  if (!els.video.duration) return;
  els.seek.value = (els.video.currentTime / els.video.duration) * 100;
  els.cur.textContent = fmtTime(els.video.currentTime);
  els.total.textContent = fmtTime(els.video.duration);
});
els.seek.addEventListener("input", () => { if (els.video.duration) els.video.currentTime = (els.seek.value / 100) * els.video.duration; });

[els.videoList, els.m4aList].forEach(list => list.addEventListener("click", (e) => {
  const row = e.target.closest(".vp-row");
  if (row) playId(row.dataset.id);
}));

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
  return state.subs.filter(s => s.folder === item.folder && s.base === item.base);
}
async function autoLoadSiblingSubtitle(item) {
  const matches = findSiblingSubtitles(item);
  if (!matches.length) return;
  const file = await getSubFile(matches[0].id);
  if (!file) return;
  const text = await file.text();
  await applySubtitleFromText(text, matches[0].name);
  toast(`Loaded subtitles: ${matches[0].name}`);
}

/* CC picker modal */
function openCcModal() {
  const matches = state.currentItem ? findSiblingSubtitles(state.currentItem) : [];
  const rows = [];
  rows.push(`<div class="cc-row ${!state.currentTrackEl ? "active" : ""}" data-action="off">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18"/></svg> Off</div>`);
  matches.forEach(m => rows.push(`<div class="cc-row" data-sub-id="${m.id}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/></svg>
    ${escapeHtml(m.name)} <span class="src-tag">in folder</span></div>`));
  els.ccList.innerHTML = rows.join("");
  els.ccModalOverlay.classList.add("open");
}
els.ccBtn.addEventListener("click", openCcModal);
els.ccCloseBtn.addEventListener("click", () => els.ccModalOverlay.classList.remove("open"));
els.ccModalOverlay.addEventListener("click", (e) => { if (e.target === els.ccModalOverlay) els.ccModalOverlay.classList.remove("open"); });
els.ccList.addEventListener("click", async (e) => {
  const off = e.target.closest('[data-action="off"]');
  if (off) { clearSubtitle(); els.ccBtn.classList.remove("active-cc"); els.ccModalOverlay.classList.remove("open"); return; }
  const row = e.target.closest("[data-sub-id]");
  if (row) {
    const file = await getSubFile(row.dataset.subId);
    if (!file) { toast("Couldn't read that subtitle file."); return; }
    const text = await file.text();
    const meta = state.subs.find(s => s.id === row.dataset.subId);
    await applySubtitleFromText(text, meta ? meta.name : "Subtitles");
    els.ccModalOverlay.classList.remove("open");
  }
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
   Boot
   --------------------------------------------------------------------- */
async function boot() {
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
  }
}
boot();
})();
