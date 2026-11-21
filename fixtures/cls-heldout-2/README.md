# cls-heldout-2

A second held-out test set for primp's layout-shift attribution: fourteen pages that look like real sites, each with an `expected.json` that says what (if anything) shifted, which element caused it and why. The sites, layouts and mechanisms are all different from `fixtures/cls-heldout`.

**Do not tune the attribution engine on these pages.** They exist to measure it. They were written without reading the engine, the overlay hook, the shift tools, the spikes or the pages of `fixtures/cls-corpus`, and without knowing how the tool did on the first held-out set.

Folder names, page titles and code comments say nothing about the answer. The answers are in `expected.json` and in the table below.

The set is dependency-free: static HTML, a few assets, one self-hosted font and a small Node server. Nothing is fetched from the network.

## Run it

```
node fixtures/cls-heldout-2/server.mjs                # free port, prints the URL
PORT=4330 node fixtures/cls-heldout-2/server.mjs      # fixed port
cd fixtures/cls-heldout-2 && PORT=4330 npm run dev    # the same, through package.json
```

`server.mjs` is the first set's server with the name changed. It exports `startServer({ port, host })`, which returns `{ url, port, close }`.

| Route | Response |
|---|---|
| `/<path>` | The static file. A directory serves its `index.html`. |
| `/delay/<ms>/<path>` | The same file, but the response starts `<ms>` milliseconds after the request arrived (capped at 30 s). |

Every response carries `Cache-Control: no-store`. Late images, fonts, JSON, the SVG document and the custom-element script all come through `/delay/`, between 500 and 1100 ms.

## Check it

Run from the repo root (the script imports `@playwright/test` from the root install). The browser is always headless.

```
node fixtures/cls-heldout-2/scripts/validate.mjs               # exit 0 when every page meets its requirement
node fixtures/cls-heldout-2/scripts/validate.mjs --verbose     # also print every entry and its sources
node fixtures/cls-heldout-2/scripts/validate.mjs --only forum  # one page
node fixtures/cls-heldout-2/scripts/validate.mjs --write       # record measuredValues / measured in expected.json
node fixtures/cls-heldout-2/scripts/validate.mjs --fix-lines   # recompute culpritLine from the file
node fixtures/cls-heldout-2/scripts/validate.mjs --observe-ms 12000 --loads 1   # check nothing moves later
```

It is the first set's validator with two additions (a key-press interaction, and acceptable lines in another file of the page folder). For every page it does three loads, each in a fresh browser context (cold cache) at 1280x800, with only a plain `new PerformanceObserver(...).observe({ type: 'layout-shift', buffered: true })` installed before any page script, and collects entries for 3 s.

- **Positive page**: the entries without recent input sum to at least `minValue` on every load; their number is the same on every load; one entry carries at least 80% of the sum; at least one victim selector matches a node in the entries' sources; every victim selector is at least 3 px away from where it was at `DOMContentLoaded`.
- **Negative page**: no entries, or only entries with `hadRecentInput` true. The key-press page must produce at least one such entry.
- **Every page**: `culpritSelector` and each `acceptableCulpritSelectors` entry match exactly one element at the end of the load; each decoy selector matches at least one element, and none of them is the culprit, an acceptable culprit, or an ancestor or descendant of the culprit; the `assertAfter` expressions are true (the late thing really arrived); no request failed; no page error; the tab was visible.
- **Line labels**: `culpritLine` is computed from the file. `culpritLineContains` must occur on exactly one line of `culpritFile`, and that line number must equal `culpritLine` (`--fix-lines` rewrites it). For `opening-tag` the line must hold an opening tag whose tag name, and id when it has one, equal those of the live element the selector resolves to.

## Pages

Ten positive pages (exactly one layout-shift entry each) and four negative pages. CLS is the value measured in headless Chromium 159 on macOS arm64 at 1280x800; it was identical on every load.

| Folder | Template | Cause | Mechanism | Culprit | CLS |
|---|---|---|---|---|---|
| `podcast-longwave` | podcast episode page | unsized-media | `<video preload=none>` with no dimensions; its poster arrives at 800 ms and changes its shape | `.video-wrap > video.episode-video` | 0.0781 |
| `weather-skerry` | weather dashboard | unsized-media | SVG document in `<object>` with no dimensions; 300x150 until the SVG (700 ms) gives it 640x240 | `.trend > object.trend-chart` | 0.0181 |
| `course-aldermoor` | university course page | unsized-media | `<img>` in a table cell; the row grows and the columns re-distribute, 750 ms | `#teaching-team tbody tr:nth-child(1) td:nth-child(1) > img` | 0.0225 |
| `portfolio-marlowe` | portfolio / gallery | unsized-media | `<img>` inside `<picture>` with a `<source>`, in a CSS multi-column wall, 800 ms | `#work figure:nth-of-type(2) picture > img` | 0.0146 |
| `event-tidepool` | event / conference page | font-swap | tab bar wraps onto more rows; `@font-face` in a separate `fonts.css` linked from the head, 700 ms | `.schedule > .day-tabs` | 0.1101 |
| `help-brightdesk` | help-centre article | font-swap | sidebar menu links wrap; font built with the FontFace API and `document.fonts.add()`, 750 ms | `.kb > div > nav.kb-menu` | 0.0068 |
| `newsletter-undertow` | newsletter archive | font-swap | pull quote re-wraps; inline `@font-face` with `font-display: fallback`, 650 ms | `.featured > blockquote` | 0.0242 |
| `forum-gearloft` | forum thread | injected-content | banner cloned from a `<template>` and put between two posts with `insertBefore()`, after an 800 ms JSON fetch | `#posts > aside.solved-banner` | 0.0305 |
| `jobs-fathom` | job board listing | injected-content | custom element in the HTML, upgraded by an async script that arrives at 800 ms; it renders a shadow-DOM box | `.results > job-alert-prompt` | 0.0528 |
| `travel-kittiwake` | travel booking results page | injected-content | `textContent` of an existing one-line paragraph replaced by five lines, after an 850 ms JSON fetch | `.results-head > p.fare-note` | 0.0196 |
| `menu-saffron-quay` | restaurant menu page | negative | late images without width/height inside boxes fixed by `aspect-ratio` or an explicit height | none | 0 |
| `homes-larchfield` | real-estate listing | negative | `<dialog>.showModal()` called by script at 900 ms | none | 0 |
| `changelog-pikestaff` | changelog page | negative | `<details>` opened by pressing Enter on its `<summary>`; entries have `hadRecentInput` true | none | 0 (+1 with input) |
| `checkout-bramblecart` | checkout / cart page | negative | text replaced inside fixed-height boxes with `overflow: hidden` (one of them every 600 ms) | none | 0 |

Every page also carries innocent things that a naive attribution could accuse; they are listed under `decoys` and described in `notes`. Examples: a sized image from a delayed URL at the moment of the real shift; text written by the same callback into fixed-size boxes; five other custom elements upgraded by the same script; a second `FontFace` added to `document.fonts` that nothing uses; a sticky header whose `box-shadow` and background change on a timer; `innerHTML` rewrites that change colours only.

## expected.json

The format is the first set's, with two optional additions.

```
{
  "page": "<folder>/index.html",
  "template": "forum thread",
  "positive": true,
  "shifts": [
    {
      "cause": "unsized-media" | "font-swap" | "injected-content",
      "culpritSelector": "matches exactly the element that caused the shift",
      "acceptableCulpritSelectors": ["each matches exactly one element that a reasonable person would also accept"],
      "culpritFile": "<folder>/index.html",
      "culpritLine": 161,
      "culpritLineKind": "opening-tag" | "script-insert",
      "culpritLineContains": "text that occurs on exactly that line; culpritLine is computed from it",
      "acceptableCulpritLines": [ { "line": 194, "kind": "...", "contains": "...", "file": "<folder>/other-file (optional)" } ],
      "victimSelectors": ["elements that visibly move"],
      "minValue": 0.018
    }
  ],
  "decoys": ["selectors of innocent elements"],
  "interaction": null | { "selector": "<css selector>", "afterMs": 1000, "key": "Enter (optional)" },
  "minEntriesWithRecentInput": 1,
  "assertAfter": ["JavaScript expressions that must be true at the end of the load"],
  "measuredValues": [0.030537, 0.030537, 0.030537],
  "measured": { "browser": "...", "entriesPerLoad": [...], "dominantEntry": { "value": ..., "startTimeMs": ..., "sources": [...] } },
  "notes": "a few sentences"
}
```

- `interaction` is `null` or `{ selector, afterMs }`, counted from the window's `load` event. With `"key"`, the interaction is a press of that key with the element focused instead of a click. Only `changelog-pikestaff` has one.
- `acceptableCulpritLines[].file` is new: the line is in another file of the same page folder (`event-tidepool/fonts.css`, `jobs-fathom/job-widgets.js`). Without it the line is in `culpritFile`.
- In this set every culprit has its opening tag in `index.html`, so every `culpritLineKind` is `opening-tag`. For the forum page that tag is inside a `<template>`.
- `kind` values used in `acceptableCulpritLines`: `source-tag`, `stylesheet-link`, `font-face-src`, `font-family-declaration`, `font-add-statement`, `font-face-constructor`, `insert-statement`, `clone-statement`, `template-opening-tag`, `fetch-statement`, `script-tag`, `define-statement`, `render-statement`, `host-display-rule`, `text-statement`.
- `measuredValues` are the sums of the entries without recent input on the three loads of the last `--write` run. `minValue` is about 60% of that.

## Where attribution is legitimately ambiguous

- `podcast-longwave`: the culprit is a `<video>`, not an `<img>`, and the resource that changes its size is the poster image. Its play button (in the media controls' shadow tree) shows up among the entry's sources as a null node.
- `weather-skerry`: the culprit is an `<object>`. What arrives is an SVG document, not an image decode, and it lives in a nested browsing context.
- `course-aldermoor`: the image or the cell that holds it is accepted. The entry's sources are the table body and header cells, not the rows.
- `portfolio-marlowe`: Chromium does not report layout shifts for content inside a multi-column container, so the entry's sources contain only the two sections after the wall, although photographs' captions move as well. The culprit is three levels away from anything in the sources. Both the `<img>` and its `<picture>` are accepted; the `<source>` line is an acceptable line because that is where the loaded URL is written.
- `event-tidepool`: five buttons change at once; the label is the tab list, and each button is accepted. The `@font-face` rule is in `fonts.css`, not in `index.html`.
- `help-brightdesk`: seven links change at once (five of them wrap); the label is the `<nav>` that carries the `font-family`, and the `<ul>`, each `<li>` and each `<a>` are accepted. There is no `@font-face` rule anywhere: the family exists only once script has added it. The shift is small (0.0068) and stays inside the sidebar column.
- `newsletter-undertow`: `font-display: fallback` swaps only when the font arrives within the swap period (about 3 s). On a much slower connection there would be no swap and no shift.
- `forum-gearloft`: the culprit's opening tag is in the HTML but inside a `<template>`, so it is not in the document until script clones it. A tool that points at the `insertBefore()` statement is equally right; it is an acceptable line.
- `jobs-fathom`: nothing is inserted into the light DOM. The element is in the HTML from the start and grows when its class is defined. A tool may reasonably name the script tag or `customElements.define()` (acceptable lines) rather than the element. Elements inside the shadow root are not selectable from the document and are not listed.
- `travel-kittiwake`: no node is added and no attribute changes; one text node's data is replaced. It is labelled `injected-content` because script puts content into the page late. The same callback writes four other texts into clipped boxes.
- `menu-saffron-quay`: the images have no width/height attributes at all, which is exactly what an "unsized image" heuristic looks for; the reservation is on their containers.
- `homes-larchfield`: the dialog is modal and makes the rest of the page inert, but nothing moves. A tool that treats any late large element as a shift source would be wrong here.
- `changelog-pikestaff`: the key press must be a trusted keyboard event within 500 ms before the shift. Calling `details.open = true` from script, or dispatching a synthetic event, would give an unexplained shift instead.
- `checkout-bramblecart`: the delivery estimate's text overflows its box (its `scrollHeight` is larger than its height), which looks like growth to anything that measures content rather than boxes.
- "Below the fold" and "in the viewport" hold for a 1280x800 viewport with no scrolling.

## Limits

- Measured in headless Chromium only, at 1280x800 and device scale factor 1.
- The pages use system font stacks, so line breaks and values can differ between operating systems. `minValue` leaves about 40% of margin. The font-swap pages depend on the fallback being much narrower than Press Start 2P, which holds for every common system font.

## Assets and licences

See `assets/LICENCES.md`. The font is Press Start 2P (SIL Open Font License 1.1, full text in `assets/fonts/OFL.txt`); everything else is MIT, as the rest of the repo.
