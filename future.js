/* =========================================================================
   VVYNAS VANE — FUTURE HUB   (window.VaneFuture)

   Ten opt-in "futuristic" features behind one launcher (the ⚡ button, or
   Ctrl/⌘ + K for the palette). Everything here is ADDITIVE:

     1. Command Palette   Ctrl/⌘+K — fuzzy-jump to any song or action
     2. Holo Visualizer   live spectrum strip: Bars / Wave / Orbs
     3. Aura Edge         beat-reactive screen glow in the cover's colour
     4. BPM Radar         live tempo estimate from the beat analyser
     5. Time Warp         0.5×–2× speed, pitch preserved
     6. Loop Gate         A–B loop with markers on the seek bar  ( [  ]  \ )
     7. Sleep Timer       minutes or end-of-track, with a gentle fade-out
     8. Voice Control     push-to-talk commands (browser speech service)
     9. Holo Share Card   a neon "now playing" poster → PNG / share sheet
    10. Discovery Mix     a queue weighted toward what you've played least

   Stability rules this file follows:
   • It never touches playback state it doesn't own: it reads the app through
     the small `window.VaneBridge` handed out by app.js, and shares the one
     Web Audio graph via `VaneEQ.analysers()` (read-only — no nodes added).
   • Every entry point is wrapped in guard() so one failure can't take the
     rest down; if the bridge is missing the whole file simply does nothing.
   • Animation runs on ONE requestAnimationFrame loop that stops itself when
     the tab is hidden, nothing is playing, or no visual feature is on.
   • Time Warp is never persisted (the app always opens at 1×); the only
     saved preferences are the visualizer / aura toggles.
   • No network calls. (Voice Control uses the browser's own speech service —
     see the note in that card; it is off until you press the mic.)
   ========================================================================= */
(function () {
"use strict";

var B = window.VaneBridge;
if (!B || !B.audio) { console.warn("[Vane Future] app bridge not found — features disabled."); return; }

var audio = B.audio;
var doc = document;

/* ---------------------------------------------------------------------
   Tiny helpers
   --------------------------------------------------------------------- */
function $(sel, root) { return (root || doc).querySelector(sel); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function toast(msg, ms) { try { B.toast(msg, ms); } catch (e) { /* cosmetic */ } }
function reduceMotion() { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }
function fmtClock(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
function guard(name, fn) {
  return function () {
    try {
      var r = fn.apply(this, arguments);
      if (r && typeof r.then === "function") r.then(null, function (err) { console.warn("[Vane Future] " + name + " failed:", err); });
      return r;
    } catch (err) { console.warn("[Vane Future] " + name + " failed:", err); }
  };
}
function cssVar(name, fallback) {
  try { var v = getComputedStyle(doc.documentElement).getPropertyValue(name).trim(); return v || fallback; } catch (e) { return fallback; }
}
function parseColor(str, fallback) {
  var m;
  str = String(str || "").trim();
  if ((m = /^#([0-9a-f]{6})$/i.exec(str))) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  if ((m = /^#([0-9a-f]{3})$/i.exec(str))) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
  if ((m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(str))) return [+m[1], +m[2], +m[3]];
  return fallback || [201, 168, 76];
}
function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  var tag = t.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    var type = (t.type || "text").toLowerCase();
    return ["range", "checkbox", "radio", "button", "submit", "reset", "file", "color"].indexOf(type) === -1;
  }
  return false;
}

/* ---------------------------------------------------------------------
   Preferences (only the two visual toggles are remembered)
   --------------------------------------------------------------------- */
var PREF_KEY = "vane.future.v1";
var VIZ_MODES = ["bars", "wave", "orbs"];
var prefs = { viz: false, vizMode: "bars", aura: false };
try {
  var saved = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
  if (saved && typeof saved === "object") {
    prefs.viz = saved.viz === true;
    prefs.aura = saved.aura === true;
    if (VIZ_MODES.indexOf(saved.vizMode) !== -1) prefs.vizMode = saved.vizMode;
  }
} catch (e) { /* defaults */ }
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* not remembered */ } }

/* ---------------------------------------------------------------------
   Shared audio access (read-only)
   --------------------------------------------------------------------- */
function analysers() {
  try { return window.VaneEQ && window.VaneEQ.analysers ? window.VaneEQ.analysers() : null; } catch (e) { return null; }
}
function isPlaying() { return !audio.paused && !audio.ended; }
function currentSong() { try { return B.currentSong(); } catch (e) { return null; } }

/* =====================================================================
   DOM: launcher, hub, visualizer canvas, aura, palette, share modal
   ===================================================================== */
var ICON_BOLT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>';

var fab = doc.createElement("button");
fab.className = "fx-fab"; fab.id = "fxFab"; fab.type = "button";
fab.setAttribute("aria-label", "Open Future Hub"); fab.setAttribute("aria-expanded", "false"); fab.setAttribute("aria-controls", "fxHub");
fab.title = "Future Hub"; fab.innerHTML = ICON_BOLT; fab.classList.add("fx-away");

var playerBtn = doc.createElement("button");
playerBtn.className = "fx-player-btn"; playerBtn.type = "button"; playerBtn.setAttribute("aria-label", "Open Future Hub"); playerBtn.title = "Future Hub";
playerBtn.innerHTML = ICON_BOLT;

var hub = doc.createElement("div");
hub.className = "fx-hub"; hub.id = "fxHub"; hub.setAttribute("role", "dialog"); hub.setAttribute("aria-label", "Future Hub"); hub.setAttribute("aria-hidden", "true");
hub.innerHTML =
  '<div class="fx-hub-head"><span class="fx-hub-title">⚡ Future Hub</span><button class="fx-x" type="button" data-fx="close" aria-label="Close Future Hub">✕</button></div>' +
  '<div class="fx-hub-body">' +
    '<button class="fx-wide" type="button" data-fx="palette"><span>⌘ Command Palette</span><kbd>Ctrl&nbsp;K</kbd></button>' +

    '<section class="fx-card"><h4>Holo Visualizer <button class="fx-switch" type="button" role="switch" aria-checked="false" data-fx="viz" aria-label="Holo Visualizer"></button></h4>' +
      '<div class="fx-row" id="fxVizModes">' +
        '<button class="fx-chip" type="button" data-fx="vizmode" data-mode="bars">Bars</button>' +
        '<button class="fx-chip" type="button" data-fx="vizmode" data-mode="wave">Wave</button>' +
        '<button class="fx-chip" type="button" data-fx="vizmode" data-mode="orbs">Orbs</button>' +
      '</div></section>' +

    '<section class="fx-card"><h4>Aura Edge <button class="fx-switch" type="button" role="switch" aria-checked="false" data-fx="aura" aria-label="Aura Edge"></button></h4>' +
      '<p class="fx-note" style="margin:0">The screen edges pulse with the bass, tinted by the cover art.</p></section>' +

    '<section class="fx-card"><h4>BPM Radar <small id="fxBpmHint">listening…</small></h4>' +
      '<div class="fx-bpm"><div class="fx-bpm-ring" id="fxBpmRing"></div><div class="fx-big"><span id="fxBpmVal">—</span><small>BPM</small></div></div></section>' +

    '<section class="fx-card"><h4>Time Warp <small id="fxRateVal">1.00×</small></h4>' +
      '<input class="fx-range" id="fxRate" type="range" min="50" max="200" step="5" value="100" aria-label="Playback speed">' +
      '<div class="fx-row"><button class="fx-chip" type="button" data-fx="rate" data-v="0.75">0.75×</button><button class="fx-chip" type="button" data-fx="rate" data-v="1">1×</button><button class="fx-chip" type="button" data-fx="rate" data-v="1.25">1.25×</button><button class="fx-chip" type="button" data-fx="rate" data-v="1.5">1.5×</button></div>' +
      '<p class="fx-note">Pitch stays put. Resets to 1× each visit.</p></section>' +

    '<section class="fx-card"><h4>Loop Gate <small id="fxLoopVal">off</small></h4>' +
      '<div class="fx-row"><button class="fx-chip" type="button" data-fx="loopA">Set A <span class="fx-kbd">[</span></button><button class="fx-chip" type="button" data-fx="loopB">Set B <span class="fx-kbd">]</span></button><button class="fx-chip" type="button" data-fx="loopClear">Clear <span class="fx-kbd">\\</span></button></div></section>' +

    '<section class="fx-card"><h4>Sleep Timer <small id="fxSleepVal">off</small></h4>' +
      '<div class="fx-row" id="fxSleepChips">' +
        '<button class="fx-chip" type="button" data-fx="sleep" data-m="15">15m</button><button class="fx-chip" type="button" data-fx="sleep" data-m="30">30m</button>' +
        '<button class="fx-chip" type="button" data-fx="sleep" data-m="45">45m</button><button class="fx-chip" type="button" data-fx="sleep" data-m="60">60m</button>' +
        '<button class="fx-chip" type="button" data-fx="sleep" data-m="track">End of track</button><button class="fx-chip" type="button" data-fx="sleepCancel">Cancel</button>' +
      '</div><p class="fx-note">Fades the volume out, then pauses.</p></section>' +

    '<section class="fx-card"><h4>Voice Control <small id="fxVoiceState"></small></h4>' +
      '<div class="fx-row"><button class="fx-chip" type="button" data-fx="voice" id="fxVoiceBtn" title="Tap to speak (T)">🎙 Tap to speak</button></div>' +
      '<div class="fx-status" id="fxVoiceStatus"></div>' +
      '<p class="fx-note" id="fxVoiceNote">Try “next”, “pause”, “louder”, “shuffle”, “play <i>song name</i>”, “sleep in 20 minutes”. Your browser’s speech service hears the audio (Chrome sends it to Google) — your music library is never uploaded.</p></section>' +

    '<div class="fx-row">' +
      '<button class="fx-wide" type="button" data-fx="share" style="flex:1"><span>🖼 Share Card</span></button>' +
      '<button class="fx-wide" type="button" data-fx="discovery" style="flex:1"><span>✨ Discovery Mix</span></button>' +
    '</div>' +
  '</div>';

var viz = doc.createElement("canvas"); viz.id = "fxViz"; viz.setAttribute("aria-hidden", "true");
var aura = doc.createElement("div"); aura.id = "fxAura"; aura.setAttribute("aria-hidden", "true");

var pal = doc.createElement("div");
pal.className = "fx-modal"; pal.id = "fxPalette"; pal.setAttribute("aria-hidden", "true");
pal.innerHTML =
  '<div class="fx-pal" role="dialog" aria-modal="true" aria-label="Command palette">' +
    '<div class="fx-pal-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
    '<input id="fxPalInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search songs, or type a command…" role="combobox" aria-expanded="true" aria-controls="fxPalList"></div>' +
    '<div class="fx-pal-list" id="fxPalList" role="listbox"></div>' +
    '<div class="fx-pal-foot"><span>↑↓ navigate</span><span>↵ run</span><span>esc close</span></div>' +
  '</div>';

var shareModal = doc.createElement("div");
shareModal.className = "fx-modal fx-center"; shareModal.id = "fxShare"; shareModal.setAttribute("aria-hidden", "true");
shareModal.innerHTML =
  '<div class="fx-share" role="dialog" aria-modal="true" aria-label="Share card">' +
    '<canvas id="fxShareCanvas" width="1080" height="1350"></canvas>' +
    '<div class="fx-row" style="justify-content:center">' +
      '<button class="fx-chip fx-primary" type="button" data-fx="shareSave">Download PNG</button>' +
      '<button class="fx-chip" type="button" data-fx="shareSend" id="fxShareSend">Share…</button>' +
      '<button class="fx-chip" type="button" data-fx="shareClose">Close</button>' +
    '</div>' +
  '</div>';

function mountDom() {
  doc.body.appendChild(aura);
  doc.body.appendChild(viz);
  doc.body.appendChild(fab);
  doc.body.appendChild(hub);
  doc.body.appendChild(pal);
  doc.body.appendChild(shareModal);
  var po = $("#playerOverlay");
  if (po) po.appendChild(playerBtn); else playerBtn.style.display = "none";
}

/* =====================================================================
   Hub open / close
   ===================================================================== */
var hubOpen = false;
function setHub(open) {
  hubOpen = !!open;
  hub.classList.toggle("open", hubOpen);
  hub.setAttribute("aria-hidden", hubOpen ? "false" : "true");
  fab.setAttribute("aria-expanded", hubOpen ? "true" : "false");
  if (hubOpen) { syncUI(); ensureLoop(); }
}
var toggleHub = guard("hub", function () { setHub(!hubOpen); });

/* =====================================================================
   Single animation loop (visualizer + aura + BPM + hub readouts)
   ===================================================================== */
var loop = { id: 0, hubTick: 0 };
function wantLoop() { return !doc.hidden && (prefs.viz || prefs.aura || hubOpen); }
function ensureLoop() { if (!loop.id && wantLoop()) loop.id = requestAnimationFrame(frame); }

function frame(t) {
  loop.id = 0;
  if (!wantLoop()) return;
  var playing = isPlaying();
  var an = playing || vizEnergy > 0.01 ? analysers() : null;
  var bass = 0;
  if (playing && an) { try { bass = window.VaneEQ.beat(); } catch (e) { bass = 0; } }
  try { bpm.feed(t, bass, playing && !!an); } catch (e) { /* never break the loop */ }
  if (prefs.viz) { try { drawViz(t, an, playing); } catch (e) { console.warn("[Vane Future] visualizer frame failed", e); prefs.viz = false; syncVizVisibility(); syncUI(); } }
  if (prefs.aura) { try { drawAura(bass, playing); } catch (e) { /* ignore */ } }
  if (hubOpen) {
    if (!loop.ring) loop.ring = $("#fxBpmRing");
    // ring flashes on each detected beat and fades over ~300ms
    if (loop.ring) loop.ring.style.setProperty("--p", playing ? clamp(1 - (t - bpm.lastOnset) / 300, 0, 1).toFixed(2) : "0");
    if (t - loop.hubTick > 220) { loop.hubTick = t; updateHubLive(); }
  }
  if (playing || vizEnergy > 0.01 || auraLevel > 0.01 || hubOpen) loop.id = requestAnimationFrame(frame);
}

/* =====================================================================
   2. HOLO VISUALIZER
   ===================================================================== */
var BAR_N = 56;
var vctx = null, vW = 1, vH = 1;
var levels = new Float32Array(BAR_N);
var peaks = new Float32Array(BAR_N);
var vizEnergy = 0;
var vizFreq = null, vizTime = null, vizAnalyser = null, binMap = null;
var vizColors = { a: "#C9A84C", b: "#B22222", at: 0 };

var vDpr = 0;
function sizeViz() {
  var r = viz.getBoundingClientRect();
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (vctx && w === vW && h === vH && dpr === vDpr) return;      // unchanged — resetting canvas.width would clear it and flicker
  vW = w; vH = h; vDpr = dpr;
  viz.width = Math.round(vW * dpr); viz.height = Math.round(vH * dpr);
  vctx = viz.getContext("2d");
  if (vctx) vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function syncVizVisibility() {
  viz.classList.toggle("on", !!prefs.viz);
  if (prefs.viz) { sizeViz(); ensureLoop(); }
}
function buildBinMap(an) {
  var sr = an.ctx.sampleRate || 44100, n = an.spectrum.frequencyBinCount, lo = 40, hi = Math.min(16000, sr / 2 - 1);
  binMap = [];
  for (var i = 0; i < BAR_N; i++) {
    var f0 = lo * Math.pow(hi / lo, i / BAR_N), f1 = lo * Math.pow(hi / lo, (i + 1) / BAR_N);
    var b0 = clamp(Math.floor(f0 / (sr / 2) * n), 0, n - 1), b1 = clamp(Math.ceil(f1 / (sr / 2) * n), b0 + 1, n);
    binMap.push([b0, b1]);
  }
}
function refreshVizColors(t) {
  if (t - vizColors.at < 800) return;
  vizColors.at = t; vizColors.a = cssVar("--accent", "#C9A84C"); vizColors.b = cssVar("--accent2", "#B22222");
}
function drawViz(t, an, playing) {
  if (!vctx) sizeViz();
  if (!vctx) return;
  refreshVizColors(t);
  // 1) pull spectrum / waveform (or decay to silence)
  var haveData = false;
  if (an && an.spectrum) {
    if (vizAnalyser !== an.spectrum) {
      vizAnalyser = an.spectrum;
      vizFreq = new Uint8Array(an.spectrum.frequencyBinCount);
      vizTime = new Uint8Array(an.spectrum.fftSize);
      buildBinMap(an);
    }
    try { an.spectrum.getByteFrequencyData(vizFreq); if (prefs.vizMode === "wave") an.spectrum.getByteTimeDomainData(vizTime); haveData = true; } catch (e) { haveData = false; }
  }
  var maxLv = 0;
  for (var i = 0; i < BAR_N; i++) {
    var target = 0;
    if (haveData && playing) {
      var rng = binMap[i], m = 0;
      for (var k = rng[0]; k < rng[1]; k++) if (vizFreq[k] > m) m = vizFreq[k];
      target = Math.pow(m / 255, 1.35);
      // gentle tilt so highs don't look dead next to the bass
      target = Math.min(1, target * (0.85 + 0.5 * (i / BAR_N)));
    }
    var cur = levels[i];
    cur = target > cur ? cur + (target - cur) * 0.55 : cur * 0.9;
    if (cur < 0.002) cur = 0;
    levels[i] = cur;
    peaks[i] = Math.max(cur, peaks[i] - 0.012);
    if (cur > maxLv) maxLv = cur;
  }
  vizEnergy = maxLv;

  // 2) paint
  var g = vctx, W = vW, H = vH;
  g.clearRect(0, 0, W, H);
  var grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, vizColors.b); grad.addColorStop(1, vizColors.a);
  g.fillStyle = grad; g.strokeStyle = vizColors.a;

  if (prefs.vizMode === "bars") {
    var gap = 3, bw = Math.max(2, (W - gap * (BAR_N - 1)) / BAR_N);
    for (var b = 0; b < BAR_N; b++) {
      var h = Math.max(2, levels[b] * (H - 8)), x = b * (bw + gap);
      roundRect(g, x, H - h, bw, h, Math.min(3, bw / 2)); g.fill();
      if (peaks[b] > 0.02) { g.globalAlpha = 0.7; g.fillStyle = vizColors.a; g.fillRect(x, H - peaks[b] * (H - 8) - 4, bw, 2); g.fillStyle = grad; g.globalAlpha = 1; }
    }
  } else if (prefs.vizMode === "wave") {
    var mid = H * 0.55, amp = H * 0.42, step = Math.max(1, Math.floor(vizTime ? vizTime.length / Math.max(60, W / 3) : 1));
    g.lineWidth = 2; g.lineJoin = "round"; g.beginPath();
    var n = 0;
    for (var s = 0; vizTime && playing && s < vizTime.length; s += step, n++) {
      var px = s / vizTime.length * W, py = mid + ((vizTime[s] - 128) / 128) * amp * 1.6;
      if (n === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    if (!n) { g.moveTo(0, mid); g.lineTo(W, mid); }
    g.shadowColor = vizColors.a; g.shadowBlur = 10; g.stroke(); g.shadowBlur = 0;
    g.globalAlpha = 0.25; g.save(); g.translate(0, mid * 2); g.scale(1, -1); g.stroke(); g.restore(); g.globalAlpha = 1;
  } else { // orbs
    var cell = W / BAR_N;
    for (var o = 0; o < BAR_N; o++) {
      var r = 2 + levels[o] * Math.min(cell * 1.4, H * 0.32), cx = o * cell + cell / 2, cy = H - 14 - levels[o] * (H * 0.45);
      g.globalAlpha = 0.35 + levels[o] * 0.65;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = o % 2 ? vizColors.a : vizColors.b; g.fill();
    }
    g.globalAlpha = 1;
  }
  // BPM readout in the corner while the strip is showing
  if (bpm.value) { g.font = "600 11px system-ui, sans-serif"; g.fillStyle = vizColors.a; g.globalAlpha = 0.85; g.textAlign = "right"; g.fillText(bpm.value + " BPM", W - 10, 14); g.globalAlpha = 1; g.textAlign = "left"; }
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
}

/* =====================================================================
   3. AURA EDGE
   ===================================================================== */
var auraLevel = 0, auraAvg = 0, auraRGB = [201, 168, 76], auraTarget = [201, 168, 76], artToken = 0, artTimer = 0;
function syncAuraVisibility() { aura.classList.toggle("on", !!prefs.aura); if (prefs.aura) { sampleArtColor(); ensureLoop(); } }
function drawAura(bass, playing) {
  auraAvg += (bass - auraAvg) * 0.02;
  var pulse = playing ? clamp((bass - auraAvg) * 4 + 0.15, 0, 1) : 0;
  auraLevel += (pulse - auraLevel) * (pulse > auraLevel ? 0.45 : 0.08);
  if (auraLevel < 0.004) auraLevel = 0;
  for (var i = 0; i < 3; i++) auraRGB[i] += (auraTarget[i] - auraRGB[i]) * 0.06;
  aura.style.setProperty("--fx-a", (0.12 + auraLevel * 0.78).toFixed(3));
  aura.style.setProperty("--fx-s", Math.round(36 + auraLevel * 120) + "px");
  aura.style.setProperty("--fx-rgb", Math.round(auraRGB[0]) + ", " + Math.round(auraRGB[1]) + ", " + Math.round(auraRGB[2]));
}
function extractArtColor(url) {
  return new Promise(function (resolve) {
    if (!url) return resolve(null);
    var img = new Image();
    img.onload = function () {
      try {
        var c = doc.createElement("canvas"); c.width = c.height = 16;
        var g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, 16, 16);
        var d = g.getImageData(0, 0, 16, 16).data, r = 0, gg = 0, bb = 0, wsum = 0;
        for (var i = 0; i < d.length; i += 4) {
          var R = d[i], G = d[i + 1], Bc = d[i + 2], mx = Math.max(R, G, Bc), mn = Math.min(R, G, Bc);
          var sat = mx ? (mx - mn) / mx : 0, val = mx / 255;
          if (val < 0.18) continue;                      // skip near-black
          var w = (sat + 0.08) * val;
          r += R * w; gg += G * w; bb += Bc * w; wsum += w;
        }
        if (!wsum) return resolve(null);
        r /= wsum; gg /= wsum; bb /= wsum;
        var peak = Math.max(r, gg, bb) || 1, lift = peak < 170 ? 170 / peak : 1;   // keep the glow vivid
        resolve([Math.min(255, r * lift), Math.min(255, gg * lift), Math.min(255, bb * lift)]);
      } catch (e) { resolve(null); }                      // tainted / unreadable art → caller falls back to the theme accent
    };
    img.onerror = function () { resolve(null); };
    img.src = url;
  });
}
function songArtUrl(song) { try { return song ? B.artUrl(song) : null; } catch (e) { return null; } }
function sampleArtColor() {
  var token = ++artToken, fallback = parseColor(cssVar("--accent", "#C9A84C"));
  extractArtColor(songArtUrl(currentSong())).then(function (c) { if (token === artToken) auraTarget = c || fallback; });
}
function scheduleArtSample() { clearTimeout(artTimer); artTimer = setTimeout(guard("art", sampleArtColor), 180); }

/* =====================================================================
   4. BPM RADAR  (onset detection on the shared beat analyser)
   ===================================================================== */
var bpm = {
  avgFlux: 0.01, prev: 0, lastOnset: 0, onsets: [], value: 0, conf: 0, ema: 0,
  reset: function () { this.avgFlux = 0.01; this.prev = 0; this.lastOnset = 0; this.onsets = []; this.value = 0; this.conf = 0; this.ema = 0; },
  // Spectral-flux style: the shared bass level sits high and a kick only adds a step on top,
  // so react to sudden RISES relative to the recent typical rise, not to the absolute level.
  feed: function (t, e, active) {
    if (!active) { this.prev = 0; return; }
    var flux = Math.max(0, e - this.prev);
    var thr = Math.max(0.03, this.avgFlux * 2.5);
    if (this.prev > 0 && flux > thr && t - this.lastOnset > 280) {
      this.lastOnset = t; this.onsets.push(t);
      if (this.onsets.length > 40) this.onsets.shift();
      this.estimate();
    }
    this.avgFlux += (flux - this.avgFlux) * 0.05;
    this.prev = e;
  },
  estimate: function () {
    var o = this.onsets, n = o.length;
    if (n < 8) return;
    var pts = [], total = 0;
    function add(d, w) {
      if (d < 250 || d > 2000) return;
      var x = 60000 / d;
      while (x < 75) x *= 2;
      while (x >= 170) x /= 2;
      pts.push([x, w]); total += w;
    }
    for (var i = 1; i < n; i++) { add(o[i] - o[i - 1], 1); if (i > 1) add((o[i] - o[i - 2]) / 2, 0.5); }
    if (total <= 0) return;
    // densest cluster: for each candidate, the weight of readings within ±6 BPM of it
    var bestX = 0, bestW = 0;
    for (var a = 0; a < pts.length; a++) {
      var w = 0;
      for (var c = 0; c < pts.length; c++) if (Math.abs(pts[c][0] - pts[a][0]) <= 6) w += pts[c][1];
      if (w > bestW) { bestW = w; bestX = pts[a][0]; }
    }
    var num = 0, den = 0;
    for (var j = 0; j < pts.length; j++) if (Math.abs(pts[j][0] - bestX) <= 6) { num += pts[j][0] * pts[j][1]; den += pts[j][1]; }
    var est = den ? num / den : bestX;
    this.conf = clamp(bestW / total, 0, 1);
    if (this.conf < 0.5) return;
    this.ema = this.ema ? this.ema * 0.75 + est * 0.25 : est;
    var rounded = Math.round(this.ema);
    if (!this.value || Math.abs(rounded - this.value) >= 2) this.value = rounded;   // hysteresis against ±1 flicker
  },
};

/* =====================================================================
   5. TIME WARP
   ===================================================================== */
var rate = 1;
function applyRate() {
  try {
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    if ("preservesPitch" in audio) audio.preservesPitch = true;
    else if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
    else if ("mozPreservesPitch" in audio) audio.mozPreservesPitch = true;
  } catch (e) { /* unsupported — harmless */ }
}
var setRate = guard("rate", function (r) {
  rate = clamp(Math.round(r * 20) / 20, 0.5, 2);
  applyRate(); bpm.reset(); syncUI();
});

/* =====================================================================
   6. LOOP GATE
   ===================================================================== */
var loopA = null, loopB = null, loopTimer = 0;
var loopRange = doc.createElement("div"); loopRange.className = "fx-loop-range";
var pinA = doc.createElement("div"); pinA.className = "fx-loop-pin"; pinA.dataset.l = "A";
var pinB = doc.createElement("div"); pinB.className = "fx-loop-pin"; pinB.dataset.l = "B";
function mountLoopMarks() {
  var track = $("#seekTrack");
  if (track) { track.appendChild(loopRange); track.appendChild(pinA); track.appendChild(pinB); }
}
function paintLoopMarks() {
  var d = audio.duration, ok = isFinite(d) && d > 0;
  function pct(v) { return clamp(v / d * 100, 0, 100); }
  pinA.classList.toggle("on", ok && loopA != null);
  pinB.classList.toggle("on", ok && loopB != null);
  if (ok && loopA != null) pinA.style.left = pct(loopA) + "%";
  if (ok && loopB != null) pinB.style.left = pct(loopB) + "%";
  var both = ok && loopA != null && loopB != null;
  loopRange.classList.toggle("on", both);
  if (both) { loopRange.style.left = pct(loopA) + "%"; loopRange.style.width = (pct(loopB) - pct(loopA)) + "%"; }
}
function loopTick() {
  if (loopA == null || loopB == null || audio.paused) return;
  var c = audio.currentTime;
  if (c >= loopB && c < loopB + 0.6) { try { audio.currentTime = loopA; } catch (e) { /* ignore */ } }
}
function syncLoopTimer() {
  var active = loopA != null && loopB != null;
  if (active && !loopTimer) loopTimer = setInterval(guard("loop", loopTick), 40);
  if (!active && loopTimer) { clearInterval(loopTimer); loopTimer = 0; }
}
var setLoopA = guard("loopA", function () {
  if (!isFinite(audio.duration) || !audio.src) { toast("Play a song first"); return; }
  loopA = audio.currentTime;
  if (loopB != null && loopB <= loopA + 0.3) loopB = null;
  toast("Loop A set · " + fmtClock(loopA)); paintLoopMarks(); syncLoopTimer(); syncUI();
});
var setLoopB = guard("loopB", function () {
  if (!isFinite(audio.duration) || !audio.src) { toast("Play a song first"); return; }
  if (loopA == null) { setLoopA(); return; }
  var t = audio.currentTime;
  if (t <= loopA + 0.3) { toast("Put B a little after A"); return; }
  loopB = t;
  toast("🔁 Looping " + fmtClock(loopA) + " → " + fmtClock(loopB)); paintLoopMarks(); syncLoopTimer(); syncUI();
});
var clearLoop = guard("loopClear", function (silent) {
  var had = loopA != null || loopB != null;
  loopA = loopB = null; paintLoopMarks(); syncLoopTimer(); syncUI();
  if (had && !silent) toast("Loop cleared");
});

/* =====================================================================
   7. SLEEP TIMER
   ===================================================================== */
var sleep = { mode: null, endAt: 0, timer: 0, fading: false, v0: 1, lastSet: 1, fadeStart: 0, fadeDur: 0, volOk: null };
var FADE_MS = 10000;
function volumeSettable() {
  if (sleep.volOk != null) return sleep.volOk;
  try { var p = audio.volume; audio.volume = p > 0.5 ? p - 0.2 : p + 0.2; sleep.volOk = Math.abs(audio.volume - p) > 0.05; audio.volume = p; } catch (e) { sleep.volOk = false; }
  return sleep.volOk;
}
function sleepLeftMs() {
  if (sleep.mode === "time") return sleep.endAt - Date.now();
  if (sleep.mode === "track") {
    var d = audio.duration, c = audio.currentTime;
    return isFinite(d) ? (d - c) / Math.max(0.25, audio.playbackRate || 1) * 1000 : Infinity;
  }
  return Infinity;
}
function cancelSleep(silent, keepVolume) {
  if (sleep.timer) { clearInterval(sleep.timer); sleep.timer = 0; }
  if (sleep.fading && !keepVolume) { try { audio.volume = sleep.v0; } catch (e) { /* ignore */ } }
  sleep.fading = false; sleep.mode = null;
  if (!silent) toast("Sleep timer cancelled");
  syncUI();
}
function finishSleep() {
  var v0 = sleep.v0;
  try { if (!audio.paused) audio.pause(); } catch (e) { /* ignore */ }
  try { audio.volume = v0; } catch (e) { /* ignore */ }
  if (sleep.timer) { clearInterval(sleep.timer); sleep.timer = 0; }
  sleep.fading = false; sleep.mode = null;
  toast("🌙 Sleep timer — goodnight", 3000); syncUI();
}
function sleepTick() {
  if (!sleep.mode) return;
  var left = sleepLeftMs();
  if (!sleep.fading) {
    var lead = sleep.mode === "track" ? Math.min(FADE_MS, 4000) : FADE_MS;
    if (left <= lead) {
      if (audio.paused) { cancelSleep(true); return; }             // already stopped — nothing to fade
      sleep.v0 = audio.volume; sleep.lastSet = sleep.v0;
      sleep.fadeStart = Date.now(); sleep.fadeDur = Math.max(600, left - 150);
      sleep.fading = volumeSettable();
      if (!sleep.fading && left <= 0) { finishSleep(); return; }  // no volume control here (iOS): just stop on time
    }
  }
  if (sleep.fading) {
    if (Math.abs(audio.volume - sleep.lastSet) > 0.04) { cancelSleep(false, true); toast("Sleep timer cancelled — volume changed"); return; } // the listener's own change wins
    var p = clamp((Date.now() - sleep.fadeStart) / sleep.fadeDur, 0, 1);
    var v = sleep.v0 * (1 - p * p);                                // ease-in fade
    try { audio.volume = clamp(v, 0, 1); sleep.lastSet = audio.volume; } catch (e) { /* ignore */ }
    if (p >= 1) finishSleep();
  } else if (left <= 0) {
    finishSleep();
  }
}
var startSleep = guard("sleep", function (arg) {
  cancelSleep(true);
  if (arg === "track") { sleep.mode = "track"; toast("😴 Pausing at the end of this track"); }
  else { var m = clamp(parseInt(arg, 10) || 30, 1, 600); sleep.mode = "time"; sleep.endAt = Date.now() + m * 60000; toast("😴 Sleep timer: " + m + " min"); }
  sleep.timer = setInterval(guard("sleepTick", sleepTick), 100);
  syncUI();
});

/* =====================================================================
   8. VOICE CONTROL (push-to-talk)
   ===================================================================== */
var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
var voice = { rec: null, listening: false };
function songIndex() {
  var list = []; try { list = B.songs() || []; } catch (e) { list = []; }
  return list.map(function (s) { return { s: s, hay: ((s.title || "") + " " + (s.artist || "") + " " + (s.album || "")).toLowerCase() }; });
}
function fuzzyScore(q, text) {
  q = q.toLowerCase().trim(); if (!q) return 1;
  var tokens = q.split(/\s+/), total = 0;
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i], idx = text.indexOf(tok), s;
    if (idx >= 0) s = 1000 - idx - (text.length - tok.length) * 0.05;
    else {
      var ti = 0, qi = 0, gaps = 0, last = -1;
      while (ti < text.length && qi < tok.length) { if (text[ti] === tok[qi]) { if (last >= 0) gaps += ti - last - 1; last = ti; qi++; } ti++; }
      if (qi < tok.length) return 0;
      s = Math.max(1, 300 - gaps * 4);
    }
    total += s;
  }
  return total / tokens.length;
}
function bestSong(query) {
  var best = null, bs = 0, idx = songIndex();
  for (var i = 0; i < idx.length; i++) { var sc = fuzzyScore(query, idx[i].hay); if (sc > bs) { bs = sc; best = idx[i].s; } }
  return best;
}
function playSongById(id) {
  var ids = []; try { ids = B.songs().map(function (s) { return s.id; }); } catch (e) { ids = [id]; }
  B.playIds(ids, id);
}
function voiceSay(msg) {
  var el = $("#fxVoiceStatus"); if (el) el.textContent = msg;
  // The Hub's status line is invisible when the Hub is closed (e.g. started with the T key) — mirror it as a toast.
  if (!hubOpen) toast(msg, 2400);
}
function handleVoice(raw) {
  var t = String(raw || "").toLowerCase().replace(/[.,!?]/g, "").trim(), m;
  if (!t) { voiceSay("Didn’t catch that."); return; }
  function has(re) { return re.test(t); }
  var msg;
  if ((m = t.match(/^(?:play|put on)\s+(.+)$/)) && !/^(?:music|something|it|the music|a song|some music)$/.test(m[1])) {
    var s = bestSong(m[1]);
    if (s) { playSongById(s.id); msg = "▶ " + (s.title || "Song"); } else msg = "No song matching “" + m[1] + "”";
  }
  else if (has(/\b(cancel|stop|clear)\b.*\btimer\b/)) { cancelSleep(false); msg = "Timer cancelled"; }
  else if ((m = t.match(/\b(\d{1,3})\s*(?:minutes?|mins?)\b/)) && has(/\b(sleep|timer|stop|pause)\b/)) { startSleep(m[1]); msg = "Sleep timer " + m[1] + " min"; }
  else if (has(/\bunmute\b/)) { if (window.VaneBridge.toggleMute && audio.muted) B.toggleMute(); msg = "Unmuted"; }
  else if (has(/\bmute\b/)) { if (!audio.muted) B.toggleMute(); msg = "Muted"; }
  else if (has(/\b(pause|stop)\b/)) { if (!audio.paused) B.togglePlay(); msg = "Paused"; }
  else if (has(/\b(next|skip)\b/)) { B.next(); msg = "Next"; }
  else if (has(/\b(previous|go back|last song|back)\b/)) { B.prev(); msg = "Previous"; }
  else if (has(/\b(louder|volume up|turn it up|turn up)\b/)) { B.volumeNudge(1); B.volumeNudge(1); msg = "Volume up"; }
  else if (has(/\b(quieter|softer|volume down|turn it down|turn down)\b/)) { B.volumeNudge(-1); B.volumeNudge(-1); msg = "Volume down"; }
  else if (has(/\bshuffle\b/)) { B.toggleShuffle(); msg = "Shuffle toggled"; }
  else if (has(/\brepeat\b/)) { B.cycleRepeat(); msg = "Repeat changed"; }
  else if (has(/\b(discovery|surprise me)\b/)) { discoveryMix(); msg = "Discovery Mix"; }
  else if (has(/\blyrics?\b/)) { B.openLyrics(); msg = "Lyrics"; }
  else if (has(/\bequali[sz]er\b/)) { B.openEq(); msg = "Equalizer"; }
  else if (has(/\b(hide|show)\b.*\bmenu\b/)) { if (window.VaneDock) window.VaneDock.toggle(); msg = "Menu toggled"; }
  else if (has(/\bvisuali[sz]er\b/)) { prefs.viz = !prefs.viz; savePrefs(); syncVizVisibility(); syncUI(); msg = "Visualizer " + (prefs.viz ? "on" : "off"); }
  else if (has(/\b(play|resume|continue)\b/)) { if (audio.paused) B.togglePlay(); msg = "Playing"; }
  else msg = "Didn’t understand “" + raw + "”";
  voiceSay("“" + raw + "” → " + msg);
}
var toggleVoice = guard("voice", function () {
  if (!SR) { voiceSay("Voice control isn’t supported in this browser."); return; }
  if (voice.listening) { try { voice.rec.stop(); } catch (e) { /* ignore */ } return; }
  var rec = new SR();
  rec.lang = navigator.language || "en-US"; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
  rec.onstart = function () { voice.listening = true; voiceSay("Listening…"); syncUI(); };
  rec.onresult = guard("voiceResult", function (ev) { var r = ev.results && ev.results[0]; handleVoice(r && r[0] ? r[0].transcript : ""); });
  rec.onerror = function (ev) {
    var map = { "not-allowed": "Microphone permission is blocked.", "service-not-allowed": "Speech service isn’t allowed here.", "no-speech": "Didn’t hear anything.", "network": "Speech service unreachable.", "audio-capture": "No microphone found." };
    if (ev.error !== "aborted") voiceSay(map[ev.error] || "Voice error: " + ev.error);
  };
  rec.onend = function () { voice.listening = false; syncUI(); };
  voice.rec = rec;
  try { rec.start(); } catch (e) { voice.listening = false; voiceSay("Couldn’t start the microphone."); syncUI(); }
});

/* =====================================================================
   9. HOLO SHARE CARD
   ===================================================================== */
function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function wrapText(g, text, maxW, maxLines) {
  var words = String(text || "").split(/\s+/), lines = [], line = "";
  for (var i = 0; i < words.length; i++) {
    var test = line ? line + " " + words[i] : words[i];
    if (g.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; if (lines.length === maxLines) break; } else line = test;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  return lines;
}
function loadImage(url) {
  return new Promise(function (res) { if (!url) return res(null); var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { res(null); }; im.src = url; });
}
var openShare = guard("share", async function () {
  var song = currentSong();
  if (!song) { toast("Play a song first"); return; }
  var canvas = $("#fxShareCanvas"), g = canvas.getContext("2d"), W = 1080, H = 1350;
  var artUrl = songArtUrl(song);
  var rgb = (await extractArtColor(artUrl)) || auraTarget.slice(), accent = parseColor(cssVar("--accent", "#C9A84C"));
  var font = getComputedStyle(doc.body).fontFamily || "system-ui, sans-serif";
  // background
  var bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#04050c"); bg.addColorStop(0.5, "rgb(" + (rgb[0] * 0.3 | 0) + "," + (rgb[1] * 0.3 | 0) + "," + (rgb[2] * 0.3 | 0) + ")"); bg.addColorStop(1, "#04050c");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // deterministic starfield per song
  var seed = hashStr(String(song.id) + (song.title || ""));
  function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
  for (var i = 0; i < 160; i++) { g.globalAlpha = 0.15 + rnd() * 0.6; g.fillStyle = "#fff"; var sz = rnd() * 2.4 + 0.4; g.fillRect(rnd() * W, rnd() * H, sz, sz); }
  g.globalAlpha = 1;
  // orbital rings
  g.strokeStyle = "rgba(" + accent.join(",") + ",0.22)"; g.lineWidth = 2;
  for (var r = 0; r < 3; r++) { g.beginPath(); g.ellipse(W / 2, 560, 560 + r * 80, 190 + r * 60, -0.35 + r * 0.12, 0, Math.PI * 2); g.stroke(); }
  // cover art with glow
  var img = await loadImage(artUrl);
  var S = 620, x = (W - S) / 2, y = 250;
  g.save(); g.shadowColor = "rgba(" + rgb.map(Math.round).join(",") + ",0.85)"; g.shadowBlur = 90; g.fillStyle = "#000";
  roundRect(g, x, y, S, S, 36); g.fill(); g.restore();
  g.save(); roundRect(g, x, y, S, S, 36); g.clip();
  if (img) { var sc = Math.max(S / img.width, S / img.height), iw = img.width * sc, ih = img.height * sc; g.drawImage(img, x + (S - iw) / 2, y + (S - ih) / 2, iw, ih); }
  else { var gg = g.createLinearGradient(x, y, x + S, y + S); gg.addColorStop(0, "rgb(" + accent.join(",") + ")"); gg.addColorStop(1, "#120a1f"); g.fillStyle = gg; g.fillRect(x, y, S, S); }
  g.restore();
  g.strokeStyle = "rgba(255,255,255,0.18)"; g.lineWidth = 2; roundRect(g, x, y, S, S, 36); g.stroke();
  // text
  g.textAlign = "center"; g.fillStyle = "#fff"; g.font = "700 62px " + font;
  var lines = wrapText(g, song.title || "Unknown title", W - 160, 2), ty = y + S + 100;
  for (var l = 0; l < lines.length; l++) g.fillText(lines[l], W / 2, ty + l * 72);
  g.font = "500 40px " + font; g.fillStyle = "rgba(255,255,255,0.72)";
  g.fillText(String(song.artist || "Unknown artist").slice(0, 48), W / 2, ty + lines.length * 72 + 20);
  if (bpm.value) { g.font = "600 30px " + font; g.fillStyle = "rgb(" + rgb.map(Math.round).join(",") + ")"; g.fillText(bpm.value + " BPM", W / 2, ty + lines.length * 72 + 80); }
  // footer
  g.font = "600 28px " + font; g.fillStyle = "rgba(" + accent.join(",") + ",0.95)";
  try { g.letterSpacing = "8px"; } catch (e) { /* older browsers */ }
  g.fillText("VVYNAS VANE", W / 2, H - 70);
  try { g.letterSpacing = "0px"; } catch (e) { /* ignore */ }
  g.textAlign = "left";
  shareModal.classList.add("open"); shareModal.setAttribute("aria-hidden", "false");
  var sendBtn = $("#fxShareSend"); if (sendBtn) sendBtn.style.display = (navigator.share && navigator.canShare) ? "" : "none";
  setHub(false);
});
function closeShare() { shareModal.classList.remove("open"); shareModal.setAttribute("aria-hidden", "true"); }
function shareBlob(cb) { $("#fxShareCanvas").toBlob(function (b) { if (b) cb(b); else toast("Couldn’t create the image"); }, "image/png"); }
function saveShare() {
  shareBlob(function (blob) {
    var song = currentSong(), a = doc.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = ((song && song.title) || "now-playing").replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") + ".png";
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  });
}
function sendShare() {
  shareBlob(function (blob) {
    var song = currentSong(), file = new File([blob], "now-playing.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: (song && song.title) || "Now playing" }).catch(function () { /* cancelled */ });
    } else saveShare();
  });
}

/* =====================================================================
   10. DISCOVERY MIX
   ===================================================================== */
var discoveryMix = guard("discovery", function () {
  var songs = []; try { songs = B.songs() || []; } catch (e) { songs = []; }
  if (songs.length < 3) { toast("Add a few more songs first"); return; }
  var counts = B.playCounts(), cur = currentSong(), pool = [];
  for (var i = 0; i < songs.length; i++) {
    var s = songs[i]; if (cur && s.id === cur.id) continue;
    var c = counts && counts.get ? (counts.get(s.id) || 0) : 0;
    pool.push({ s: s, w: c === 0 ? 3 : 1 / (1 + c) });          // unheard tracks get a head start; heavy rotation fades out
  }
  var want = Math.min(25, pool.length), picked = [];
  while (picked.length < want && pool.length) {
    var tot = 0, k;
    for (k = 0; k < pool.length; k++) tot += pool[k].w;
    var r = Math.random() * tot, acc = 0;
    for (k = 0; k < pool.length; k++) { acc += pool[k].w; if (r <= acc) break; }
    if (k >= pool.length) k = pool.length - 1;
    picked.push(pool[k].s); pool.splice(k, 1);
  }
  // spread same-artist runs apart where we can
  for (var j = 1; j < picked.length; j++) {
    if (picked[j].artist && picked[j].artist === picked[j - 1].artist) {
      for (var q = j + 1; q < picked.length; q++) if (picked[q].artist !== picked[j - 1].artist) { var tmp = picked[j]; picked[j] = picked[q]; picked[q] = tmp; break; }
    }
  }
  var ids = picked.map(function (s) { return s.id; });
  B.playIds(ids, ids[0]);
  toast("✨ Discovery Mix · " + ids.length + " tracks you’ve heard the least", 2800);
  setHub(false);
});

/* =====================================================================
   1. COMMAND PALETTE
   ===================================================================== */
var palState = { open: false, items: [], sel: 0, prevFocus: null, idx: null };
function actionList() {
  function nav(view, label) { return { icon: "▤", label: "Go to " + label, hint: "Navigate", run: function () { B.navigateTo(view); } }; }
  return [
    { icon: "☰", label: "Hide / show menu bar", hint: "B", run: function () { if (window.VaneDock) window.VaneDock.toggle({ toast: true }); } },
    { icon: "⚙", label: "Open Themes & Settings", hint: "Settings", run: function () { B.openSettings(); } },
    { icon: "▶", label: "Play / Pause", hint: "Space", run: function () { B.togglePlay(); } },
    { icon: "⏭", label: "Next song", hint: "Shift →", run: function () { B.next(); } },
    { icon: "⏮", label: "Previous song", hint: "Shift ←", run: function () { B.prev(); } },
    { icon: "🔀", label: "Shuffle play everything", hint: "Library", run: function () { B.shufflePlayAll(); } },
    { icon: "🔀", label: "Toggle shuffle", hint: "S", run: function () { B.toggleShuffle(); } },
    { icon: "🔁", label: "Cycle repeat mode", hint: "R", run: function () { B.cycleRepeat(); } },
    { icon: "🔇", label: "Mute / unmute", hint: "M", run: function () { B.toggleMute(); } },
    { icon: "🎚", label: "Equalizer", hint: "E", run: function () { B.openEq(); } },
    { icon: "💬", label: "Lyrics", hint: "L", run: function () { B.openLyrics(); } },
    nav("songs", "Library"), nav("playlists", "Playlists"), nav("folders", "Folders"), nav("favorites", "Favorites"), nav("recent", "Recently Played"),
    { icon: "⚔", label: "Open DJ Mode", hint: "Page", run: function () { location.href = "dj.html"; } },
    { icon: "🎬", label: "Open Video Player", hint: "Page", run: function () { location.href = "video.html"; } },
    { icon: "📊", label: "Open Recap", hint: "Page", run: function () { location.href = "recap.html"; } },
    { icon: "✨", label: "Discovery Mix", hint: "Future", run: discoveryMix },
    { icon: "🖼", label: "Create share card", hint: "Future", run: openShare },
    { icon: "🌈", label: prefs.viz ? "Turn Holo Visualizer off" : "Turn Holo Visualizer on", hint: "Future", run: function () { prefs.viz = !prefs.viz; savePrefs(); syncVizVisibility(); syncUI(); } },
    { icon: "🌌", label: prefs.aura ? "Turn Aura Edge off" : "Turn Aura Edge on", hint: "Future", run: function () { prefs.aura = !prefs.aura; savePrefs(); syncAuraVisibility(); syncUI(); } },
    { icon: "🔁", label: "Loop Gate: set A here", hint: "[", run: setLoopA },
    { icon: "🔁", label: "Loop Gate: set B here", hint: "]", run: setLoopB },
    { icon: "✖", label: "Loop Gate: clear", hint: "\\", run: function () { clearLoop(); } },
    { icon: "😴", label: "Sleep timer: 15 minutes", hint: "Future", run: function () { startSleep(15); } },
    { icon: "😴", label: "Sleep timer: 30 minutes", hint: "Future", run: function () { startSleep(30); } },
    { icon: "😴", label: "Sleep timer: 60 minutes", hint: "Future", run: function () { startSleep(60); } },
    { icon: "😴", label: "Sleep timer: end of this track", hint: "Future", run: function () { startSleep("track"); } },
    { icon: "⏱", label: "Time Warp: back to normal speed", hint: "Future", run: function () { setRate(1); } },
    { icon: "⚡", label: "Open Future Hub", hint: "Future", run: function () { setHub(true); } },
  ].concat(SR ? [{ icon: "🎙", label: "Voice control (speak a command)", hint: "Future", run: toggleVoice }] : []);
}
function runPalette() {
  var input = $("#fxPalInput"), q = input.value.trim(), acts = actionList(), out = [];
  var actHits = [];
  for (var i = 0; i < acts.length; i++) { var sc = q ? fuzzyScore(q, acts[i].label.toLowerCase()) : 1; if (sc > 0) actHits.push({ a: acts[i], sc: sc }); }
  if (q) actHits.sort(function (x, y) { return y.sc - x.sc; });
  var maxActs = q ? 8 : 10;
  actHits.slice(0, maxActs).forEach(function (h) { out.push({ kind: "act", icon: h.a.icon, title: h.a.label, sub: "", hint: h.a.hint, run: h.a.run }); });
  var songHits = [];
  if (q) {
    var idx = palState.idx || [];
    for (var j = 0; j < idx.length; j++) { var s2 = fuzzyScore(q, idx[j].hay); if (s2 > 0) songHits.push({ s: idx[j].s, sc: s2 }); }
    songHits.sort(function (x, y) { return y.sc - x.sc; });
  }
  songHits.slice(0, 30).forEach(function (h) { out.push({ kind: "song", icon: "♪", title: h.s.title || "Untitled", sub: [h.s.artist, h.s.album].filter(Boolean).join(" · "), hint: "Play", run: function () { playSongById(h.s.id); } }); });
  palState.items = out; palState.sel = 0; renderPalette(q);
}
function renderPalette(q) {
  var list = $("#fxPalList"), html = "", lastKind = null;
  if (!palState.items.length) { list.innerHTML = '<div class="fx-pal-empty">No matches' + (q ? ' for “' + esc(q) + '”' : "") + "</div>"; return; }
  palState.items.forEach(function (it, i) {
    if (it.kind !== lastKind) { html += '<div class="fx-pal-group">' + (it.kind === "act" ? "Commands" : "Songs") + "</div>"; lastKind = it.kind; }
    html += '<button type="button" class="fx-pal-item' + (i === palState.sel ? " sel" : "") + '" role="option" data-i="' + i + '" aria-selected="' + (i === palState.sel) + '">' +
      '<span class="ic">' + esc(it.icon) + '</span><span class="tx"><span class="t" style="display:block">' + esc(it.title) + "</span>" + (it.sub ? '<span class="s" style="display:block">' + esc(it.sub) + "</span>" : "") + '</span><span class="k">' + esc(it.hint || "") + "</span></button>";
  });
  list.innerHTML = html;
  var sel = list.querySelector(".sel"); if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
}
function movePalette(d) {
  var n = palState.items.length; if (!n) return;
  palState.sel = (palState.sel + d + n) % n;
  var list = $("#fxPalList");
  list.querySelectorAll(".fx-pal-item").forEach(function (el, i) { var on = +el.dataset.i === palState.sel; el.classList.toggle("sel", on); el.setAttribute("aria-selected", String(on)); if (on && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); });
}
var openPalette = guard("palette", function () {
  if (palState.open) { $("#fxPalInput").focus(); $("#fxPalInput").select(); return; }
  var body = $("#appBody"); if (body && body.classList.contains("hidden")) return;   // still on the "grant access" screen
  setHub(false);
  palState.idx = songIndex(); palState.prevFocus = doc.activeElement; palState.open = true;
  pal.classList.add("open"); pal.setAttribute("aria-hidden", "false");
  var input = $("#fxPalInput"); input.value = ""; runPalette();
  input.focus();                                   // synchronous: keys typed right after Ctrl+K must land here
  setTimeout(function () { if (palState.open && doc.activeElement !== input) input.focus(); }, 30);
});
function closePalette() {
  if (!palState.open) return;
  palState.open = false; palState.idx = null;
  pal.classList.remove("open"); pal.setAttribute("aria-hidden", "true");
  var p = palState.prevFocus; palState.prevFocus = null;
  if (p && p.focus && doc.contains(p)) { try { p.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
}
function runPaletteItem(i) {
  var it = palState.items[i]; if (!it) return;
  closePalette();
  setTimeout(guard("paletteRun", it.run), 0);
}

/* =====================================================================
   Hub UI sync + live readouts
   ===================================================================== */
function setSwitch(sel, on) { var el = $(sel, hub); if (el) el.setAttribute("aria-checked", on ? "true" : "false"); }
function syncUI() {
  setSwitch('[data-fx="viz"]', prefs.viz); setSwitch('[data-fx="aura"]', prefs.aura);
  hub.querySelectorAll('[data-fx="vizmode"]').forEach(function (b) { b.classList.toggle("active", b.dataset.mode === prefs.vizMode); b.disabled = !prefs.viz; });
  var rv = $("#fxRateVal"); if (rv) rv.textContent = rate.toFixed(2) + "×";
  var rs = $("#fxRate"); if (rs && +rs.value !== Math.round(rate * 100)) rs.value = String(Math.round(rate * 100));
  hub.querySelectorAll('[data-fx="rate"]').forEach(function (b) { b.classList.toggle("active", Math.abs(+b.dataset.v - rate) < 0.001); });
  var lv = $("#fxLoopVal");
  if (lv) lv.textContent = loopA != null && loopB != null ? fmtClock(loopA) + " → " + fmtClock(loopB) : loopA != null ? "A " + fmtClock(loopA) + " · set B" : "off";
  hub.querySelectorAll('[data-fx="loopClear"]').forEach(function (b) { b.disabled = loopA == null && loopB == null; });
  updateSleepLabel();
  var vb = $("#fxVoiceBtn"), vs = $("#fxVoiceState");
  if (vb) {
    if (!SR) { vb.disabled = true; vb.textContent = "🎙 Not supported in this browser"; }
    else { vb.classList.toggle("active", voice.listening); vb.textContent = voice.listening ? "🎙 Listening… tap to stop" : "🎙 Tap to speak"; }
  }
  if (vs) vs.textContent = voice.listening ? "live" : "";
  updateHubLive();
}
function updateSleepLabel() {
  var sv = $("#fxSleepVal"); if (!sv) return;
  if (!sleep.mode) sv.textContent = "off";
  else if (sleep.mode === "track") sv.textContent = "end of track";
  else sv.textContent = fmtClock(Math.max(0, sleepLeftMs() / 1000)) + " left";
  hub.querySelectorAll('[data-fx="sleep"]').forEach(function (b) { b.classList.toggle("active", sleep.mode === "track" ? b.dataset.m === "track" : false); });
}
function updateHubLive() {
  var val = $("#fxBpmVal"), hint = $("#fxBpmHint");
  if (val) val.textContent = bpm.value ? String(bpm.value) : "—";
  if (hint) hint.textContent = !isPlaying() ? "play something" : bpm.value ? (bpm.conf > 0.6 ? "locked" : "tracking") : "listening…";
  if (sleep.mode) updateSleepLabel();
}

/* =====================================================================
   Overlay awareness (hides the FAB behind the full player; hides the
   visualizer under the lyrics / equalizer screens). Cheap 400ms poll —
   those overlays are created and toggled by other modules, so polling is
   sturdier than chasing every class change with observers.
   ===================================================================== */
function syncOverlays() {
  var root = doc.documentElement;
  var po = $("#playerOverlay"), lo = $("#lyricsOverlay"), eq = $("#vqOverlay"), body = $("#appBody");
  var playerOpen = !!(po && po.classList.contains("open"));
  var appReady = !!(body && !body.classList.contains("hidden"));
  root.classList.toggle("fx-player-open", playerOpen);
  root.classList.toggle("fx-lyrics-open", !!(lo && lo.classList.contains("open")));
  root.classList.toggle("fx-eq-open", !!(eq && eq.classList.contains("open")));
  fab.classList.toggle("fx-away", !appReady || playerOpen);
  playerBtn.style.display = appReady && po ? "" : "none";
}

/* =====================================================================
   Wiring
   ===================================================================== */
function wire() {
  fab.addEventListener("click", toggleHub);
  playerBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleHub(); });

  hub.addEventListener("click", guard("hubClick", function (e) {
    var t = e.target.closest("[data-fx]"); if (!t || t.disabled) return;
    switch (t.dataset.fx) {
      case "close": setHub(false); fab.focus && fab.focus({ preventScroll: true }); break;
      case "palette": openPalette(); break;
      case "viz": prefs.viz = !prefs.viz; savePrefs(); syncVizVisibility(); syncUI(); break;
      case "vizmode": if (VIZ_MODES.indexOf(t.dataset.mode) !== -1) { prefs.vizMode = t.dataset.mode; savePrefs(); syncUI(); } break;
      case "aura": prefs.aura = !prefs.aura; savePrefs(); syncAuraVisibility(); syncUI(); break;
      case "rate": setRate(parseFloat(t.dataset.v)); break;
      case "loopA": setLoopA(); break;
      case "loopB": setLoopB(); break;
      case "loopClear": clearLoop(); break;
      case "sleep": startSleep(t.dataset.m); break;
      case "sleepCancel": if (sleep.mode) cancelSleep(false); break;
      case "voice": toggleVoice(); break;
      case "share": openShare(); break;
      case "discovery": discoveryMix(); break;
    }
  }));
  var rateEl = $("#fxRate", hub);
  rateEl.addEventListener("input", guard("rateInput", function () { setRate(rateEl.value / 100); }));

  // click outside the hub closes it
  doc.addEventListener("pointerdown", function (e) {
    if (!hubOpen) return;
    if (hub.contains(e.target) || fab.contains(e.target) || playerBtn.contains(e.target)) return;
    setHub(false);
  }, true);

  // palette
  var input = $("#fxPalInput");
  input.addEventListener("input", guard("palInput", runPalette));
  input.addEventListener("keydown", function (e) {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); movePalette(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); movePalette(-1); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); runPaletteItem(palState.sel); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); }
  });
  $("#fxPalList").addEventListener("click", function (e) { var b = e.target.closest(".fx-pal-item"); if (b) runPaletteItem(+b.dataset.i); });
  $("#fxPalList").addEventListener("mousemove", function (e) { var b = e.target.closest(".fx-pal-item"); if (b && +b.dataset.i !== palState.sel) { palState.sel = +b.dataset.i; movePalette(0); } });
  pal.addEventListener("pointerdown", function (e) { if (e.target === pal) closePalette(); });

  // share modal
  shareModal.addEventListener("pointerdown", function (e) { if (e.target === shareModal) closeShare(); });
  shareModal.addEventListener("click", function (e) {
    var t = e.target.closest("[data-fx]"); if (!t) return;
    if (t.dataset.fx === "shareClose") closeShare(); else if (t.dataset.fx === "shareSave") saveShare(); else if (t.dataset.fx === "shareSend") sendShare();
  });

  // global keys (capture phase so Esc closes OUR top-most layer without also closing the app's)
  window.addEventListener("keydown", function (e) {
    if (e.isComposing) return;
    var k = e.key;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (k === "k" || k === "K")) { e.preventDefault(); e.stopPropagation(); palState.open ? closePalette() : openPalette(); return; }
    if (k === "Escape") {
      if (shareModal.classList.contains("open")) { e.stopImmediatePropagation(); e.preventDefault(); closeShare(); }
      else if (palState.open) { e.stopImmediatePropagation(); e.preventDefault(); closePalette(); }
      else if (hubOpen) { e.stopImmediatePropagation(); e.preventDefault(); setHub(false); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target) || palState.open) return;
    if (k === "[") { e.preventDefault(); setLoopA(); }
    else if (k === "]") { e.preventDefault(); setLoopB(); }
    else if (k === "\\") { e.preventDefault(); clearLoop(); }
  }, true);

  // audio events
  audio.addEventListener("loadstart", guard("loadstart", function () { clearLoop(true); bpm.reset(); applyRateIfCustom(); scheduleArtSample(); }));
  audio.addEventListener("loadedmetadata", guard("meta", function () { applyRateIfCustom(); paintLoopMarks(); scheduleArtSample(); }));
  audio.addEventListener("play", guard("play", function () { applyRateIfCustom(); ensureLoop(); }));
  audio.addEventListener("pause", guard("pause", function () { ensureLoop(); }));
  doc.addEventListener("visibilitychange", guard("vis", function () { if (!doc.hidden) { ensureLoop(); } }));
  window.addEventListener("resize", guard("resize", function () { if (prefs.viz) sizeViz(); }));
  doc.addEventListener("vane:menu-toggled", function () { setTimeout(guard("vizSize", function () { if (prefs.viz) sizeViz(); }), 360); });
  if ("ResizeObserver" in window) { try { new ResizeObserver(guard("ro", function () { if (prefs.viz) sizeViz(); })).observe(viz); } catch (e) { /* ignore */ } }

  setInterval(guard("overlays", function () { if (!doc.hidden) syncOverlays(); }), 400);
}
function applyRateIfCustom() { if (rate !== 1) applyRate(); }

/* ---------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------- */
guard("boot", function () {
  mountDom(); mountLoopMarks(); wire();
  syncVizVisibility(); syncAuraVisibility(); syncUI(); syncOverlays();
})();

window.VaneFuture = { _bpmState: bpm, voiceCommand: handleVoice, toggleVoice: toggleVoice, voiceSupported: !!SR, openPalette: openPalette, openHub: function () { setHub(true); }, discoveryMix: discoveryMix, startSleep: startSleep, setRate: setRate, bpm: function () { return bpm.value; } };
})();
