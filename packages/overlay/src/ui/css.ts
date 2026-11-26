/**
 * All of the dock's CSS. Nothing of it is in the page: `HOST_CSS` goes into the shadow root of
 * `<primp-root>` (the host, the highlight boxes, pins, tooltips, the handles, the two frames)
 * and `FRAME_CSS` into each frame's own document (the toolbar's and the popover's). Both are
 * applied as constructable stylesheets, which work under any Content-Security-Policy.
 *
 * Look: dark by default, light when the page's own theme is light (mount.ts `pageScheme`: a
 * single `color-scheme` on <html>, or a dark/light class or data-theme there), else when
 * `prefers-color-scheme` is light; the setting overrides both (`data-theme` on the host and on
 * each frame's root). 13 px system UI type, mono for
 * code, a 4 px grid, 8 to 12 px radii, hairline borders, a soft layered shadow and a blurred
 * translucent surface. Motion is 150 ms and off under `prefers-reduced-motion`.
 */

const DARK = `
  --surface: rgb(24 24 27 / 0.94); --solid: #18181b; --raised: rgb(255 255 255 / 0.06); --raised-2: rgb(255 255 255 / 0.1);
  --line: rgb(255 255 255 / 0.09); --line-strong: rgb(255 255 255 / 0.16);
  --text: #f4f4f5; --muted: #a1a1aa; --faint: #8b8b94;
  --accent: #3b82f6; --accent-hover: #5b96f8; --accent-soft: rgb(59 130 246 / 0.18); --accent-text: #93bbfd; --on-accent: #ffffff;
  --ok: #4ade80; --ok-soft: rgb(74 222 128 / 0.14); --warn: #fbbf24; --warn-soft: rgb(251 191 36 / 0.14); --bad: #f87171; --bad-soft: rgb(248 113 113 / 0.15);
  --pending: #a1a1aa;
  --scheme: dark;
`
const LIGHT = `
  --surface: rgb(255 255 255 / 0.94); --solid: #ffffff; --raised: rgb(9 9 11 / 0.045); --raised-2: rgb(9 9 11 / 0.08);
  --line: rgb(9 9 11 / 0.08); --line-strong: rgb(9 9 11 / 0.15);
  --text: #18181b; --muted: #52525b; --faint: #71717a;
  --accent: #2563eb; --accent-hover: #1d4ed8; --accent-soft: rgb(37 99 235 / 0.1); --accent-text: #1d4ed8; --on-accent: #ffffff;
  --ok: #16a34a; --ok-soft: rgb(22 163 74 / 0.1); --warn: #b45309; --warn-soft: rgb(217 119 6 / 0.12); --bad: #dc2626; --bad-soft: rgb(220 38 38 / 0.09);
  --pending: #71717a;
  --scheme: light;
`

const FONTS = `
  --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
`

/** Pins and status colours are the same in both themes: they sit on the page, not on the dock. */
const PIN = `
  --pin-pending: #71717a; --pin-pass: #16a34a; --pin-drift: #d97706; --pin-fail: #dc2626; --pin-draft: #3b82f6;
`

/**
 * The host takes no space (a 0 x 0 fixed box) and lets everything through; its children are
 * placed with `transform`. Its declarations are `!important` because rules of the page that
 * happen to match the host (`html > *`, `* { ... }`) would otherwise win over `:host`.
 */
export const HOST_CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 auto auto 0 !important;
  display: block !important;
  width: 0 !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  overflow: visible !important;
  background: transparent !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
  ${DARK}${FONTS}${PIN}
  --sel: #3b82f6; --sel-tint: rgb(59 130 246 / 0.09);
}
@media (prefers-color-scheme: light) { :host(:not([data-theme="dark"])) { ${LIGHT} } }
:host([data-theme="light"]) { ${LIGHT} }

.layer, .over { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.box {
  position: absolute; left: 0; top: 0; box-sizing: border-box; display: none;
  pointer-events: none; border: 1.5px solid var(--sel); border-radius: 3px;
}
.box.hover { background: var(--sel-tint); border-width: 1.5px; }
.box.selected { border-width: 2px; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.5); }
.box.previous { border: 1.5px dashed #ea580c; }
.box.current { border-color: #ea580c; background: rgb(234 88 12 / 0.1); }
.box.culprit { border: 2px solid #e11d48; background: rgb(225 29 72 / 0.08); }
.box span {
  position: absolute; left: -2px; top: 0; display: none; padding: 2px 7px; border-radius: 6px;
  background: var(--sel); color: #fff; white-space: pre; font: 500 11px/1.4 var(--sans);
}
.box.previous span, .box.current span { background: #ea580c; }
.box.culprit span { background: #e11d48; }

/* The name of the element under the pointer, next to the pointer. */
.label-chip {
  position: absolute; left: 0; top: 0; display: none; pointer-events: none; z-index: 4;
  max-width: 360px; padding: 4px 8px; border-radius: 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: #18181b; color: #fafafa; font: 500 11.5px/1.35 var(--mono);
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08), 0 4px 12px rgb(0 0 0 / 0.25);
}
.label-chip .src { color: #a1a1aa; font-family: var(--sans); font-weight: 450; }

/* Numbered pins on changed elements: primp's own nodes, placed with transform. */
.pin {
  position: absolute; left: 0; top: 0; display: none; z-index: 3; box-sizing: border-box;
  width: 22px; height: 22px; border-radius: 11px; padding: 0 5px; min-width: 22px;
  background: var(--pin-pending); color: #fff; font: 650 11px/22px var(--sans); text-align: center; font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px rgb(255 255 255 / 0.95), 0 2px 6px rgb(0 0 0 / 0.28);
  pointer-events: auto; cursor: pointer; user-select: none; -webkit-user-select: none;
  transition: transform 150ms ease, background-color 150ms ease;
}
.pin[data-status="draft"] { background: var(--pin-draft); }
.pin[data-status="pass"] { background: var(--pin-pass); }
.pin[data-status="drift"] { background: var(--pin-drift); }
.pin[data-status="fail"] { background: var(--pin-fail); }
.pin.current { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--sel), 0 2px 6px rgb(0 0 0 / 0.28); }

/* Tooltips of the toolbar and the pins, the toast, the resize note: above the frames. */
.tip, .toast, .note-chip {
  position: absolute; left: 0; top: 0; display: none; pointer-events: none; z-index: 8; box-sizing: border-box;
  padding: 5px 9px; border-radius: 8px; max-width: 300px;
  background: #18181b; color: #fafafa; font: 500 12px/1.4 var(--sans);
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.08), 0 6px 18px rgb(0 0 0 / 0.28);
}
.tip { white-space: nowrap; }
.tip.wrap { white-space: normal; width: max-content; }
.tip kbd { margin-left: 8px; padding: 0 5px; border-radius: 4px; background: rgb(255 255 255 / 0.12); color: #d4d4d8; font: 500 11px/16px var(--sans); }
.tip .sub { display: block; color: #a1a1aa; font-weight: 450; margin-top: 2px; white-space: normal; }
.toast { white-space: normal; width: max-content; max-width: 340px; }
.toast.bad { background: #7f1d1d; }
.note-chip { white-space: normal; width: 260px; background: #18181b; border-left: 3px solid #f59e0b; }
:host([data-theme="light"]) .tip, :host([data-theme="light"]) .toast, :host([data-theme="light"]) .note-chip, :host([data-theme="light"]) .label-chip { background: #18181b; }

/* Handles on the selection (handles.ts). The visible square is smaller than the hit area. */
.handle, .grip {
  position: absolute; left: 0; top: 0; display: none; z-index: 2; box-sizing: border-box;
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
}
.handle { width: 14px; height: 14px; }
.handle::before {
  content: ""; position: absolute; inset: 3px; border-radius: 2px; background: #fff;
  border: 1.5px solid var(--sel); box-shadow: 0 1px 2px rgb(15 23 42 / 0.25);
}
.handle:hover::before, .handle.active::before { background: var(--sel); }
.handle.e { cursor: ew-resize; } .handle.s { cursor: ns-resize; } .handle.se { cursor: nwse-resize; }
.grip {
  width: 34px; height: 22px; padding: 6px 7px; border-radius: 7px; cursor: grab;
  background: radial-gradient(circle, rgb(255 255 255 / 0.95) 1.3px, transparent 1.8px) content-box 0 0 / 6px 5px repeat, var(--sel);
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.85), 0 1px 3px rgb(15 23 42 / 0.3);
}
/* A larger hit area than the pill shows. */
.grip::after { content: ""; position: absolute; inset: -5px -4px; }
.grip:hover, .grip.active { background-color: #2563eb; }
.grip.active { cursor: grabbing; }
/* The grip of the item around the selection (the card around a paragraph): outlined, not filled, until hovered. */
.grip.item { background: radial-gradient(circle, var(--sel) 1.3px, transparent 1.8px) content-box 0 0 / 6px 5px repeat, #fff; box-shadow: 0 0 0 1.5px var(--sel), 0 1px 3px rgb(15 23 42 / 0.3); }
.grip.item:hover, .grip.item.active { background: radial-gradient(circle, rgb(255 255 255 / 0.95) 1.3px, transparent 1.8px) content-box 0 0 / 6px 5px repeat, #2563eb; }
/* Nothing around the selection can be moved: greyed, the tooltip says why. */
.grip.off { cursor: not-allowed; background: radial-gradient(circle, rgb(255 255 255 / 0.9) 1.3px, transparent 1.8px) content-box 0 0 / 6px 5px repeat, #a1a1aa; }
.grip.off:hover { background-color: #a1a1aa; }
/* What the item's grip moves, while it is hovered. */
.move-target {
  position: absolute; left: 0; top: 0; display: none; z-index: 1; pointer-events: none; box-sizing: border-box;
  border: 1.5px dashed var(--sel); border-radius: 3px; background: rgb(59 130 246 / 0.06);
}
/* Next to the pointer during a reorder drag: where the element lands. */
.drag-tag {
  position: absolute; left: 0; top: 0; display: none; z-index: 7; pointer-events: none; padding: 3px 8px; border-radius: 7px;
  background: #18181b; color: #fff; white-space: pre; font: 500 12px/1.4 var(--sans);
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.12), 0 4px 12px rgb(15 23 42 / 0.25);
}

/* The two frames: the toolbar (or launcher) and the popover. The blur is on the frame element,
   which is in the page's document, so it blurs the page behind it. */
iframe {
  position: absolute; left: 0; top: 0; display: block; border: 0; margin: 0; padding: 0;
  pointer-events: auto; background: transparent; color-scheme: normal;
  -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5);
  box-shadow: 0 0 0 0.5px rgb(0 0 0 / 0.35), 0 1px 2px rgb(0 0 0 / 0.12), 0 8px 24px rgb(0 0 0 / 0.18), 0 24px 56px rgb(0 0 0 / 0.16);
}
iframe.bar { z-index: 6; border-radius: 22px; }
iframe.pop { z-index: 5; border-radius: 12px; }
iframe.pop.sheet { border-radius: 14px 14px 0 0; }
iframe.hidden { display: none; }
iframe.settled { transition: transform 150ms ease, opacity 120ms ease; }
/* Out of the way while a handle is dragged over the page (handles.ts). */
iframe.faded { opacity: 0.12; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { iframe.settled, .pin { transition: none; } }
`

export const FRAME_CSS = `
:root { ${DARK}${FONTS} color-scheme: dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${LIGHT} color-scheme: light; } }
:root[data-theme="light"] { ${LIGHT} color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; overflow: hidden; }
/* Fixed: the frame's document has nothing to scroll, so focusing or revealing a control never shifts the popover inside its frame. */
#root { position: fixed; left: 0; top: 0; }
body {
  overflow: hidden; color: var(--text);
  font: 13px/1.45 var(--sans); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
button, input, select, textarea { font: inherit; color: inherit; margin: 0; }
button { cursor: pointer; background: none; border: 0; padding: 0; }
button:disabled { cursor: default; opacity: 0.4; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 6px; }
h2, h3, p, ul, ol, dl, dd { margin: 0; padding: 0; }
ul, ol { list-style: none; }
.icon { display: block; flex: none; }
.mono { font-family: var(--mono); font-size: 12px; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.grow { flex: 1; min-width: 0; }

/* ---------------------------------------------------------------- toolbar */
.launcher {
  position: relative; width: 44px; height: 44px; border-radius: 22px; display: grid; place-items: center;
  background: var(--surface); color: var(--text); transition: background-color 150ms ease;
}
.launcher:hover { background: var(--solid); }
.launcher:focus-visible { outline-offset: -3px; border-radius: 22px; }
.badge {
  position: absolute; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: var(--accent); color: var(--on-accent); font: 650 10px/16px var(--sans); text-align: center; font-variant-numeric: tabular-nums;
}
.launcher .badge { right: 1px; top: 1px; }
.bar {
  display: flex; align-items: center; gap: 2px; height: 44px; padding: 0 6px; width: max-content;
  background: var(--surface); border-radius: 22px; user-select: none; -webkit-user-select: none;
}
.bar .drag { width: 22px; height: 32px; display: grid; place-items: center; color: var(--faint); cursor: grab; touch-action: none; position: relative; }
.bar .drag.dragging { cursor: grabbing; }
.conn { position: absolute; right: 1px; top: 7px; width: 6px; height: 6px; border-radius: 3px; background: var(--ok); box-shadow: 0 0 0 2px var(--surface); }
.conn.off { background: var(--warn); }
.tb {
  position: relative; width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; color: var(--muted);
  transition: background-color 150ms ease, color 150ms ease;
}
.tb:hover:not(:disabled) { background: var(--raised-2); color: var(--text); }
.tb[aria-pressed="true"], .tb[aria-expanded="true"] { background: var(--raised-2); color: var(--text); }
.tb.send:not(:disabled) { color: var(--accent-text); }
.tb.send.ready { background: var(--accent); color: var(--on-accent); }
.tb.send.ready:hover { background: var(--accent-hover); color: var(--on-accent); }
.tb .badge { right: -3px; top: -3px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; font-size: 9.5px; line-height: 15px; box-shadow: 0 0 0 2px var(--surface); }
.tb .badge.warn { background: var(--warn); color: #1c1917; }
.tb .badge.bad { background: var(--bad); color: #fff; }
.tb .dot { position: absolute; right: 6px; top: 6px; width: 7px; height: 7px; border-radius: 4px; box-shadow: 0 0 0 2px var(--surface); }
.dot.pending { background: var(--pending); } .dot.pass { background: var(--ok); } .dot.drift { background: var(--warn); } .dot.fail { background: var(--bad); }
.sep { width: 1px; height: 18px; margin: 0 4px; background: var(--line-strong); flex: none; }

/* ---------------------------------------------------------------- popover */
.pop {
  width: var(--w, 340px); max-height: var(--max-h, 640px); display: flex; flex-direction: column; min-height: 0;
  background: var(--surface); border-radius: 12px; overflow: hidden;
  animation: pop-in 150ms ease both;
}
.sheet .pop { border-radius: 14px 14px 0 0; }
@keyframes pop-in { from { opacity: 0; transform: translateY(3px) scale(0.985); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .pop { animation: none; } }
.pop-head { flex: none; padding: 10px 10px 8px 12px; display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid var(--line); }
.title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.title-row h2 { font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
.title-row .label { flex: 1; min-width: 0; font: 600 12.5px/1.3 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iconbtn { flex: none; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; color: var(--muted); transition: background-color 150ms ease, color 150ms ease; }
.iconbtn:hover:not(:disabled) { background: var(--raised-2); color: var(--text); }
.pop-body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 4px; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.pop-foot { flex: none; display: flex; align-items: center; gap: 6px; padding: 8px 10px 8px 12px; border-top: 1px solid var(--line); }
.foot { display: flex; align-items: center; gap: 6px; }
.count { color: var(--faint); font-weight: 500; font-variant-numeric: tabular-nums; }

.crumbs { display: flex; align-items: center; flex-wrap: nowrap; gap: 0; min-width: 0; overflow: hidden; color: var(--faint); font-size: 11px; }
.crumbs > * { flex: none; }
/* The nearest ancestors stay in view; the far end is cut, faded. */
.crumbs { justify-content: flex-end; -webkit-mask-image: linear-gradient(to right, transparent, #000 20px); mask-image: linear-gradient(to right, transparent, #000 20px); }
.crumbs .chev { opacity: 0.6; }
.crumb { padding: 1px 4px; border-radius: 5px; color: var(--faint); font: 450 11px/1.4 var(--mono); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb:hover { background: var(--raised-2); color: var(--text); }
.crumb[aria-current="true"] { color: var(--muted); }

.source {
  flex: none; display: inline-flex; align-items: center; gap: 5px; max-width: 160px; height: 22px; padding: 0 8px; border-radius: 11px;
  background: var(--raised); color: var(--text); font: 500 11px/1 var(--mono); white-space: nowrap; border: 1px solid var(--line);
}
.source .file { overflow: hidden; text-overflow: ellipsis; }
.source .dot { width: 6px; height: 6px; border-radius: 3px; flex: none; background: var(--ok); }
.source.file-level .dot { background: var(--warn); }
.source.candidates .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--warn); }
.source.unknown { color: var(--faint); font-family: var(--sans); }
.source .level { color: var(--faint); font-family: var(--sans); font-size: 10.5px; }

/* Scope row: state, media, apply to. */
.scope { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); flex: none; }
.scope-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px; background: var(--raised); min-width: 0; }
.seg button { height: 22px; padding: 0 8px; border-radius: 6px; color: var(--muted); font-size: 12px; font-weight: 500; white-space: nowrap; transition: background-color 150ms ease, color 150ms ease; }
.seg button:hover:not(:disabled) { color: var(--text); }
.seg button[aria-pressed="true"] { background: var(--raised-2); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.seg button:focus-visible { outline-offset: -2px; }
.seg.states { display: flex; width: 100%; }
.seg.states button { position: relative; flex: 1 1 auto; padding: 0 4px; }
.seg.states .pseudo { font-family: var(--mono); font-size: 11px; }
.seg.states .has::after { content: ""; position: absolute; top: 3px; right: 3px; width: 4px; height: 4px; border-radius: 2px; background: var(--accent); }
.seg.icons button { width: 28px; padding: 0; display: grid; place-items: center; }
.showing-line { display: flex; align-items: center; gap: 6px; font-size: 11.5px; min-width: 0; color: var(--muted); }
.chip.showing { flex: none; white-space: nowrap; }
.chip.showing b, .chip.state { font-family: var(--mono); font-size: 11px; font-weight: 600; }
select, .input {
  height: 26px; min-width: 0; width: 100%; padding: 0 8px; border: 1px solid transparent; border-radius: 7px; background: var(--raised); color: var(--text);
  transition: border-color 150ms ease, background-color 150ms ease;
}
select { padding-right: 4px; font-size: 12px; }
select:hover, .input:hover { background: var(--raised-2); }
select:focus, .input:focus { border-color: var(--accent); background: var(--raised); }
.input::placeholder, textarea::placeholder { color: var(--faint); }
.scope select { width: auto; flex: 1; }
.scope .lbl { color: var(--faint); font-size: 11.5px; white-space: nowrap; }

/* Groups of the inspector. */
.group { padding: 8px 0 6px; display: flex; flex-direction: column; gap: 6px; }
.group + .group { border-top: 1px solid var(--line); }
.gtitle { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.gtitle .aside { margin-left: auto; color: var(--faint); font-weight: 450; letter-spacing: 0; }
.fw { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.fw > .seg { align-self: flex-start; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
.f {
  position: relative; display: flex; align-items: center; height: 26px; min-width: 0; border-radius: 7px; background: var(--raised);
  border: 1px solid transparent; transition: border-color 150ms ease, background-color 150ms ease;
}
.f:hover { background: var(--raised-2); }
.f:focus-within { border-color: var(--accent); background: var(--raised); }
.f.edited { box-shadow: inset 2px 0 0 var(--accent); }
.f.invalid { border-color: var(--bad); }
.f .k { flex: none; min-width: 22px; padding: 0 0 0 8px; color: var(--faint); font-size: 11px; white-space: nowrap; }
.f input { flex: 1; min-width: 0; height: 100%; padding: 0 8px 0 6px; border: 0; background: transparent; font: 450 12px/1 var(--mono); }
.f select { height: 100%; background: transparent; border: 0; padding: 0 4px 0 6px; font: 450 12px/1 var(--mono); }
.f .sw { flex: none; position: relative; width: 16px; height: 16px; margin-left: 6px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--line-strong); overflow: hidden;
  background-image: linear-gradient(45deg, #999 25%, transparent 25%, transparent 75%, #999 75%), linear-gradient(45deg, #999 25%, transparent 25%, transparent 75%, #999 75%);
  background-size: 6px 6px; background-position: 0 0, 3px 3px; background-color: #ddd; }
.f .sw i { position: absolute; inset: 0; }
.f .sw input[type="color"] { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; padding: 0; border: 0; }
.msg { color: var(--bad); font-size: 11.5px; line-height: 1.4; padding: 2px 2px 0; }
.msg.warn { color: var(--warn); }

/* Box model. */
.boxm { position: relative; border-radius: 9px; padding: 22px 30px; background: var(--raised); border: 1px dashed var(--line-strong); }
.boxm .tag { position: absolute; left: 8px; top: 4px; font-size: 10px; color: var(--faint); letter-spacing: 0.02em; }
.boxm .pad { position: relative; padding: 22px 30px; border-radius: 7px; background: var(--accent-soft); border: 1px solid var(--line); }
.boxm .core { height: 26px; border-radius: 5px; background: var(--raised-2); display: grid; place-items: center; color: var(--muted); font: 450 11px/1 var(--mono); }
.boxm .bi { position: absolute; width: 40px; height: 18px; border: 1px solid transparent; border-radius: 5px; background: transparent; text-align: center; font: 500 11px/1 var(--mono); color: var(--text); padding: 0 2px; }
.boxm .bi:hover { background: var(--raised-2); }
.boxm .bi:focus { border-color: var(--accent); background: var(--solid); }
.boxm .bi.edited { color: var(--accent-text); font-weight: 650; }
.boxm .bi.invalid { border-color: var(--bad); }
.boxm .t { top: 2px; left: 50%; transform: translateX(-50%); }
.boxm .b { bottom: 2px; left: 50%; transform: translateX(-50%); }
.boxm .l { left: -6px; top: 50%; transform: translateY(-50%); width: 38px; }
.boxm .r { right: -6px; top: 50%; transform: translateY(-50%); width: 38px; }
.boxm > .t, .boxm > .b { }
.boxm > .l { left: -4px; } .boxm > .r { right: -4px; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 8px; background: var(--raised); color: var(--text); font-weight: 500; font-size: 12.5px; white-space: nowrap;
  border: 1px solid var(--line); transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
}
.btn:hover:not(:disabled) { background: var(--raised-2); }
.btn.on { background: var(--accent-soft); border-color: transparent; color: var(--accent-text); }
.btn.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.quiet { border-color: transparent; background: transparent; color: var(--muted); padding: 0 8px; }
.btn.quiet:hover:not(:disabled) { color: var(--text); background: var(--raised-2); }
.btn.danger:hover:not(:disabled) { color: var(--bad); background: var(--bad-soft); border-color: transparent; }
.btn.sm { height: 24px; padding: 0 8px; font-size: 12px; border-radius: 7px; }
.btn .icon { width: 14px; height: 14px; }
.row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.row.wrap { flex-wrap: wrap; }
.hint { color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); padding: 10px 0; font-size: 12.5px; line-height: 1.5; }

details.all > summary {
  cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; padding: 8px 0 6px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
}
details.all > summary::-webkit-details-marker, details > summary::-webkit-details-marker { display: none; }
details.all > summary .icon { transition: transform 150ms ease; width: 12px; height: 12px; }
details.all[open] > summary .icon { transform: rotate(90deg); }
details > summary { cursor: pointer; list-style: none; color: var(--muted); font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
details.sub > summary::before { content: ""; width: 0; height: 0; border: 4px solid transparent; border-left-color: currentColor; margin-left: 2px; }
details.sub[open] > summary::before { transform: rotate(90deg) translate(2px, -2px); }
details > summary + * { margin-top: 6px; }

.props { display: flex; flex-direction: column; }
.rule + .rule { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--line); }
.rule-head { display: flex; align-items: baseline; gap: 8px; padding-bottom: 2px; font-size: 11px; color: var(--faint); }
.rule-head .sel { font-family: var(--mono); color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-head .where { margin-left: auto; flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prop { display: grid; grid-template-columns: minmax(0, 44%) minmax(0, 1fr); align-items: center; column-gap: 6px; }
.prop .name { font: 450 11.5px/1.4 var(--mono); color: var(--accent-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prop input {
  width: 100%; min-width: 0; height: 24px; padding: 0 6px; border: 1px solid transparent; border-radius: 6px; background: transparent;
  font: 450 11.5px/1 var(--mono);
}
.prop input:hover { background: var(--raised); }
.prop input:focus { border-color: var(--accent); background: var(--raised); }
.prop.edited input { background: var(--accent-soft); }
.prop input[aria-invalid="true"] { border-color: var(--bad); }
.prop .msg { grid-column: 1 / -1; }
.section-title { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; color: var(--muted); margin: 6px 0 2px; }
.add { display: grid; grid-template-columns: minmax(0, 44%) minmax(0, 1fr) auto; gap: 6px; position: relative; margin-top: 6px; }
.add .input { font: 450 11.5px/1 var(--mono); }
.suggest { grid-column: 1 / -1; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--solid); padding: 3px; max-height: 172px; overflow: auto; }
.suggest li { padding: 3px 7px; border-radius: 5px; font: 450 11.5px/1.5 var(--mono); cursor: pointer; }
.suggest li[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-text); }

/* Changes. */
.tray { display: flex; flex-direction: column; gap: 6px; }
.target-group { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; }
.target-group + .target-group { border-top: 1px solid var(--line); }
.tg-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tg-head .label { flex: 1; min-width: 0; font: 600 12px/1.3 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tg-head button.label { text-align: left; }
.tg-head button.label:hover { color: var(--accent-text); }
.num {
  flex: none; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; color: #fff; background: var(--pending);
  font: 650 10.5px/20px var(--sans); text-align: center; font-variant-numeric: tabular-nums;
}
.num[data-pin-status="draft"] { background: var(--accent); }
.num[data-pin-status="pass"] { background: #16a34a; } .num[data-pin-status="drift"] { background: #d97706; } .num[data-pin-status="fail"] { background: #dc2626; }
.num.page { background: var(--raised-2); color: var(--muted); }
.item { border-radius: 9px; background: var(--raised); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0; border: 1px solid transparent; }
.item.detached { border-color: var(--warn); }
.item-head { display: flex; align-items: flex-start; gap: 6px; min-width: 0; }
.item-head .change { flex: 1; }
.item-head .label { flex: 1; min-width: 0; font: 600 11.5px/1.4 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-head .iconbtn { width: 22px; height: 22px; margin: -2px -4px 0 0; }
.change { font: 450 12px/1.45 var(--mono); overflow-wrap: anywhere; min-width: 0; }
.change .p { color: var(--accent-text); }
.change .st { font-weight: 650; }
.change del { color: var(--faint); text-decoration: line-through; }
.change ins { text-decoration: none; font-weight: 650; }
.change.note-line { font-family: var(--sans); font-size: 12.5px; white-space: pre-wrap; }
.change.note-line .p { font-family: var(--mono); font-size: 11.5px; }
.shared { color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.chips .source { height: 20px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-height: 20px; padding: 1px 8px; border-radius: 10px;
  background: var(--raised-2); color: var(--muted); font-size: 11.5px; text-align: left;
}
button.chip:hover { color: var(--text); }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.bad { background: var(--bad-soft); color: var(--bad); }
.chip.ok { background: var(--ok-soft); color: var(--ok); }
.chip.info { background: var(--accent-soft); color: var(--accent-text); }
.chip .caret { width: 0; height: 0; border: 3.5px solid transparent; border-top-color: currentColor; margin-top: 3px; flex: none; }
.chip[aria-expanded="true"] .caret { transform: rotate(180deg); margin-top: -3px; }
.effects { display: flex; flex-direction: column; gap: 0; border-left: 2px solid var(--line-strong); padding-left: 8px; }
.effect { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; align-items: center; padding: 4px 0; }
.effect + .effect { border-top: 1px solid var(--line); }
.effect .what { min-width: 0; display: flex; flex-direction: column; font-size: 12px; }
.effect .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.effect .who b { font: 600 11px/1.4 var(--mono); color: var(--text); }
.effect .how { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; font-size: 11.5px; cursor: pointer; }
.check input { width: 13px; height: 13px; margin: 0; accent-color: var(--bad); }
.item .note { height: 26px; font-size: 12px; }
.notebox { display: flex; flex-direction: column; gap: 6px; padding: 8px 0 2px; border-top: 1px solid var(--line); }
textarea.notes {
  width: 100%; min-height: 56px; resize: vertical; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; background: var(--raised);
  font: 13px/1.45 var(--sans); color: var(--text); transition: border-color 150ms ease;
}
textarea.notes:hover { background: var(--raised-2); }
textarea.notes:focus { border-color: var(--accent); background: var(--raised); }
.notice { padding: 9px 11px; border-radius: 9px; background: var(--ok-soft); color: var(--ok); display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; margin-top: 8px; }
.notice.plain { background: var(--raised); color: var(--text); }
.notice .row { justify-content: space-between; align-items: flex-start; }
textarea.prompt { width: 100%; height: 120px; resize: vertical; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--raised); font: 11px/1.45 var(--mono); }

/* Shifts. */
.cls { display: flex; align-items: baseline; gap: 10px; padding: 10px 0 4px; }
.cls .value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.cls .value.good { color: var(--ok); } .cls .value.mid { color: var(--warn); } .cls .value.poor { color: var(--bad); }
.alert { padding: 9px 11px; border-radius: 9px; background: var(--bad-soft); color: var(--bad); font-size: 12.5px; margin-top: 8px; }
.issue { border-radius: 9px; background: var(--raised); padding: 9px 10px; display: flex; flex-direction: column; gap: 5px; min-width: 0; border: 1px solid transparent; transition: border-color 150ms ease; }
.issue:hover, .issue:focus-within { border-color: var(--line-strong); }
.issue-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.issue-head .score { font-weight: 650; font-variant-numeric: tabular-nums; }
.issue-head .conf { margin-left: auto; color: var(--faint); white-space: nowrap; font-size: 11.5px; }
.issue-who { display: flex; align-items: center; gap: 8px; min-width: 0; }
.issue-who .who { font: 600 12px/1.3 var(--mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.evidence { color: var(--muted); display: flex; flex-direction: column; gap: 1px; font-size: 12px; }
.evidence li { overflow-wrap: anywhere; padding-left: 10px; text-indent: -10px; }
.evidence li::before { content: "- "; color: var(--faint); }
.victims { color: var(--muted); overflow-wrap: anywhere; font-size: 12px; }
.victims b { font: 600 11px/1.4 var(--mono); color: var(--text); }
.stack { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; }
details.sub { padding-top: 8px; }

/* Verify. */
.checks { display: flex; flex-direction: column; gap: 4px; border-left: 2px solid var(--line-strong); padding-left: 8px; }
.checkrow { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 6px; align-items: baseline; font-size: 12px; }
.checkrow .detail { font: 450 11px/1.4 var(--mono); overflow-wrap: anywhere; color: var(--muted); }

/* Settings. */
.setting { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; }
.setting + .setting { border-top: 1px solid var(--line); }
.keys { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-size: 12px; color: var(--muted); padding: 8px 0; border-top: 1px solid var(--line); }
kbd { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 5px; background: var(--raised-2); color: var(--text); font: 500 11px/18px var(--sans); text-align: center; }
.project { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
`
