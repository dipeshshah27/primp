# vite-react-19 fixture

A small marketing page ("Lumen", invented content) used by primp's spikes and tests for visual editing, source mapping, side-effect detection and verification.

Stack: Vite 8, React 19.3, `@vitejs/plugin-react` 6, Tailwind CSS v4 through `@tailwindcss/vite`, TypeScript. Everything renders in the browser; there is no SSR and no router.

This directory is a standalone app, outside the pnpm workspace.

```sh
pnpm install --ignore-workspace   # once, inside this directory
PORT=4311 pnpm dev                # http://localhost:4311
```

The dev server reads `PORT` and binds to `localhost`. With `PORT` set the port is strict: the server exits if it is taken. Without `PORT` it uses Vite's default, 5173.

## Pages

| URL | What it renders |
|---|---|
| `/` | Header with nav and the sign-in control, a banner, then `<main>` with the hero, six feature cards and the pricing section, then the footer. 51 labels, 121 host elements. |
| `/big` | A table of 2,600 rows with 4 cells each: 13,007 host elements, 3 labels. Built to cross React's owner-stack cap. |

`src/App.tsx` picks the page from `location.pathname`. Links between pages are plain `<a href>`, so each navigation is a full page load. Vite serves `index.html` for any path, so `/big` returns the same HTML shell as `/`.

Add `?nostrict` to either URL to render without `<StrictMode>` (see "The owner-stack cap" below).

## Components

| File | Notes |
|---|---|
| `src/pages/Home.tsx` | Page shell: header, banner, `<main>`, footer. |
| `src/components/Header.tsx` | Logo, nav (`#features`, `#pricing`, `/big`), `SessionControl`. |
| `src/components/SessionControl.tsx` | Login simulation. |
| `src/components/Banner.tsx` | Announcement strip between the header and `<main>`. Its Dismiss button unmounts it, and `<main>` moves up by the banner's height. |
| `src/components/Hero.tsx` | Copy column and a decorative art column. |
| `src/components/Features.tsx` | Renders `Card` once per entry of `src/data/cards.json` with `.map` (6 entries). |
| `src/components/Card.tsx` | One feature card. Every label in it appears 6 times in the DOM. |
| `src/components/PricingTable.tsx` | Three plans rendered inline with `plans.map` (each label inside appears 3 times), and a comparison table. |
| `src/components/Footer.tsx` | Copy line and two links. |
| `src/pages/Big.tsx` | The `/big` page. |

## Styling systems

Three are present, and some elements use two at once.

| System | Where | Used by |
|---|---|---|
| Tailwind v4 utilities | `src/index.css` (`@import 'tailwindcss'`) | Home shell, Header layout, Hero copy, Features, Footer layout, SessionControl, the `/big` title |
| Plain global CSS | `src/styles/site.css` | Nav links, Banner, the whole pricing section, footer links, the `/big` table |
| CSS modules | `src/components/Card.module.css`, `src/components/Hero.module.css` | Card, Hero art |

Rules worth knowing when writing a test:

- `site.css` has one `@media (min-width: 768px)` block. It switches `.pricing-grid` from one column to three and adds vertical padding to `.plan--featured`.
- `site.css` has `:hover` rules on `.site-nav a`, `.banner__dismiss`, `.plan`, `.plan__cta` and `.footer-links a`. `Card.module.css` has `.card:hover`. Tailwind `hover:` variants are on `hero-cta-primary`, `hero-cta-secondary` and `login-button`.
- `site.css` is not inside a cascade layer, so its rules beat Tailwind's utilities and preflight, which are layered.
- `hero-art` carries a CSS-module class and the Tailwind utility `shadow-lg` on the same element.
- Tailwind's responsive variants (`md:`, `sm:`, `lg:`) appear on `hero`, `hero-title`, `footer-inner` and `card-grid`.
- Nothing animates or transitions.

## Login simulation

`login-button` in the header writes `session=abc` with `document.cookie` (path `/`, `SameSite=Lax`, session lifetime). `session-status` shows "Signed in" or "Signed out"; its initial value is read from `document.cookie` when the component first renders, so the state survives a reload. Clicking the button while signed in clears the cookie. There is no backend, and the cookie is not `HttpOnly`.

## Labels

Every labelled element has `data-label="<label>"` in the source. `labels.json` lists them:

```json
{ "label": "card", "file": "src/components/Card.tsx", "line": 12, "col": 5, "tag": "article", "kind": "client", "page": "/", "instances": 6 }
```

- `file` is relative to this directory. `line` and `col` are 1-based and point at the `<` of the opening tag.
- `kind` is always `"client"` here.
- `page` (extra field) is the URL the element is rendered on: `/` or `/big`.
- `instances` (extra field) is present only when the element is rendered more than once: 6 for the labels in `Card.tsx`, 3 for the labels inside `plans.map` in `PricingTable.tsx`, 2,600 for `big-cell-name`. `document.querySelectorAll('[data-label="card"]')` returns that many nodes, all from the one source position.

Labels are unique across the fixture. `labels.json` is generated; do not edit it by hand.

```sh
node scripts/gen-labels.mjs           # rewrite labels.json after editing src/
node scripts/gen-labels.mjs --check   # exit 1 if labels.json is out of date
```

The generator parses each `.tsx` file with the parser that ships in Vite and reads positions from the AST. It fails on a duplicate label, a label that is not a string literal, a label on a component instead of a host element, and a label inside a `.map` whose repeat count it has not been told (see `REPEATS` in the script).

## The owner-stack cap on /big

React's development build records an owner stack (`_debugStack`) for each element it creates, but only for the first 10,000 elements created in a window; the counter resets when a render starts more than a second after the last reset. Elements past the cap share one placeholder stack that names no source file.

`BigPage` creates all of its elements in one render, in source order: `big-title` first, then the rows from top to bottom, then `big-footer`. Measured with `scripts/verify.mjs` on React 19.3.1 in Chromium:

| URL | `big-title` | `big-cell-name` (2,600 nodes) | `big-footer` |
|---|---|---|---|
| `/big?nostrict` | has a stack naming `Big.tsx` | first 1,999 have one, the remaining 601 do not | none |
| `/big` | none | none | none |

`/big` loses every stack because `<StrictMode>` renders the component twice in development and React keeps the second result, whose elements are all created after the first pass has already used up the cap. On `/`, with StrictMode on, all 51 labels have an owner stack that names their file.

## Checking the fixture

```sh
node scripts/verify.mjs               # HTTP checks, then browser checks
node scripts/verify.mjs --http-only
```

The script starts `pnpm dev` on a free port, checks the served pages and modules, then drives Chromium to compare the DOM with `labels.json`, check that each styling system applies, exercise the login and the banner, and measure the owner stacks on `/big`. It stops the server when it finishes or fails, and exits 1 if any check failed.

The browser checks need `@playwright/test`, which this fixture does not depend on. It is resolved from the primp repo root, so the browser checks run while the fixture is inside the repo and are reported as skipped when it has been copied outside it.

## Running a copy

Tests copy this directory to a temp directory and symlink `node_modules` back to the checked-in one. That works, with two things to know:

- Vite stores pre-bundled dependencies in `node_modules/.vite`, so every copy shares the checked-in cache and rewrites it on start because the project root differs. Set `PRIMP_FIXTURE_CACHE_DIR` (for example `.vite`) to give a copy its own cache. Dependency URLs then change from `/node_modules/.vite/deps/react.js` to `/.vite/deps/react.js`.
- On macOS `localhost` resolved to `::1` only when this was written: the server answered on `http://localhost:PORT` and `http://[::1]:PORT`, and refused `http://127.0.0.1:PORT`. Connect to `localhost`, not to `127.0.0.1`.
