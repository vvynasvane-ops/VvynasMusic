/* =========================================================================
   VVYNAS VANE — MENU DOCK   (window.VaneDock)

   One button hides / shows the app's "menu bar":
     • tablet / laptop (≥ 900px) → the left sidebar slides away and the
       content + mini-player reclaim the space
     • phone (< 900px)           → the bottom tab bar slides down and the
       mini-player drops into its place

   Deliberately tiny and dependency-free, and loaded BEFORE future.js, so
   nothing in the optional feature layer can ever break it. All the visuals
   are driven by a single class on <html> (`menu-hidden`) — see the "Menu
   dock" block in future.css — so there is no layout maths in JavaScript.

   • Remembered between visits (localStorage, wrapped in try/catch: private
     mode / blocked storage just means it isn't remembered).
   • Keyboard: B (ignored while typing, or with Ctrl / Cmd / Alt / Shift).
   • Reachability: with the sidebar hidden on desktop a ⚙ button appears in
     the top bar (Settings used to live only in the sidebar), and the
     Command Palette (Ctrl/⌘ + K) can still reach everything.
   ========================================================================= */
(function () {
"use strict";

var KEY = "vane.menuHidden";
var root = document.documentElement;
var btn = document.getElementById("menuToggleBtn");
var topSettings = document.getElementById("topSettingsBtn");
if (!btn) return; // markup missing — fail quietly rather than break the page

function readSaved() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
function writeSaved(v) { try { localStorage.setItem(KEY, v ? "1" : "0"); } catch (e) { /* not remembered, still works */ } }

function isHidden() { return root.classList.contains("menu-hidden"); }

function apply(hidden) {
  root.classList.toggle("menu-hidden", hidden);
  var label = hidden ? "Show menu bar" : "Hide menu bar";
  btn.setAttribute("aria-pressed", hidden ? "true" : "false");
  btn.setAttribute("aria-label", label);
  btn.title = label + " (B)";
}

function set(hidden, opts) {
  hidden = !!hidden;
  if (hidden === isHidden() && !(opts && opts.force)) return;
  apply(hidden);
  if (!opts || opts.persist !== false) writeSaved(hidden);
  if (opts && opts.toast && window.VaneBridge && window.VaneBridge.toast) {
    try { window.VaneBridge.toast(hidden ? "Menu bar hidden — press B to bring it back" : "Menu bar shown", 1600); } catch (e) {}
  }
  try { document.dispatchEvent(new CustomEvent("vane:menu-toggled", { detail: { hidden: hidden } })); } catch (e) {}
}

function toggle(opts) { set(!isHidden(), opts); }

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

btn.addEventListener("click", function () { toggle({ toast: false }); btn.blur(); });

if (topSettings) {
  topSettings.addEventListener("click", function () {
    var s = document.getElementById("settingsBtn");
    if (s) s.click();
  });
}

document.addEventListener("keydown", function (e) {
  if (e.defaultPrevented || e.repeat || e.isComposing) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (e.key !== "b" && e.key !== "B") return;
  if (isTypingTarget(e.target)) return;
  // The app starts on the "grant access" screen — there is no menu bar yet.
  var body = document.getElementById("appBody");
  if (body && body.classList.contains("hidden")) return;
  e.preventDefault();
  toggle({ toast: true });
});

// Restore the saved state (no write-back, no toast).
apply(readSaved());

window.VaneDock = { toggle: toggle, set: set, isHidden: isHidden };
})();
