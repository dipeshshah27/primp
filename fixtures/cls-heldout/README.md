# cls-heldout

A held-out test set for reglet's layout-shift attribution: sixteen pages that look like real sites, each with an `expected.json` that says what (if anything) shifted, which element caused it and why.

**Do not tune the attribution engine on these pages.** They exist to measure it. The pages were written without reading the engine, the overlay hook, the shift tools, the spikes or the pages of `fixtures/cls-corpus`; only that fixture's server, its validation script and its assets were reused. If a page here exposes a weakness, fix the engine against `fixtures/cls-corpus` (add a page there) and re-measure here.

Folder names, page titles and code comments say nothing about the answer, so a URL or a comment cannot leak it to a tool or an agent. The answers are in `expected.json` and in the table below.

The set is dependency-free: static HTML, a few assets, one self-hosted font and a small Node server. Nothing is fetched from the network.

## Run it

```
node fixtures/cls-heldout/server.mjs                # free port, prints the URL
PORT=4320 node fixtures/cls-heldout/server.mjs      # fixed port
cd fixtures/cls-heldout && PORT=4320 npm run dev    # the same, through package.json
```

`server.mjs` is adapted from `fixtures/cls-corpus/server.mjs` and also exports `startServer({ port, host })`, which returns `{ url, port, close }`.

| Route | Response |
|---|---|
| `/<path>` | The static file. A directory serves its `index.html`. |
| `/delay/<ms>/<path>` | The same file, but the response starts `<ms>` milliseconds after the request arrived (capped at 30 s). |

Every response carries `Cache-Control: no-store`, so every load is a cold load. Late images, fonts, JSON and the embedded player all come through `/delay/`, between 500 and 1200 ms, so the page has always painted before the late thing arrives.

## Check it

Run from the repo root (the script imports `@playwright/test` from the root install). The browser is always headless.

```
node fixtures/cls-heldout/scripts/validate.mjs               # exit 0 when every page meets its requirement
node fixtures/cls-heldout/scripts/validate.mjs --verbose     # also print every entry and its sources
node fixtures/cls-heldout/scripts/validate.mjs --only findry # one page
node fixtures/cls-heldout/scripts/validate.mjs --write       # record measuredValues / measured in expected.json
node fixtures/cls-heldout/scripts/validate.mjs --fix-lines   # recompute culpritLine from the file
node fixtures/cls-heldout/scripts/validate.mjs --observe-ms 12000 --loads 1   # check nothing moves later
```

For every page it does three loads, each in a fresh browser context (cold cache) at 1280x800, with only a plain `new PerformanceObserver(...).observe({ type: 'layout-shift', buffered: true })` installed before any page script, and collects entries for 3 s.

- **Positive page**: the entries without recent input sum to at least `minValue` on every load; their number is the same on every load; one entry carries at least 80% of the sum; at least one victim selector matches a node in the entries' sources; every victim selector is at least 3 px away from where it was at `DOMContentLoaded` (a check that does not use the layout-shift API).
- **Negative page**: no entries, or only entries with `hadRecentInput` true. The click page must produce at least one such entry, so it cannot pass by not moving at all.
- **Every page**: `culpritSelector` and each `acceptableCulpritSelectors` entry match exactly one element at the end of the load; each decoy selector matches at least one element, and none of them is the culprit, an acceptable culprit, or an ancestor or descendant of the culprit; the `assertAfter` expressions are true (the late thing really arrived); no request failed; no page error; the tab was visible.
- **Line labels**: `culpritLine` is computed from the file. `culpritLineContains` must occur on exactly one line of `culpritFile`, and that line number must equal `culpritLine` (`--fix-lines` rewrites it). For `opening-tag` the line must hold an opening tag whose tag name, and id when it has one, equal those of the live element the selector resolves to. For `script-insert` the line must be inside an inline `<script>` and contain a DOM insertion call.

## Pages

Eleven positive pages (exactly one layout-shift entry each) and five negative pages. CLS is the value measured in headless Chromium 159 on macOS arm64 at 1280x800; it was identical on every load.

| Folder | Template | Cause | How | Culprit | CLS |
|---|---|---|---|---|---|
| `news-harbour-ledger` | news article | unsized-media | floated article photo, no width/height, 700 ms | `.story-body > img.story-photo` | 0.0593 |
| `shop-grid-fernhill` | product grid | unsized-media | lazy image in a grid cell spanning two columns, 900 ms | `.card--featured .card-media img` | 0.1141 |
| `profile-relay` | profile page | unsized-media | SVG avatar through `<img>` in a flex header row, 600 ms | `.profile-head > img.avatar` | 0.0581 |
| `recipe-saltwater-kitchen` | recipe page | unsized-media | iframe embed with no reserved height, resized when its document (800 ms) reports its height | `.embed-frame > iframe.video-embed` | 0.0464 |
| `landing-pulsebase` | SaaS landing page with hero | font-swap | big hero headline re-wraps, 800 ms | `.hero h1` | 0.0599 |
| `docs-quillstack` | documentation page with sidebar | font-swap | header navigation wraps onto a second row, 700 ms | `.site-header > nav.topnav` | 0.2481 |
| `dashboard-orderdesk` | dashboard | font-swap | table header cells wrap onto two lines, 750 ms | `#orders > thead > tr` | 0.0088 |
| `blog-grainline` | blog index | injected-content | consent banner, `createElement` + `document.body.prepend()`, after a 700 ms JSON fetch | `body > section.consent` | 0.0484 |
| `product-tidewell` | e-commerce product page | injected-content | recommendation row, `replaceChildren()` into an empty section, after a 900 ms JSON fetch | `#recs-slot > .recs-block` | 0.0631 |
| `search-findry` | search results page | injected-content | notice revealed by `hidden = false`, after a 750 ms JSON fetch | `main > .notice` | 0.0326 |
| `pricing-ledgerly` | pricing page | injected-content | promo strip, `insertAdjacentHTML('afterend')`, after an 800 ms JSON fetch | `body > aside.promo-strip` | 0.0358 |
| `landing-northwind` | SaaS landing page with hero | negative | transform and opacity animations only (entrances, marquee, script-driven carousel, counters) | none | 0 |
| `docs-kiln` | documentation page with sidebar | negative | accordion panel opened by a user click; entries have `hadRecentInput` true | none | 0 (+1 with input) |
| `news-meridian-post` | news article | negative | three late images, all with width/height attributes | none | 0 |
| `dashboard-fleetboard` | dashboard | negative | toast and chat launcher appended late, both `position: fixed` | none | 0 |
| `blog-fieldnotes` | blog index | negative | four posts appended to the end of the list, far below the fold | none | 0 |

Every page also carries innocent things that a naive attribution could accuse; they are listed under `decoys` in its `expected.json` and described in its `notes`. Examples: an image from the same delayed URL at the same moment but with width/height; a script that rewrites text or appends absolutely positioned buttons at the moment of the real shift; a second `@font-face` inlined as a `data:` URL, resolved from `local()` or declared `font-display: optional` (it loads late and is never swapped in); a second insertion at the same moment that lands below the fold.

## expected.json

```
{
  "page": "<folder>/index.html",
  "template": "news article",
  "positive": true,
  "shifts": [
    {
      "cause": "unsized-media" | "font-swap" | "injected-content",
      "culpritSelector": "matches exactly the element that caused the shift",
      "acceptableCulpritSelectors": ["each matches exactly one element that a reasonable person would also accept"],
      "culpritFile": "<folder>/index.html",
      "culpritLine": 145,
      "culpritLineKind": "opening-tag" | "script-insert",
      "culpritLineContains": "text that occurs on exactly that line; culpritLine is computed from it",
      "acceptableCulpritLines": [ { "line": 198, "kind": "...", "contains": "..." } ],
      "victimSelectors": ["elements that visibly move"],
      "minValue": 0.035
    }
  ],
  "decoys": ["selectors of innocent elements"],
  "interaction": null | { "selector": "<css selector to click>", "afterMs": 1000 },
  "minEntriesWithRecentInput": 1,
  "assertAfter": ["JavaScript expressions that must be true at the end of the load"],
  "measuredValues": [0.059257, 0.059257, 0.059257],
  "measured": { "browser": "...", "entriesPerLoad": [...], "dominantEntry": { "value": ..., "startTimeMs": ..., "sources": [...] } },
  "notes": "one or two sentences"
}
```

- A positive page has exactly one object in `shifts`; a negative page has an empty array.
- `culpritSelector` is the image or iframe that grew, the element whose text was re-laid out by the font, or the inserted or revealed element. Some selectors use an id, some are structural, as on real sites.
- `culpritLineKind` is `opening-tag` when the culprit's opening tag is in the HTML (media, font-swapped text, an element revealed by `hidden`), and `script-insert` when the element is created by script (the line is the statement that puts it into the document).
- `acceptableCulpritLines` is an addition to the brief: other lines a tool could reasonably point at. Its `kind` is free text: `reveal-statement`, `resize-statement`, `create-statement`, `markup-in-script`, `fetch-statement`, `container-opening-tag`, `font-face-src`, `font-family-declaration`, `opening-tag`. Each is located by its `contains` snippet in the same way as `culpritLine`.
- `interaction` is `null` or `{ selector, afterMs }`: a real mouse click on `selector`, `afterMs` milliseconds after the window's `load` event. Only `docs-kiln` has one. On that page the click is valid at any time after load; nothing else on the page moves.
- `minEntriesWithRecentInput` exists only on the click page.
- `measuredValues` are the sums of the entries without recent input on the three loads of the last `--write` run. `minValue` is about 60% of that.
- `measured.dominantEntry.sources` is what `entry.sources` held on the first load, for reference. The culprit itself is often not among them.

## Where attribution is legitimately ambiguous

- `recipe-saltwater-kitchen`: the iframe is labelled `unsized-media` (an embed without reserved space), but the growth is applied by a script that sets `style.height` when the embedded document posts its height. Nothing is inserted, so `injected-content` is wrong, but a tool that names the resize statement (listed in `acceptableCulpritLines`) rather than the iframe tag is right about the mechanism.
- `docs-quillstack`: the swap changes six links at once; the label is the `<nav>` that carries the `font-family`, and the `<ul>`, each `<li>`, each `<a>` and the header that grew are all accepted.
- `dashboard-orderdesk`: the swap changes seven header cells at once; the label is the header row, and `<thead>` and each `<th>` are accepted. The table itself (`#orders`) is not listed; a scorer may reasonably treat it as a near miss. The shift is small (0.0088).
- `search-findry`: the culprit is in the HTML from the start and is revealed by script. `culpritLineKind` is `opening-tag`; the reveal statement is an acceptable line.
- `product-tidewell`: the inserted block and the empty section it is put into are both accepted. A second block is inserted at the same moment just above the footer; it moves only off-screen content and is a decoy.
- `shop-grid-fernhill`: the image, or the link that wraps it, is accepted; the card (two levels up) is not listed.
- `blog-grainline`, `pricing-ledgerly`: the inserted element has no opening tag in the HTML; the line is the insertion statement, and the statement that creates the element or holds its markup is an acceptable line.
- `landing-pulsebase`: the font file used by the headline is also inlined as a `data:` URL under another family name for the wordmark. Only the headline's family swaps.
- `pricing-ledgerly`: the headline's web font finishes loading at 500 ms but is `font-display: optional`, so Chromium never swaps it in on this (cold) load. If a browser or cache state did swap it, that would be a real second shift; the validator would then fail the page.
- `blog-fieldnotes`, `product-tidewell` (decoy): "below the fold" holds for a 1280x800 viewport with no scrolling. In a much taller viewport, or after scrolling down before the content arrives, the same insertion would move visible content.
- `docs-kiln`: the click must be a trusted input event within 500 ms before the shift. A synthetic `element.click()` from script does not set `hadRecentInput`, and the page would then look like an unexplained shift.

## Limits

- Measured in headless Chromium only, at 1280x800 and device scale factor 1. The font-swap pages depend on the fallback being narrower than Press Start 2P, which is true of every common system font, but the exact values will differ on other platforms.
- The pages use system font stacks, so line breaks (and therefore values) can differ slightly between operating systems. `minValue` leaves about 40% of margin.
- Layout shifts inside the embedded player's own document are not reported to the parent page; the player has none.

## Assets and licences

See `assets/LICENCES.md`. The font is Press Start 2P (SIL Open Font License 1.1, full text in `assets/fonts/OFL.txt`); everything else is MIT, as the rest of the repo.
