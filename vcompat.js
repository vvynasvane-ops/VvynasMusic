/* =========================================================================
   VVCompat — on-device "play anything" engine for the video page.

   Browsers natively demux only a handful of containers and decode only a
   handful of codecs. Everything else (AVI, WMV, FLV, MPEG-PS/TS, RealMedia,
   HEVC on most browsers, AC-3/DTS audio …) is handled here with ffmpeg
   compiled to WebAssembly, running entirely on the user's device — no
   upload, no server.

   Three tiers, cheapest first (the player always tries native first):
     1. REMUX        — streams the browser can already decode are copied,
                       untouched, into MP4/WebM. Takes seconds, no quality loss.
     2. REMUX+AUDIO  — video copied, only the audio (AC-3, DTS, WMA…) is
                       re-encoded. Still fast.
     3. TRANSCODE    — video re-encoded (H.264, or VP8 where the browser
                       can't play H.264). Slower. For long videos a short
                       low-res PREVIEW is produced first so playback starts
                       early, then swapped for the full version.

   What the browser can play is detected at runtime with canPlayType(), so
   the same code makes the right choice in Chrome, Edge, Firefox and Safari.

   Engine files (flat, next to the page): ffmpeg.js, 814.ffmpeg.js,
   ffmpeg-core.js, ffmpeg-core.wasm (~31 MB, downloaded only the first time a
   file actually needs converting). Set VVCompat.config({ base: "https://…/" })
   to load them from a CDN instead.
   ========================================================================= */
(function (global) {
"use strict";

const CFG = {
  base: "",                 // where the engine files live ("" = next to the page)
  previewAfter: 150,        // seconds: only videos longer than this get a quick preview first
  previewLen: 60,           // seconds of video in that preview
  maxHeight: { mp4: 720, webm: 480, preview: 360 },
};

/* ---------------------------------------------------------------------
   What this browser can play
   --------------------------------------------------------------------- */
const probeEl = document.createElement("video");
const can = (t) => { try { return probeEl.canPlayType(t) !== ""; } catch (e) { return false; } };
const CAP = {
  h264: can('video/mp4; codecs="avc1.64001F"'),
  hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"'),
  vp9mp4: can('video/mp4; codecs="vp09.00.10.08"'),
  av1mp4: can('video/mp4; codecs="av01.0.05M.08"'),
  vp8: can('video/webm; codecs="vp8"'),
  vp9: can('video/webm; codecs="vp9"'),
  av1webm: can('video/webm; codecs="av01.0.05M.08"'),
  aac: can('audio/mp4; codecs="mp4a.40.2"'),
  mp3mp4: can('audio/mp4; codecs="mp4a.6B"'),
  opusMp4: can('audio/mp4; codecs="opus"'),
  flacMp4: can('audio/mp4; codecs="flac"'),
  ac3: can('audio/mp4; codecs="ac-3"'),
  eac3: can('audio/mp4; codecs="ec-3"'),
  opusWebm: can('audio/webm; codecs="opus"'),
  vorbisWebm: can('audio/webm; codecs="vorbis"'),
};

/* ---------------------------------------------------------------------
   Engine lifecycle
   --------------------------------------------------------------------- */
let ff = null, loading = null, busy = false;
const LOG = [];

function url(name) { return new URL(CFG.base + name, document.baseURI).href; }
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (global.FFmpegWASM) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error("The conversion engine couldn't be loaded (is ffmpeg.js next to this page, and are you online the first time?)."));
    document.head.appendChild(s);
  });
}
async function engine(onStatus) {
  if (ff && ff.loaded) return ff;
  if (loading) return loading;
  loading = (async () => {
    onStatus && onStatus("Loading conversion engine (one-time, ~31 MB)…");
    await loadScript(url("ffmpeg.js"));
    const inst = new global.FFmpegWASM.FFmpeg();
    inst.on("log", ({ message }) => { LOG.push(message); if (LOG.length > 600) LOG.splice(0, 300); });
    // (no classWorkerURL: the UMD build finds 814.ffmpeg.js next to ffmpeg.js and starts it as a classic worker)
    await inst.load({ coreURL: url("ffmpeg-core.js"), wasmURL: url("ffmpeg-core.wasm") });
    ff = inst;
    return inst;
  })();
  try { return await loading; } finally { loading = null; }
}

class Cancelled extends Error { constructor() { super("Conversion cancelled"); this.cancelled = true; } }
let cancelFlag = false;

function cancel() {
  cancelFlag = true;
  if (ff) { try { ff.terminate(); } catch (e) { /* already gone */ } ff = null; }
  busy = false;
}

/* ---------------------------------------------------------------------
   Probe — read the stream list out of ffmpeg's own banner
   --------------------------------------------------------------------- */
function parseInfo(text) {
  const info = { container: "", duration: 0, video: null, audio: [], subs: 0 };
  let m = /Input #0, (.+?), from /.exec(text);
  if (m) info.container = m[1];
  m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (m) info.duration = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  const re = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?[^:\n]*: (Video|Audio|Subtitle): ([^\s,(]+)([^\n]*)/g;
  while ((m = re.exec(text))) {
    const [, idx, lang, kind, codec, rest] = m;
    const index = +idx;
    if (kind === "Video") {
      if (/attached pic/.test(rest) || info.video) continue;
      const wh = /(\d{2,5})x(\d{2,5})/.exec(rest);
      const pix = /,\s*(yuv\w+|gray\w*|rgb\w*|bgr\w*|nv\d+\w*|p0\d+\w*)/.exec(rest);
      info.video = { index, codec, width: wh ? +wh[1] : 0, height: wh ? +wh[2] : 0, pix: pix ? pix[1] : "" };
    } else if (kind === "Audio") {
      info.audio.push({ index, codec, lang: lang || "" });
    } else info.subs++;
  }
  return info;
}

/* ---------------------------------------------------------------------
   Plan — pick the cheapest route the browser can actually play
   --------------------------------------------------------------------- */
const NICE = { h264: "H.264", hevc: "HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1", mpeg4: "MPEG-4", msmpeg4v3: "MS-MPEG4", mpeg2video: "MPEG-2", mpeg1video: "MPEG-1",
  wmv1: "WMV", wmv2: "WMV", wmv3: "WMV", vc1: "VC-1", flv1: "Sorenson", theora: "Theora", rv10: "RealVideo", rv20: "RealVideo", rv30: "RealVideo", rv40: "RealVideo",
  prores: "ProRes", dnxhd: "DNxHD", mjpeg: "MJPEG", cinepak: "Cinepak", aac: "AAC", mp3: "MP3", mp2: "MP2", ac3: "AC-3", eac3: "E-AC-3", dts: "DTS",
  truehd: "TrueHD", wmav1: "WMA", wmav2: "WMA", wmapro: "WMA Pro", vorbis: "Vorbis", opus: "Opus", flac: "FLAC", alac: "ALAC", amr_nb: "AMR", amr_wb: "AMR",
  pcm_s16le: "PCM", pcm_s24le: "PCM", pcm_u8: "PCM", cook: "RealAudio", nellymoser: "Nellymoser" };
const nice = (c) => NICE[c] || (c || "?").toUpperCase();

function plan(info, opts) {
  opts = opts || {};
  const v = info.video, audios = info.audio.slice(0, 4);
  if (!v && !audios.length) return null;
  const C = CAP;

  // Can the video stream go into MP4/WebM as-is, and still be decoded by THIS browser?
  let container = null, copyVideo = false;
  const tenBit = v && /10|12|16/.test(v.pix);   // Hi10P etc.: the codec string says "supported", the decoder says no
  if (v && !opts.preview && !opts.forceTranscode && !tenBit) {
    const mp4ok = (v.codec === "h264" && C.h264) || (v.codec === "hevc" && C.hevc) || (v.codec === "vp9" && C.vp9mp4) || (v.codec === "av1" && C.av1mp4);
    const webmok = (v.codec === "vp8" && C.vp8) || (v.codec === "vp9" && C.vp9) || (v.codec === "av1" && C.av1webm);
    if (mp4ok) { container = "mp4"; copyVideo = true; }
    else if (webmok) { container = "webm"; copyVideo = true; }
  }
  if (!container) container = (C.h264 && (C.aac || C.opusMp4 || C.mp3mp4)) ? "mp4" : "webm";

  const audioCopyOk = (codec) => container === "mp4"
    ? ({ aac: C.aac, mp3: C.mp3mp4, opus: C.opusMp4, flac: C.flacMp4, ac3: C.ac3, eac3: C.eac3 })[codec]
    : ({ opus: C.opusWebm, vorbis: C.vorbisWebm })[codec];
  const audioEnc = container === "mp4" ? (C.aac ? "aac" : C.opusMp4 ? "libopus" : "libmp3lame") : (C.opusWebm ? "libopus" : "libvorbis");
  const audio = audios.map(a => ({ index: a.index, codec: a.codec, lang: a.lang, copy: !opts.reencodeAudio && !!audioCopyOk(a.codec), enc: audioEnc }));

  const anyAudioEncode = audio.some(a => !a.copy);
  const mode = !copyVideo ? "transcode" : anyAudioEncode ? "remux-audio" : "remux";
  const vEnc = container === "mp4" ? "libx264" : "libvpx";
  const maxH = opts.preview ? CFG.maxHeight.preview : CFG.maxHeight[container];

  const outV = !v ? "" : copyVideo ? nice(v.codec) : (container === "mp4" ? "H.264" : "VP8");
  const outA = audio.length ? [...new Set(audio.map(a => a.copy ? nice(a.codec) : nice(a.enc === "aac" ? "aac" : a.enc === "libopus" ? "opus" : a.enc === "libvorbis" ? "vorbis" : "mp3")))].join("/") : "";
  const label = (v ? nice(v.codec) : "") + (audio.length ? (v ? " + " : "") + [...new Set(audio.map(a => nice(a.codec)))].join("/") : "")
    + " → " + container.toUpperCase() + " (" + [outV, outA].filter(Boolean).join(" + ") + ")";

  return { mode, container, mime: container === "mp4" ? "video/mp4" : "video/webm", copyVideo, vEnc, maxH, audio, video: v, preview: !!opts.preview, label };
}

function buildArgs(p, input, output, o) {
  const a = ["-hide_banner", "-nostdin", "-fflags", "+genpts", "-i", input];
  if (o.limit) a.push("-t", String(o.limit));
  if (p.video) a.push("-map", "0:" + p.video.index);
  p.audio.forEach(x => a.push("-map", "0:" + x.index));
  a.push("-sn", "-dn", "-map_metadata", "-1", "-max_muxing_queue_size", "2048", "-avoid_negative_ts", "make_zero");

  if (p.video) {
    if (p.copyVideo) {
      a.push("-c:v", "copy");
      if (p.video.codec === "hevc" && p.container === "mp4") a.push("-tag:v", "hvc1");
    } else {
      const vf = "scale=-2:min(" + p.maxH + "\\,ih),format=yuv420p";
      if (p.container === "mp4") {
        a.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode", "-crf", p.preview ? "30" : "25", "-vf", vf, "-profile:v", "high", "-level", "4.1");
      } else {
        a.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0", "-b:v", p.preview ? "700k" : "1400k", "-crf", "12", "-vf", vf);
      }
    }
  }
  p.audio.forEach((x, i) => {
    if (x.copy) a.push("-c:a:" + i, "copy");
    else {
      a.push("-c:a:" + i, x.enc, "-b:a:" + i, "160k");
      // Stereo downmix for the widest compatibility — except with libopus, whose WASM build crashes ("memory access out of
      // bounds") when -ac is forced; Opus handles multichannel itself and browsers play it fine.
      if (x.enc !== "libopus") a.push("-ac:a:" + i, "2");
    }
  });
  if (p.container === "mp4") a.push("-movflags", "+faststart", "-f", "mp4");
  else a.push("-f", "webm");
  a.push(output);
  return a;
}

/* ---------------------------------------------------------------------
   Session: mount the user's file (no copy — WORKERFS reads it lazily), probe, run
   --------------------------------------------------------------------- */
async function open(file, onStatus) {
  const f = await engine(onStatus);
  const ext = ((/\.([a-z0-9]{1,6})$/i.exec(file.name) || [])[1] || "bin").toLowerCase();
  const name = "input." + ext;                          // safe name: no spaces / quotes / unicode in ffmpeg's eyes
  try { await f.createDir("/in"); } catch (e) { /* exists */ }
  await f.mount("WORKERFS", { files: [new File([file], name)] }, "/in");
  return {
    f, path: "/in/" + name,
    async close() { try { await f.unmount("/in"); } catch (e) { /* engine gone */ } try { await f.deleteDir("/in"); } catch (e) { /* ignore */ } },
  };
}

async function probeSession(s) {
  LOG.length = 0;
  try { await s.f.exec(["-hide_banner", "-i", s.path]); } catch (e) { if (cancelFlag) throw new Cancelled(); }
  if (cancelFlag) throw new Cancelled();
  return parseInfo(LOG.join("\n"));
}

function lastError() {
  const bad = LOG.filter(l => /error|invalid|fail|not supported|unsupported|no such|cannot|unknown/i.test(l)).slice(-3);
  return bad.join(" · ").slice(0, 300);
}

async function runSession(s, p, hooks, o) {
  const out = "/out_" + Date.now().toString(36) + "." + p.container;
  const expected = o.limit ? Math.min(o.limit, o.duration || o.limit) : (o.duration || 0);
  const t0 = Date.now();
  const onProg = ({ progress, time }) => {
    let pct = null;
    if (expected > 0 && isFinite(time) && time > 0) pct = Math.max(0, Math.min(1, (time / 1e6) / expected));
    else if (isFinite(progress) && progress > 0 && progress <= 1) pct = progress;
    hooks.progress && hooks.progress({ pct, elapsed: (Date.now() - t0) / 1000, phase: o.phase });
  };
  s.f.on("progress", onProg);
  let code;
  try { LOG.length = 0; code = await s.f.exec(buildArgs(p, s.path, out, o)); }
  catch (e) { if (cancelFlag) throw new Cancelled(); throw e; }
  finally { try { s.f.off("progress", onProg); } catch (e) { /* engine gone */ } }
  if (cancelFlag) throw new Cancelled();
  if (code !== 0) { try { await s.f.deleteFile(out); } catch (e) { /* none */ } throw new Error("The converter couldn't process this file" + (lastError() ? " (" + lastError() + ")" : "") + "."); }
  const data = await s.f.readFile(out);
  try { await s.f.deleteFile(out); } catch (e) { /* ignore */ }
  if (!data || !data.length) throw new Error("The converter produced an empty file.");
  return new Blob([data], { type: p.mime });
}

/**
 * Probe → plan → (optional quick preview) → full conversion.
 * hooks: status(msg), info(info, plan), progress({pct, elapsed, phase}), preview(blob, plan)
 * opts : forceTranscode, reencodeAudio, noPreview, startAt (seconds; skips preview when > 0)
 * Resolves { blob, plan, info }.  Rejects with err.cancelled === true on cancel().
 */
async function prepare(file, hooks, opts) {
  hooks = hooks || {}; opts = opts || {};
  if (busy) cancel();
  cancelFlag = false; busy = true;
  let s = null;
  try {
    s = await open(file, hooks.status);
    hooks.status && hooks.status("Reading the file…");
    const info = await probeSession(s);
    if (!info.video && !info.audio.length) throw new Error("No playable video or audio streams were found in this file.");
    if (opts.audioFix && !info.audio.length) { const e = new Error("This video has no audio track, so there's nothing to fix."); e.benign = true; throw e; }
    const p = plan(info, opts);
    hooks.info && hooks.info(info, p);

    const wantPreview = p.mode === "transcode" && !opts.noPreview && !(opts.startAt > 0) && info.duration > CFG.previewAfter;
    if (wantPreview) {
      const pp = plan(info, Object.assign({}, opts, { preview: true }));
      hooks.status && hooks.status("Making a quick preview…");
      const blob = await runSession(s, pp, hooks, { limit: CFG.previewLen, duration: info.duration, phase: "preview" });
      hooks.preview && await hooks.preview(blob, pp);
    }
    hooks.status && hooks.status(p.mode === "remux" ? "Repacking (no quality loss)…" : p.mode === "remux-audio" ? "Repacking and converting audio…" : "Converting video…");
    const blob = await runSession(s, p, hooks, { duration: info.duration, phase: "full" });
    return { blob, plan: p, info };
  } finally {
    busy = false;
    if (s) await s.close();
  }
}

global.VVCompat = {
  supported: () => typeof Worker !== "undefined" && typeof WebAssembly !== "undefined",
  capabilities: CAP,
  config: (o) => { if (o) Object.keys(o).forEach(k => { if (k === "maxHeight") Object.assign(CFG.maxHeight, o[k]); else CFG[k] = o[k]; }); return CFG; },
  busy: () => busy,
  cancel, prepare,
  // exposed for tests / the UI
  _parseInfo: parseInfo, _plan: plan,
};
})(window);
