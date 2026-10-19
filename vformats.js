/* =========================================================================
   VVFormats — the video format catalog + content sniffer for the video page.

   Two jobs:
   1. CATALOG — every video container / stream extension the player will
      list when it scans a folder (and what to call it, and which MIME type
      to hand the browser).
   2. SNIFFER — reads the first few KB of a file and recognises its real
      container from "magic bytes", so a file with a missing, wrong or
      misleading extension (a Matroska file called movie.dat, a TypeScript
      source file called app.ts) is treated for what it actually is.

   Whether a format can be decoded by the BROWSER is a separate question —
   see vcompat.js, which repacks / converts the rest on-device.
   ========================================================================= */
(function (global) {
"use strict";

/* [extension, human name, family, MIME, neverNative]
   neverNative = no mainstream browser demuxes this container at all, so the
   player goes straight to the on-device converter instead of trying (and
   failing) natively first. */
const F = [
  // MPEG-4 / QuickTime family
  ["mp4",  "MPEG-4 Part 14",              "MPEG-4 / QuickTime", "video/mp4"],
  ["m4v",  "iTunes video",                "MPEG-4 / QuickTime", "video/x-m4v"],
  ["mov",  "Apple QuickTime",             "MPEG-4 / QuickTime", "video/quicktime"],
  ["qt",   "Apple QuickTime",             "MPEG-4 / QuickTime", "video/quicktime"],
  ["3gp",  "3GPP (phones)",               "MPEG-4 / QuickTime", "video/3gpp"],
  ["3g2",  "3GPP2 (phones)",              "MPEG-4 / QuickTime", "video/3gpp2"],
  ["3gpp", "3GPP (phones)",               "MPEG-4 / QuickTime", "video/3gpp"],
  ["3gpp2","3GPP2 (phones)",              "MPEG-4 / QuickTime", "video/3gpp2"],
  ["f4v",  "Flash MP4 video",             "MPEG-4 / QuickTime", "video/mp4"],
  ["ismv", "Smooth Streaming",            "MPEG-4 / QuickTime", "video/mp4"],
  ["lrv",  "GoPro low-res clip",          "MPEG-4 / QuickTime", "video/mp4"],
  ["lrf",  "DJI low-res clip",            "MPEG-4 / QuickTime", "video/mp4"],
  ["insv", "Insta360 video",              "MPEG-4 / QuickTime", "video/mp4"],
  // Matroska / WebM / Ogg
  ["mkv",  "Matroska",                    "Matroska / WebM / Ogg", "video/x-matroska"],
  ["mk3d", "Matroska 3D",                 "Matroska / WebM / Ogg", "video/x-matroska"],
  ["webm", "WebM",                        "Matroska / WebM / Ogg", "video/webm"],
  ["ogv",  "Ogg video (Theora)",          "Matroska / WebM / Ogg", "video/ogg"],
  ["ogm",  "Ogg Media",                   "Matroska / WebM / Ogg", "video/ogg"],
  // Microsoft
  ["avi",  "AVI",                         "Microsoft", "video/x-msvideo", true],
  ["divx", "DivX",                        "Microsoft", "video/divx", true],
  ["wmv",  "Windows Media Video",         "Microsoft", "video/x-ms-wmv", true],
  ["asf",  "Advanced Systems Format",     "Microsoft", "video/x-ms-asf", true],
  ["wm",   "Windows Media",               "Microsoft", "video/x-ms-wm", true],
  ["dvr-ms","Windows Media Center recording","Microsoft", "video/x-ms-dvr", true],
  ["wtv",  "Windows TV recording",        "Microsoft", "video/x-ms-wtv", true],
  // Flash / Real
  ["flv",  "Flash Video",                 "Flash / Real", "video/x-flv", true],
  ["rm",   "RealMedia",                   "Flash / Real", "application/vnd.rn-realmedia", true],
  ["rmvb", "RealMedia Variable Bitrate",  "Flash / Real", "application/vnd.rn-realmedia-vbr", true],
  // MPEG program / transport streams, DVD, camcorders, broadcast
  ["mpg",  "MPEG-1/2 program stream",     "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["mpeg", "MPEG-1/2 program stream",     "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["mpe",  "MPEG-1/2 program stream",     "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["mpv",  "MPEG video",                  "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["m1v",  "MPEG-1 video",                "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["m2v",  "MPEG-2 video",                "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["m2p",  "MPEG-2 program stream",       "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["vob",  "DVD-Video object",            "MPEG streams, DVD & broadcast", "video/dvd", true],
  ["evo",  "HD DVD object",               "MPEG streams, DVD & broadcast", "video/mpeg", true],
  ["ts",   "MPEG transport stream",       "MPEG streams, DVD & broadcast", "video/mp2t", true],
  ["m2t",  "MPEG transport stream (HDV)", "MPEG streams, DVD & broadcast", "video/mp2t", true],
  ["m2ts", "Blu-ray / AVCHD stream",      "MPEG streams, DVD & broadcast", "video/mp2t", true],
  ["mts",  "AVCHD camcorder stream",      "MPEG streams, DVD & broadcast", "video/mp2t", true],
  ["dv",   "Raw DV (camcorder tape)",     "Professional & camcorder", "video/x-dv", true],
  ["dif",  "DV interchange",              "Professional & camcorder", "video/x-dv", true],
  ["mxf",  "Material Exchange (broadcast)","Professional & camcorder", "application/mxf", true],
  ["gxf",  "General Exchange (broadcast)","Professional & camcorder", "video/x-gxf", true],
  // Raw streams & intermediates
  ["264",  "Raw H.264 stream",            "Raw streams & intermediates", "video/h264", true],
  ["h264", "Raw H.264 stream",            "Raw streams & intermediates", "video/h264", true],
  ["265",  "Raw H.265 / HEVC stream",     "Raw streams & intermediates", "video/h265", true],
  ["h265", "Raw H.265 / HEVC stream",     "Raw streams & intermediates", "video/h265", true],
  ["hevc", "Raw H.265 / HEVC stream",     "Raw streams & intermediates", "video/h265", true],
  ["vc1",  "Raw VC-1 stream",             "Raw streams & intermediates", "video/vc1", true],
  ["drc",  "Dirac / VC-2",                "Raw streams & intermediates", "video/x-dirac", true],
  ["ivf",  "VP8 / VP9 / AV1 IVF",         "Raw streams & intermediates", "video/x-ivf", true],
  ["y4m",  "YUV4MPEG2 (uncompressed)",    "Raw streams & intermediates", "video/x-yuv4mpeg", true],
  ["mjpeg","Motion JPEG",                 "Raw streams & intermediates", "video/x-mjpeg", true],
  ["mjpg", "Motion JPEG",                 "Raw streams & intermediates", "video/x-mjpeg", true],
  ["mj2",  "Motion JPEG 2000",            "Raw streams & intermediates", "video/mj2", true],
  ["nut",  "NUT",                         "Raw streams & intermediates", "video/x-nut", true],
  // Other / legacy / game / niche
  ["nsv",  "Nullsoft Streaming Video",    "Legacy, game & niche", "video/x-nsv", true],
  ["nuv",  "NuppelVideo",                 "Legacy, game & niche", "video/x-nuv", true],
  ["bik",  "Bink Video (games)",          "Legacy, game & niche", "video/x-bink", true],
  ["bk2",  "Bink 2 Video (games)",        "Legacy, game & niche", "video/x-bink", true],
  ["smk",  "Smacker (games)",             "Legacy, game & niche", "video/x-smk", true],
  ["roq",  "Id RoQ (games)",              "Legacy, game & niche", "video/x-roq", true],
  ["amv",  "AMV (cheap MP4 players)",     "Legacy, game & niche", "video/x-amv", true],
  ["mtv",  "MTV (cheap MP4 players)",     "Legacy, game & niche", "video/x-mtv", true],
  ["flc",  "Autodesk Animator FLC",       "Legacy, game & niche", "video/x-flc", true],
  ["fli",  "Autodesk Animator FLI",       "Legacy, game & niche", "video/x-fli", true],
  ["dpg",  "Nintendo DS video",           "Legacy, game & niche", "video/x-dpg", true],
  ["pss",  "PlayStation video",           "Legacy, game & niche", "video/x-pss", true],
];

const BY_EXT = Object.create(null);
F.forEach(([ext, name, family, mime, never]) => { BY_EXT[ext] = { ext, name, family, mime, never: !!never }; });

// Extensions that are ALSO common non-video files (.ts = TypeScript, .mod = Go modules / tracker music…).
// They stay in the list because real videos use them, but the sniffer double-checks before playing.
const AMBIGUOUS = new Set(["ts", "264", "nut", "dv", "dif", "vc1", "drc", "pss", "flc", "fli"]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const videoExts = F.map(r => r[0]);
const VIDEO_RE = new RegExp("\\.(" + videoExts.map(escapeRe).join("|") + ")$", "i");
const ALL_RE = new RegExp("\\.(" + videoExts.concat(["m4a", "srt", "vtt"]).map(escapeRe).join("|") + ")$", "i");

const MIME = { m4a: "audio/mp4" };
videoExts.forEach(e => { MIME[e] = BY_EXT[e].mime; });

/* ---------------------------------------------------------------------
   Sniffer
   --------------------------------------------------------------------- */
const asc = (b, from, len) => { let s = ""; for (let i = from; i < from + len && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const hex = (b, from, arr) => arr.every((v, i) => b[from + i] === v);
const result = (ext, label, kind) => ({ ext, label, kind: kind || "video" });

function sniffBytes(b) {
  if (b.length < 12) return { ext: null, label: "", kind: "unknown" };

  // Matroska / WebM — EBML header
  if (hex(b, 0, [0x1A, 0x45, 0xDF, 0xA3])) return /webm/.test(asc(b, 4, 64)) ? result("webm", "WebM") : result("mkv", "Matroska");

  // ISO base media (MP4 / MOV / 3GP / M4V / M4A / HEIC…) — "ftyp" box at offset 4
  if (asc(b, 4, 4) === "ftyp") {
    const brand = asc(b, 8, 4);
    if (/^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/.test(brand)) return result(null, "Image (" + brand + ")", "image");
    if (/^M4[AB] /.test(brand)) return result("m4a", "M4A audio", "audio");
    if (brand === "qt  ") return result("mov", "QuickTime");
    if (/^3g2/.test(brand)) return result("3g2", "3GPP2");
    if (/^3g/.test(brand)) return result("3gp", "3GPP");
    if (/^M4V/.test(brand)) return result("m4v", "M4V");
    if (brand === "F4V ") return result("f4v", "Flash MP4");
    return result("mp4", "MP4");
  }
  // Old QuickTime files that start straight with a moov / mdat / wide / free atom
  if (/^(moov|mdat|wide|free|skip|pnot)$/.test(asc(b, 4, 4))) return result("mov", "QuickTime");

  // RIFF containers
  if (asc(b, 0, 4) === "RIFF") {
    const t = asc(b, 8, 4);
    if (t === "AVI " || t === "AVIX") return result("avi", "AVI");
    if (t === "WAVE") return result(null, "WAV audio", "audio");
    if (t === "WEBP") return result(null, "WebP image", "image");
    return { ext: null, label: "RIFF (" + t + ")", kind: "unknown" };
  }
  if (asc(b, 0, 4) === "OggS") return result("ogv", "Ogg");
  if (hex(b, 0, [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11])) return result("wmv", "Windows Media (ASF)");
  if (asc(b, 0, 3) === "FLV" && b[3] === 1) return result("flv", "Flash Video");
  if (asc(b, 0, 4) === ".RMF") return result("rm", "RealMedia");
  if (asc(b, 0, 4) === "DKIF") return result("ivf", "IVF");
  if (asc(b, 0, 9) === "YUV4MPEG2") return result("y4m", "YUV4MPEG2");
  if (asc(b, 0, 4) === "NSVf") return result("nsv", "Nullsoft Streaming Video");
  if (/^(BIK[a-z]|KB2[a-z])/.test(asc(b, 0, 4))) return result("bik", "Bink");
  if (/^SMK[24]$/.test(asc(b, 0, 4))) return result("smk", "Smacker");
  if (hex(b, 0, [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0D, 0x01, 0x02, 0x01])) return result("mxf", "MXF");

  // MPEG program stream / video elementary stream
  if (hex(b, 0, [0x00, 0x00, 0x01, 0xBA])) return result("mpg", "MPEG program stream");
  if (hex(b, 0, [0x00, 0x00, 0x01, 0xB3])) return result("m2v", "MPEG video stream");

  // MPEG transport stream: 0x47 sync byte every 188 bytes (or 192 for Blu-ray M2TS, with a 4-byte header)
  const syncs = (start, step) => { let n = 0; for (let i = 0; i < 5; i++) { const p = start + i * step; if (p >= b.length) break; if (b[p] === 0x47) n++; else return 0; } return n; };
  if (syncs(0, 188) >= 4) return result("ts", "MPEG transport stream");
  if (syncs(4, 192) >= 4) return result("m2ts", "Blu-ray / AVCHD stream");

  // Things that are definitely NOT video
  if (asc(b, 0, 3) === "ID3" || asc(b, 0, 4) === "fLaC" || asc(b, 0, 4) === "FORM") return result(null, "Audio file", "audio");
  if (hex(b, 0, [0x89, 0x50, 0x4E, 0x47]) || hex(b, 0, [0xFF, 0xD8, 0xFF]) || asc(b, 0, 3) === "GIF") return result(null, "Image", "image");
  if (asc(b, 0, 4) === "%PDF" || hex(b, 0, [0x50, 0x4B, 0x03, 0x04])) return result(null, "Document / archive", "other");

  // Looks like plain text? (source code, subtitles, logs…)
  let printable = 0; const n = Math.min(b.length, 512);
  for (let i = 0; i < n; i++) { const c = b[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++; }
  if (printable / n > 0.97) return result(null, "Text file", "text");

  return { ext: null, label: "", kind: "unknown" };
}

async function sniff(file) {
  const buf = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  return sniffBytes(buf);
}

/** The best extension for a file: what its content says, else what its name says. */
function effectiveExt(ext, sniffed) {
  return sniffed && sniffed.kind === "video" && sniffed.ext ? sniffed.ext : (ext || "").toLowerCase();
}

/** Grouped catalog for the "Supported formats" panel. */
function groups() {
  const out = new Map();
  F.forEach(([ext, name, family, mime, never]) => {
    if (!out.has(family)) out.set(family, []);
    out.get(family).push({ ext, name, mime, never: !!never });
  });
  return Array.from(out, ([family, items]) => ({ family, items }));
}

global.VVFormats = {
  videoRegex: VIDEO_RE, allRegex: ALL_RE, mimeMap: MIME, count: F.length,
  mimeFor: (ext) => MIME[(ext || "").toLowerCase()] || "",
  info: (ext) => BY_EXT[(ext || "").toLowerCase()] || null,
  neverNative: (ext) => !!(BY_EXT[(ext || "").toLowerCase()] || {}).never,
  isAmbiguousExt: (ext) => AMBIGUOUS.has((ext || "").toLowerCase()),
  sniff, sniffBytes, effectiveExt, groups,
};
})(window);
