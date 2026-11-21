/**
 * All of the dock's CSS. Nothing of it is in the page: `HOST_CSS` goes into the shadow root of
 * `<reglet-root>` (the host, the highlight boxes, the frame of the dock) and `DOCK_CSS` into the
 * dock's own document. Both are applied as constructable stylesheets, which work under any
 * Content-Security-Policy.
 */

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
}
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.box {
  position: absolute; left: 0; top: 0; box-sizing: border-box; display: none;
  pointer-events: none; border: 1.5px solid #2f6fed; border-radius: 2px;
}
.box.hover { background: rgb(47 111 237 / 0.10); }
.box.selected { border-width: 2px; }
.box.previous { border: 1.5px dashed #c2410c; }
.box.current { border-color: #c2410c; background: rgb(194 65 12 / 0.10); }
.box.culprit { border: 2px solid #be123c; background: rgb(190 18 60 / 0.08); }
.box span {
  position: absolute; left: -1.5px; top: 0; display: none; padding: 1px 6px; border-radius: 3px;
  background: #2f6fed; color: #fff; white-space: pre; font: 500 11px/1.4 ui-sans-serif, system-ui, sans-serif;
}
.box.previous span, .box.current span { background: #c2410c; }
.box.culprit span { background: #be123c; }
iframe {
  position: absolute; left: 0; top: 0; display: block; border: 0; margin: 0; padding: 0;
  pointer-events: auto; background: transparent; color-scheme: normal;
  border-radius: 12px;
  box-shadow: 0 0 0 1px rgb(15 23 42 / 0.10), 0 10px 30px rgb(15 23 42 / 0.20), 0 2px 6px rgb(15 23 42 / 0.10);
}
iframe.collapsed { border-radius: 22px; }
iframe.settled { transition: transform 140ms ease; }
@media (prefers-reduced-motion: reduce) { iframe.settled { transition: none; } }
`

export const DOCK_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --raised: #f5f6f8; --sunken: #eef0f3; --line: #e1e4ea; --line-strong: #cdd2db;
  --text: #171a21; --muted: #5b6472; --faint: #6b7483;
  --accent: #2456d6; --accent-soft: #e8eefc; --accent-text: #ffffff;
  --ok: #17794a; --ok-soft: #e3f4ea; --warn: #96560a; --warn-soft: #fbf0dc; --bad: #b3261e; --bad-soft: #fbe9e7;
  --focus: #2456d6;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1c21; --raised: #23262d; --sunken: #15171b; --line: #30343d; --line-strong: #444a56;
    --text: #e9ebef; --muted: #a2abb9; --faint: #8d96a5;
    --accent: #8fb0ff; --accent-soft: #263352; --accent-text: #0d1220;
    --ok: #6fd3a0; --ok-soft: #1d3a2c; --warn: #f1bd6c; --warn-soft: #3d3020; --bad: #ff9a8f; --bad-soft: #442522;
    --focus: #8fb0ff;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  overflow: hidden; background: var(--bg); color: var(--text);
  font: 12.5px/1.45 var(--sans); -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; margin: 0; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: 0.5; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-radius: 4px; }
h2, h3, p, ul, ol, dl, dd { margin: 0; padding: 0; }
ul, ol { list-style: none; }
.mono { font-family: var(--mono); font-size: 11.5px; }
.muted { color: var(--muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* Collapsed: the whole dock is one button. */
.launcher {
  width: 100%; height: 100%; border: 0; border-radius: 22px; background: var(--bg); color: var(--text);
  display: grid; place-items: center; position: relative; font-weight: 700; font-size: 15px;
}
.launcher .badge {
  position: absolute; right: 4px; top: 4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: var(--accent); color: var(--accent-text); font-size: 10px; line-height: 16px; font-weight: 650; text-align: center;
}
.launcher:focus-visible { outline-offset: -3px; border-radius: 22px; }

.dock { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.head {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 12px; min-height: 40px;
  cursor: grab; user-select: none; touch-action: none;
}
.head.dragging { cursor: grabbing; }
.brand { font-weight: 700; letter-spacing: 0.01em; }
.conn { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none; }
.conn.off { background: var(--warn); }
.project { flex: 1; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iconbtn {
  flex: none; width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 6px;
  background: transparent; color: var(--muted); font-size: 14px; line-height: 1;
}
.iconbtn:hover { background: var(--raised); color: var(--text); }

.tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--line); }
.tab {
  display: flex; align-items: center; gap: 6px; padding: 7px 10px 6px; border: 0; background: none;
  border-bottom: 2px solid transparent; margin-bottom: -1px; color: var(--muted); font-weight: 600;
}
.tab:hover { color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.pill {
  min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--sunken); color: var(--muted);
  font-size: 10.5px; line-height: 17px; font-weight: 650; text-align: center; font-variant-numeric: tabular-nums;
}
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad { background: var(--bad-soft); color: var(--bad); }

.body { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.foot { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--line); background: var(--bg); }
.foot .grow { flex: 1; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px;
  border: 1px solid var(--line-strong); border-radius: 7px; background: var(--bg); color: var(--text); font-weight: 550; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--raised); }
.btn.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 650; }
.btn.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.btn.quiet { border-color: transparent; background: transparent; color: var(--muted); padding: 0 6px; }
.btn.quiet:hover:not(:disabled) { color: var(--text); background: var(--raised); }
.btn.danger:hover:not(:disabled) { border-color: var(--bad); color: var(--bad); background: var(--bad-soft); }

.row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.row.wrap { flex-wrap: wrap; }
.hint { color: var(--muted); }
.empty { color: var(--muted); padding: 6px 0; }
.alert { padding: 7px 9px; border-radius: 7px; background: var(--bad-soft); color: var(--bad); }
.notice { padding: 8px 10px; border-radius: 8px; background: var(--ok-soft); color: var(--ok); display: flex; flex-direction: column; gap: 6px; }
.notice.plain { background: var(--raised); color: var(--text); }
.notice .row { justify-content: space-between; }

.panel { border: 1px solid var(--line); border-radius: 10px; display: flex; flex-direction: column; min-width: 0; }
.panel > * { padding: 8px 10px; }
.panel > * + * { border-top: 1px solid var(--line); }
.section-title { font-size: 11px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); }

.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; color: var(--faint); }
.crumb { border: 0; background: none; padding: 1px 4px; border-radius: 4px; color: var(--muted); font-family: var(--mono); font-size: 11px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumb:hover { background: var(--raised); color: var(--text); }
.crumb[aria-current="true"] { color: var(--text); font-weight: 650; }
.target { display: flex; align-items: center; gap: 8px; min-width: 0; }
.target .label { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.source {
  flex: none; display: inline-flex; align-items: center; gap: 5px; max-width: 170px; height: 20px; padding: 0 7px; border-radius: 10px;
  background: var(--raised); color: var(--text); font-family: var(--mono); font-size: 11px; white-space: nowrap;
}
.source .file { overflow: hidden; text-overflow: ellipsis; }
.source .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ok); }
.source.file-level .dot { background: var(--warn); }
.source.candidates .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--warn); }
.source.unknown { color: var(--muted); font-family: var(--sans); }
.source .level { color: var(--muted); font-family: var(--sans); font-size: 10.5px; }

.field { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.field > span { font-size: 11px; color: var(--faint); font-weight: 600; }
.seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 7px; overflow: hidden; height: 26px; }
.seg button { border: 0; background: var(--bg); padding: 0 9px; color: var(--muted); font-weight: 550; white-space: nowrap; }
.seg button + button { border-left: 1px solid var(--line-strong); }
.seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.seg button:focus-visible { outline-offset: -2px; }
select, .input {
  height: 26px; min-width: 0; width: 100%; padding: 0 7px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg);
}
select { padding-right: 2px; }

.props { display: flex; flex-direction: column; }
.rule + .rule { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--line); }
.rule-head { display: flex; align-items: baseline; gap: 8px; padding-bottom: 2px; font-size: 11px; color: var(--faint); }
.rule-head .sel { font-family: var(--mono); color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-head .where { margin-left: auto; flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prop { display: grid; grid-template-columns: minmax(0, 42%) minmax(0, 1fr); align-items: center; column-gap: 8px; }
.prop .name { font-family: var(--mono); font-size: 11.5px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prop input {
  width: 100%; min-width: 0; height: 24px; padding: 0 6px; border: 1px solid transparent; border-radius: 5px; background: transparent;
  font-family: var(--mono); font-size: 11.5px;
}
.prop input:hover { border-color: var(--line); }
.prop input:focus { border-color: var(--accent); background: var(--bg); outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
.prop.edited input { background: var(--accent-soft); }
.prop input[aria-invalid="true"] { border-color: var(--bad); box-shadow: 0 0 0 2px var(--bad-soft); }
.prop .msg { grid-column: 1 / -1; color: var(--bad); font-size: 11.5px; padding: 2px 0 4px; }
details > summary { cursor: pointer; color: var(--muted); font-weight: 600; list-style: none; display: flex; align-items: center; gap: 6px; border-radius: 4px; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: ""; width: 0; height: 0; border: 4px solid transparent; border-left-color: currentColor; margin-left: 2px; }
details[open] > summary::before { transform: rotate(90deg) translate(2px, -2px); }
details > summary + * { margin-top: 6px; }

.add { display: grid; grid-template-columns: minmax(0, 43%) minmax(0, 1fr) auto; gap: 6px; position: relative; }
.add .input { font-family: var(--mono); font-size: 11.5px; }
.suggest {
  grid-column: 1 / -1; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--bg); padding: 3px; max-height: 172px; overflow: auto;
}
.suggest li { padding: 3px 7px; border-radius: 4px; font-family: var(--mono); font-size: 11.5px; cursor: pointer; }
.suggest li[aria-selected="true"] { background: var(--accent-soft); color: var(--accent); }

.tray { display: flex; flex-direction: column; gap: 8px; }
.item { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.item.detached { border-color: var(--warn); }
.item-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.item-head .label { flex: 1; min-width: 0; font-family: var(--mono); font-size: 11.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.change { font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }
.change .p { color: var(--accent); }
.change del { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--faint); }
.change ins { text-decoration: none; font-weight: 650; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-height: 20px; padding: 1px 8px; border-radius: 10px; border: 0;
  background: var(--raised); color: var(--muted); font-size: 11.5px; text-align: left;
}
button.chip:hover { color: var(--text); }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.bad { background: var(--bad-soft); color: var(--bad); }
.chip.ok { background: var(--ok-soft); color: var(--ok); }
.chip.info { background: var(--accent-soft); color: var(--accent); }
.chip .caret { width: 0; height: 0; border: 3.5px solid transparent; border-top-color: currentColor; margin-top: 3px; flex: none; }
.chip[aria-expanded="true"] .caret { transform: rotate(180deg); margin-top: -3px; }
.effects { display: flex; flex-direction: column; gap: 2px; border-left: 2px solid var(--line); padding-left: 8px; }
.effect { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; align-items: center; padding: 3px 0; }
.effect + .effect { border-top: 1px solid var(--line); }
.effect .what { min-width: 0; display: flex; flex-direction: column; }
.effect .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.effect .who b { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--text); }
.effect .how { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; }
.check input { width: 13px; height: 13px; margin: 0; accent-color: var(--bad); }
.note { height: 24px; font-size: 12px; border-color: var(--line); }
.note::placeholder, .input::placeholder { color: var(--faint); }
textarea.prompt { width: 100%; height: 120px; resize: vertical; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg); font-family: var(--mono); font-size: 11px; }

.cls { display: flex; align-items: baseline; gap: 10px; }
.cls .value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.cls .value.good { color: var(--ok); } .cls .value.mid { color: var(--warn); } .cls .value.poor { color: var(--bad); }
.issue { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.issue:hover, .issue:focus-within { border-color: var(--line-strong); background: var(--raised); }
.issue-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.issue-head .score { font-weight: 700; font-variant-numeric: tabular-nums; }
.issue-head .conf { margin-left: auto; color: var(--muted); white-space: nowrap; }
.issue-who { display: flex; align-items: center; gap: 8px; min-width: 0; }
.issue-who .who { font-family: var(--mono); font-size: 12px; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.evidence { color: var(--muted); display: flex; flex-direction: column; gap: 1px; }
.evidence li { overflow-wrap: anywhere; padding-left: 10px; text-indent: -10px; }
.evidence li::before { content: "- "; color: var(--faint); }
.victims { color: var(--muted); overflow-wrap: anywhere; }
.victims b { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--text); }
.stack { display: flex; flex-direction: column; gap: 8px; }
.checks { display: flex; flex-direction: column; gap: 3px; border-left: 2px solid var(--line); padding-left: 8px; }
.checkrow { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 6px; align-items: baseline; }
.checkrow .detail { font-family: var(--mono); font-size: 11px; overflow-wrap: anywhere; color: var(--muted); }
`
