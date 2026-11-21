# cls-corpus

Labelled test pages for primp's layout-shift attribution. Every page produces the same layout shifts on every load, and an `expected.json` beside it says what caused them: the cause class, the culprit element, its file and line, and the elements that move.

The corpus is dependency-free: static HTML, a few generated assets, one self-hosted font and a small Node server. Nothing is fetched from the network.

## Run it

```
node fixtures/cls-corpus/server.mjs                # free port, prints the URL
PORT=4310 node fixtures/cls-corpus/server.mjs      # fixed port
```

`server.mjs` also exports `startServer({ port, host })`, which returns `{ url, port, close }`, for use from tests.

Two routes:

| Route | Response |
|---|---|
| `/<path>` | The static file. A directory serves its `index.html`. |
| `/delay/<ms>/<path>` | The same file, but the response starts `<ms>` milliseconds after the request arrived (capped at 30 s). |

Every response carries `Cache-Control: no-store`, so every load is a cold load. Range requests are answered, because `<video>` uses them.

The delay route is what makes the shifts deterministic. First contentful paint happens about 16 ms after navigation on these pages; every late resource arrives 500 ms or later. The page has always painted before the late thing arrives, and the late thing always arrives at the same offset.

## Check it

Run both from the repo root. They use `@playwright/test` from the root install, so they need the corpus to be inside the repo.

```
node fixtures/cls-corpus/scripts/validate.mjs          # exit 0 when every page matches its labels
node fixtures/cls-corpus/scripts/probe.mjs             # exit 0 when Chromium behaves as documented below
```

`validate.mjs` loads every page in headless Chromium at 1280x800, three times, each time in a fresh browser context, with a plain `PerformanceObserver({ type: 'layout-shift', buffered: true })` installed before any page script. It then checks, on every load:

- **Positive page**: each expected shift is matched by its own entry with `hadRecentInput` false, `value >= minValue`, and every victim selector among `entry.sources` nodes. The number of entries equals `entryCount`. `culpritInSources` matches what the browser reported.
- **Negative page**: no entries, or only entries with `hadRecentInput` true.
- **Every page**: the `assertAfter` expressions are true at the end, so a page cannot pass because its late content never arrived. The tab was visible. `culpritLine` and `triggerLine` point at the line that contains the snippet in `...LineContains`. Each culprit selector matches exactly one element.
- **Independent of the layout-shift API**: every victim and every `alsoMoves` element is at least 3px away from where it was at `DOMContentLoaded`.

Options: `--only <text>`, `--loads <n>`, `--verbose` (print every entry and its sources), `--write` (record measured values), `--fix-lines` (recompute line numbers from the snippets), `--headed`.

## Pages

Measured with Chromium 159.0.8154.6 headless, macOS arm64, 1280x800. Values were identical on 10 consecutive cold loads of every page.

| Page | Cause | Culprit | Culprit line | Measured value |
|---|---|---|---|---|
| `unsized-media/img-block` | unsized-media | `#hero` | `index.html:22` opening tag | 0.105465 |
| `unsized-media/video-metadata` | unsized-media | `#clip` | `index.html:22` opening tag | 0.110461 |
| `unsized-media/iframe-autoheight` | unsized-media | `#embed` | `index.html:22` opening tag | 0.072949 |
| `unsized-media/img-in-flex` | unsized-media | `#portrait` | `index.html:27` opening tag | 0.113916 |
| `unsized-media/img-in-grid` | unsized-media | `#card-2-img` | `index.html:30` opening tag | 0.051795 |
| `font-swap/heading` | font-swap | `#title` | `index.html:21` opening tag | 0.014492 |
| `font-swap/nav` | font-swap | `#nav` | `index.html:22` opening tag | 0.138026 |
| `font-swap/paragraph` | font-swap | `#lead` | `index.html:23` opening tag | 0.016611 |
| `font-swap/sidebar-external-css` | font-swap | `#side-nav` | `index.html:24` opening tag | 0.025271 |
| `font-swap/fontface-api` | font-swap | `#pull-quote` | `index.html:24` opening tag | 0.006064 |
| `injected-content/banner-innerhtml` | injected-content | `#promo-banner` | `index.html:38` script line | 0.039319 |
| `injected-content/cookie-bar-insertbefore` | injected-content | `#cookie-bar` | `consent.js:18` script line | 0.028371 |
| `injected-content/notice-display-flip` | injected-content | `#service-notice` | `index.html:24` opening tag | 0.036523 |
| `injected-content/feed-prepend` | injected-content | `#new-post` | `index.html:42` script line | 0.057305 |
| `injected-content/skeleton-replace` | injected-content | `#weather-panel` | `index.html:44` script line | 0.046143 |
| `multi/two-causes` | unsized-media, then injected-content | `#hero`, `#sidebar-ad` | `index.html:27`, `index.html:55` | 0.072000, 0.029832 |
| `multi/font-then-banner` | font-swap, then injected-content | `#title`, `#promo-banner` | `index.html:23`, `index.html:37` | 0.010117, 0.039816 |
| `negative/transform-animation` | none | | | 0 entries |
| `negative/user-click-insert` | none | | | 1 entry, `hadRecentInput` true (0.052158) |
| `negative/below-fold-insert` | none | | | 0 entries |
| `negative/reserved-space` | none | | | 0 entries |
| `negative/fixed-overlay-insert` | none | | | 0 entries |

Five pages per cause, two pages with two shifts, five negatives. `expected.json` is the source of truth; this table is a summary. Each `notes` field explains what the page is for.

## expected.json

```jsonc
{
  "page": "font-swap/heading/index.html",   // path from the corpus root
  "positive": true,                          // false: must not be reported as a layout-shift problem
  "observeMs": 2000,                         // how long the validator watches the page
  "entryCount": 1,                           // layout-shift entries without recent input, per load
  "shifts": [
    {
      "cause": "font-swap",                  // "unsized-media" | "font-swap" | "injected-content"
      "culpritSelector": "#title",           // the element that CAUSED the shift
      "culpritFile": "font-swap/heading/index.html",
      "culpritLine": 21,
      "culpritLineKind": "opening-tag",      // or "script-insert", see below
      "culpritLineContains": "<h1 id=\"title\"",   // unique snippet on that line; keeps the number honest
      "culpritInSources": false,             // is the culprit itself among entry.sources?
      "triggerFile": "font-swap/heading/index.html",   // optional second location, see below
      "triggerLine": 9,
      "triggerLineContains": "@font-face { font-family: \"Press Start 2P\"",
      "victimSelectors": ["#content"],       // must appear among entry.sources nodes
      "alsoMoves": ["#p1", "#p2"],           // move too, but need not be in entry.sources (cap, containment)
      "minValue": 0.006,                     // conservative lower bound of entry.value
      "measuredValues": [0.014492, 0.014492, 0.014492],   // written by validate.mjs --write
      "measuredSources": [ { "node": "div#content", "previousRect": {}, "currentRect": {} } ]
    }
  ],
  "interactions": [{ "afterMs": 600, "click": "#show-fares" }],   // only on user-click-insert
  "minEntriesWithRecentInput": 1,            // negative pages: the excused entry must really occur
  "assertAfter": ["document.fonts.check('40px \"Press Start 2P\"')"],   // must be true at the end
  "notes": "...",
  "measured": { "browser": "...", "platform": "...", "viewport": "1280x800", "entriesPerLoad": [] }
}
```

How culprits are labelled:

- `culpritSelector` is the element whose arrival, growth or appearance moved other content: the `<img>`, the element set in the web font, the inserted banner.
- `culpritLineKind: "opening-tag"`: the culprit is written in the HTML and `culpritLine` is the line of its opening tag.
- `culpritLineKind: "script-insert"`: the culprit does not exist in the HTML; `culpritLine` is the script line that puts it in the document (`innerHTML =`, `insertBefore`, `appendChild`, `insertAdjacentHTML`, `replaceChildren`). `culpritFile` is then the file that holds that script, which for `cookie-bar-insertbefore` is `consent.js`, not the page.
- `triggerFile` / `triggerLine` name a second line when the element and the thing that sets it off are in different places: the `@font-face` rule for a font swap (in `fonts.css` on `sidebar-external-css`), `document.fonts.add(...)` on `fontface-api`, the line that sets `display: block` on `notice-display-flip`, the line that sets the iframe height on `iframe-autoheight`. A tool that reports either line has found the problem.
- `minValue` is roughly half of the measured value (40% on font pages, whose fallback metrics vary between platforms).

Late scripts and stylesheets are requested through `/delay/<ms>/...`, so the URL the browser sees for `consent.js` has a `/delay/700` prefix that is not part of the file's path on disk.

## How the Layout Instability API behaves

Everything in this section was observed in Chromium 159 headless. Each numbered item is asserted by a probe in `scripts/probe.mjs` or by a corpus page, named in brackets. Statements that were not measured are marked as such.

### What an entry is

1. **One entry per animation frame, not per cause.** Two unrelated mutations in the same task produce one entry whose `sources` mix both sets of victims; the same mutations 150 ms apart produce two entries. [probes "one entry per animation frame"] An entry is therefore not a unit of blame. The corpus pages keep their causes at least 800 ms apart; a page where two causes land in the same frame is not in the corpus because it could not be made deterministic.
2. **`value` = impact fraction x distance fraction.** Impact fraction is the area of the union of every moved node's before and after rects, clipped to the viewport, over the viewport area. Distance fraction is the largest move of any single node in that frame (the larger of its horizontal and vertical move) over the larger viewport dimension (1280 here). [probes "value"] There is one distance for the whole entry: a 100x50 box that moves 400px sets the distance for a large box that moved 40px in the same frame. This is why `font-swap/nav` scores 0.138 while `font-swap/heading` scores 0.014, although the page content moves down by a similar amount (40px and 56px): one nav link wrapped and travelled 428px.
3. **A move under 3 CSS px is ignored; 3px is reported.** [probes "threshold"]
4. **Only a move of the start corner counts.** An element that grows or shrinks in place is not a shift and is not a source. [probe "size change"]

### What `sources` contains

5. **At most 5 sources, the largest by area, largest first.** With 12 moved siblings the five largest are listed in descending order. [probe "cap"; pages `font-swap/nav`, `injected-content/feed-prepend`] The entry `value` still accounts for all moved nodes, so the rects in `sources` do not add up to the value when the cap was hit.
6. **A moved container hides its moved descendants.** If a wrapper and its children all move, only the wrapper is listed; a source whose rects enclose another's replaces it. Without a moved wrapper the children are listed one by one and compete for the five slots. [probes "dedup"; most pages report `#content` and none of its paragraphs] The reported node is therefore the outermost moved box, which is usually not the element a developer would name and never says anything about what is inside it.
7. **The culprit is never in `sources` on these pages.** `culpritInSources` is false for all 19 labelled shifts. The image, the heading, the banner grow or appear; they do not move. Attribution has to come from somewhere else: the DOM position just before the first victim, resource timing, mutation records, font events.
8. **Newly inserted elements and elements that flip from `display: none` are not sources.** [pages under `injected-content/`, `negative/fixed-overlay-insert`]
9. **`source.node` can be null from the start.** On `unsized-media/video-metadata`, four of the five sources are parts of the built-in media controls. They live in a user-agent shadow tree, so `node` is null, and they take four of the five slots. The real victim (`#transcript`) is still listed because it is the largest.
10. **`source.node` becomes null when the node is removed later.** The same entry object read after the node was removed from the document returns null. [probe "later removed"] Read and resolve nodes when the entry is delivered, not afterwards.
11. **Text that moves without a box of its own is reported as a text node** (`nodeType` 3), and its `previousRect` and `currentRect` are then the same full-line-width strip: the rects do not show the move, though the entry `value` uses the real distance. [probe "text that moves"] Measure text with a `Range` if the delta is needed.
12. **Rects are in viewport CSS pixels and clipped to the viewport.** A box that is pushed partly below the fold has a shorter `currentRect`. [probe "value: ... clipped"; `img-block` reports `[240,419 800x381]` for a box that is really 432px tall] A rect diff made with `getBoundingClientRect()` will not equal the source rects for clipped nodes.

### What is and is not a shift

13. **Transforms.** Changing an element's `transform` (animation, transition or direct style) produces no entry, even though `getBoundingClientRect()` changes. [probe "changing only the transform"; page `negative/transform-animation`] Changing `top`/`left` of a positioned element does. [probe "top/left"] When a node moves by layout under a transformed ancestor, rects and value are in visual, post-transform pixels: under `scale(0.5)` a 200px layout move is reported as 100px. [probe "transform on an ancestor"]
14. **Moves that stay outside the viewport are not reported.** [page `negative/below-fold-insert`]
15. **Scroll anchoring.** On a scrolled page, content inserted above the viewport does not shift it: the browser adjusts `scrollY` and nothing is reported. At scroll position 0 the same insertion is a shift. [probes "scroll anchoring"] All corpus pages are measured unscrolled.
16. **`visibility: hidden` and `opacity: 0` nodes that move are not reported; `opacity: 0.5` nodes are.** [probes]
17. **`hadRecentInput`.** A shift within 500 ms of a click is still delivered to the observer, with `hadRecentInput` true; 300 ms after the click it is flagged, 800 ms after it is not. Mouse movement alone does not flag anything. [probes "hadRecentInput"; page `negative/user-click-insert`] Filter on the flag; do not expect silence.
18. **Subframes.** A shift inside an iframe is delivered only to an observer inside that iframe, and its value is computed against the iframe's own viewport, not weighted by the iframe's share of the page. [probe "subframe"] An iframe that is resized by its parent (`unsized-media/iframe-autoheight`) is an ordinary shift on the parent.
19. **`buffered: true` works.** An observer created after the shift still receives it. [probe "buffered"] Not measured: the size of that buffer (the specification says 150 entries).

### Timing evidence

Measured once per page with `PerformanceResourceTiming` and DOM events:

| Page | Late resource `responseEnd` | Related event | Shift `startTime` |
|---|---|---|---|
| `unsized-media/img-block` | img 710.0 ms | `img.load` 712.2 | 711.3 |
| `unsized-media/video-metadata` | video 710.2 | `loadedmetadata` 713.1 | 720.9 |
| `unsized-media/iframe-autoheight` | iframe 708.5 | `iframe.load` and attribute mutation 715.1 | 721.5 |
| `font-swap/heading` | font (initiator `css`) 715.8 | `document.fonts` `loadingdone` 718.8 | 718.2 |
| `font-swap/fontface-api` | font (initiator `css`) 707.8 | no `loadingdone` event | 721.3 |
| `injected-content/banner-innerhtml` | fetch 711.6 | childList mutation 713.4 | 716.2 |
| `injected-content/cookie-bar-insertbefore` | script 710.3 | childList mutation 711.2 | 711.5 |
| `multi/two-causes` | img 510.1, fetch 1308.2 | `img.load` 511.4, childList mutation 1309.0 | 510.9, 1309.5 |

- The shift's `startTime` followed the late resource's `responseEnd` by 1 to 14 ms in these runs. It is the time of the frame, so a related event can carry a timestamp slightly after it (`img.load` at 712.2 for a shift at 711.3).
- `document.fonts` fires no `loadingdone` when a face is loaded with `new FontFace().load()` and added afterwards. The font request still shows up in resource timing.
- `notice-display-flip` and `iframe-autoheight` produce attribute mutations only; a `childList` observer sees nothing.

### What this means for the attribution engine

- Treat `sources` as "some of the outermost boxes that moved". Find the culprit by looking at what sits immediately before the first victim in layout order and what changed there (size, presence, font) in the same frame.
- Never read a missing culprit in `sources` as "no culprit", and never read a null `node` as an error.
- Do not use DOM mutations alone as evidence: `negative/fixed-overlay-insert` and `negative/below-fold-insert` perform the same insertions as the positive pages.
- Do not use rect diffs alone as evidence: `negative/transform-animation` moves three elements on screen.
- Keep per-entry blame separate: on `multi/font-then-banner` the same text is moved by two different culprits 800 ms apart.
- Report `hadRecentInput` entries as excused, not as problems, and not as absent.

## Limits

- **One browser, one platform.** All values and `measuredSources` rects were recorded on macOS arm64 with Chromium 159 headless. The pages that use `system-ui` or the Arial fallback wrap text differently on Linux, which changes rects and values. `minValue` leaves room for that, but the corpus has not been run on Linux or in headed Chrome. The font-swap pages are the most exposed: their "before" state is the platform's fallback font.
- **`font-swap/paragraph`** measures two lines before the swap with a text that is close to needing three. A platform with a wider fallback would show a smaller shift (still above `minValue` by estimate, not by measurement).
- **Not covered**: two causes in the same frame, cross-origin iframes, shifts after scrolling, late CSS, a hidden tab (the validator only checks that `document.visibilityState` was `visible` at the start and end of each load), and real third-party embeds.
- **Hand-built pages.** These are clean, single-purpose pages. They say nothing about how attribution performs on real templates; the plan's held-out set is for that.

## Assets and licences

| File | Origin | Licence |
|---|---|---|
| `assets/fonts/press-start-2p-latin-400-normal.woff2` | Press Start 2P, latin subset, unmodified from the npm package `@fontsource/press-start-2p` 5.3.0 | SIL Open Font License 1.1, copyright 2012 The Press Start 2P Project Authors; full text in `assets/fonts/OFL.txt` |
| `assets/img/*.png` | Generated by `scripts/make-assets.mjs` (gradients written with Node's zlib) | MIT, as the rest of the repo |
| `assets/video/clip-640x360.webm` | Generated by `scripts/make-assets.mjs` with ffmpeg's `testsrc2` pattern, VP8, one second | MIT, as the rest of the repo |
| `assets/data/*.json` | Hand-written | MIT, as the rest of the repo |

Press Start 2P was chosen because every glyph is one em wide, about twice the width of a sans-serif fallback, so the swap changes line breaks on every platform. The generated files are checked in; `make-assets.mjs` reproduces them byte for byte (ffmpeg is needed only for the video).

## Adding a page

1. Create `<cause>/<name>/index.html`. Give every element that matters an `id`. Serve the late resource through `/delay/<ms>/...` with at least 500 ms, and keep two causes on one page at least 500 ms apart.
2. Write `expected.json` with the labels and `...LineContains` snippets; leave the line numbers at 0.
3. Run `node fixtures/cls-corpus/scripts/validate.mjs --only <name> --verbose --fix-lines` and read the reported sources. Choose `victimSelectors` from the nodes Chromium lists; put other moved elements in `alsoMoves`.
4. Run it with `--loads 10`. If the entry count or the values vary, the page is not deterministic yet.
5. Run `--write`, set `minValue` from the measured value, and add the page to `index.html` and to the table above.
