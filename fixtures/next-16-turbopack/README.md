# next-16-turbopack fixture

A small Next.js 16.4 App Router app (React 19.3, TypeScript, Turbopack dev server) used to test reglet's proxy against a demanding framework: server and client components, a nonce Content-Security-Policy, cookie auth, a Server Action, a streamed page, a very large page and a switchable build error.

It is a standalone app outside the pnpm workspace.

```sh
pnpm install --ignore-workspace   # once, inside this directory
PORT=4321 pnpm dev                # next dev --hostname localhost; Turbopack is the default bundler in Next 16
node scripts/smoke.mjs --break    # starts the server on a free port, checks everything below, stops it
```

The dev server binds to `localhost` and takes its port from `PORT` (3000 when unset).

## Pages

| Route | What it is for |
|---|---|
| `/` | Product page mixing server and client components: hero, card grid (CSS module), server-rendered stats, client counter, client tabs, a client frame with a server child, a client form. 46 labelled elements. |
| `/actions` | A form whose `action` is the Server Action `incrementCounter` (`app/actions/actions.ts`). It adds the step to a value kept in memory, calls `revalidatePath`, and the page shows the new value in `[data-label="actions-count"]` (also as `data-count`). A second form resets it. |
| `/stream` | Suspense around an async server component that waits 1500 ms. The fallback `[data-label="stream-fallback"]` is sent first; `[data-label="stream-resolved"]` arrives later in the same response. |
| `/big` | 12,000 unlabelled host elements (3,000 rows of `li` + 3 `span`) plus 3 labelled ones: `big-title`, `big-middle-marker`, `big-end-marker`. |
| `/login` | Plain HTML form that POSTs `username` and `password` to the Route Handler `/api/login`. The only account is `demo` / `demo`; the fields are pre-filled. |
| `/account` | Server component that reads the `session` cookie. Shows `Signed in as demo`, or redirects to `/login` (HTTP 307) without the cookie. Its form POSTs to `/api/logout`. |
| `/csp` | Shows the policy of the current request and two inline scripts, one with the nonce and one without. `[data-label="csp-status-nonced"]` reads `ran` and `[data-label="csp-status-unnonced"]` reads `blocked` once `[data-label="csp-status"]` has `data-ready="true"`. |
| `/broken-toggle` | Imports the two components that `scripts/break.mjs` breaks. See below. |

Route Handlers: `POST /api/login` sets `session=demo; Path=/; HttpOnly; SameSite=lax` and answers 303 to `/account` (303 to `/login?error=1` on wrong credentials). `POST /api/logout` clears the cookie and answers 303 to `/login`.

## Layout of the source

```
app/                 pages, layout, Route Handlers, globals.css, page.module.css
components/server/   server components (no directive)
components/client/   client components (every file starts with "use client")
lib/                 session constants, in-memory store for the Server Action
proxy.ts             the CSP; "proxy.ts" is the Next 16 name for the former middleware.ts
scripts/             gen-labels.mjs, break.mjs, smoke.mjs
```

`app/globals.css` and `app/page.module.css` each have an `@media (max-width: 720px)` rule. Two more CSS modules sit next to client components.

## labels.json

Every labelled element has `data-label="<label>"` in the source. `labels.json` lists them:

```json
{"label":"home-title","file":"app/page.tsx","line":14,"col":9,"tag":"h1","kind":"server","page":"/"}
```

`line` and `col` are 1-based and point at the `<` of the opening tag. `kind` is `client` for files with the `"use client"` directive and `server` for all others. Currently 87 labels: 62 server, 25 client.

Two fields go beyond the shared fixture convention:

- `page`: the first route (sorted, `/` first) that renders the element, found by following imports from each `page.tsx` and the layouts above it. Labels from `app/layout.tsx` have `page: "/"` and are on every page.
- `note`: present only on labels that are not in the DOM after a plain GET of `page`. Today that is the four `/account` labels (they need the session cookie) and `stream-fallback` (in the DOM only until the Suspense boundary resolves).

The file is generated. After any edit to a `.tsx` file run:

```sh
node scripts/gen-labels.mjs           # rewrite labels.json
node scripts/gen-labels.mjs --check   # exit 1 if it is out of date
```

The script reads positions from the TypeScript parser, refuses labels on components or with non-literal values, refuses duplicates, and fails when `components/client/` and the `"use client"` directive disagree.

Two hidden elements are labelled on purpose: `login-error` and `login-hint-text` are always in the DOM with the `hidden` attribute.

## Content-Security-Policy

`proxy.ts` follows the Next.js 16 guide: a fresh nonce per request, sent in the `Content-Security-Policy` response header and passed to rendering through the request headers.

```
default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' 'unsafe-eval'; style-src 'self' 'nonce-…';
img-src 'self' blob: data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- `'unsafe-eval'` is there in development only, as the guide says. `upgrade-insecure-requests` from the guide is left out because the fixture is served over plain http.
- Next puts the nonce on all of its own script tags. An inline script without it does not run; `/csp` proves that in the browser.
- The matcher skips `/api`, `/_next/static`, `/_next/image` and prefetches, so those responses have no CSP header.
- **Known noise:** with `style-src` on the nonce, Next's own dev tools get 33 `style-src-elem` violations on every page load, because they insert `<style>` elements without a nonce (32 inside the `<nextjs-portal>` shadow root, one `@font-face` block in `<head>`, all from the `next-devtools` chunk). The app itself causes none. A test that counts violations has to filter those out, for example by `event.sourceFile` or the shadow host.
- `FIXTURE_CSP_STYLE=unsafe-inline pnpm dev` switches `style-src` to `'self' 'unsafe-inline'`, the relaxed development variant from the same guide. Then there are no style violations at all. The script policy is the same in both modes.

## Breaking the build on purpose

```sh
node scripts/break.mjs on            # syntax error in components/server/BreakTargetServer.tsx
node scripts/break.mjs on client     # syntax error in components/client/BreakTargetClient.tsx
node scripts/break.mjs off           # repair both (or: off server | off client)
node scripts/break.mjs status
```

Each target has one line starting with `/* reglet:break */`. `on` turns it into `const breakState: string = 'on' +;`; `off` restores it. Only that line changes, so `labels.json` stays valid. Only `/broken-toggle` imports the two files, so other pages keep working while one is broken.

Measured with the dev server running: within about 250 ms of `on`, `GET /broken-toggle` answers HTTP 500, and the HMR socket sends `{"type":"built","errors":[{"message":"./components/client/BreakTargetClient.tsx:3:53\nError: Expression expected…` . Within about 250 ms of `off` the page is 200 again and the socket sends `{"type":"built","errors":[]}`.

## Running from a copy

Tests copy the fixture to a temporary directory and symlink `node_modules` back to this one (never copy it):

```sh
rsync -a --exclude node_modules --exclude .next --exclude next-env.d.ts fixtures/next-16-turbopack/ .tmp/copy/
ln -s "$PWD/fixtures/next-16-turbopack/node_modules" .tmp/copy/node_modules
```

Turbopack does not follow a `node_modules` symlink that leaves its root, so `next.config.ts` sets `turbopack.root` to the closest directory containing both the app and the real `node_modules`. For a copy under the repo's `.tmp/` that is the repo root. A copy outside the repo would make the root `/` or a home directory; keep copies inside the repo.

`next.config.ts` also sets `agentRules: false`. Without it, `next dev` writes an `AGENTS.md` into the project when it detects a coding agent in the environment.

`next dev` writes `next-env.d.ts` and `.next/` (about 175 MB after visiting every page) into the directory it runs in; both are git-ignored. `pnpm typecheck` works only after the dev server has run once, because `next-env.d.ts` imports generated route types.

## What a proxy in front of this app has to handle

`serverActions.allowedOrigins` and `allowedDevOrigins` are not configured, on purpose. Measured against the dev server, with the proxy on a different localhost port:

| Case | Result |
|---|---|
| Server Action POST, `Origin` = proxy, `Host` = upstream | HTTP 500 `Invalid Server Actions request`, value unchanged |
| Same, with `Host` = proxy host | HTTP 200, value incremented |
| Same, with `Host` = upstream and `X-Forwarded-Host` = proxy host | HTTP 200, value incremented |
| `POST /api/login` with `Host` or `X-Forwarded-Host` = proxy host | `Location: http://localhost:<upstream port>/account`; the redirect is absolute and always names the upstream port |
| `GET /account` without cookie | 307 with the relative `Location: /login` |
| `GET /` with `Accept-Encoding: gzip, br` | `Content-Encoding: gzip`, chunked, `Cache-Control: no-store` |
| Dev chunk under `/_next/static/` with a `Referer` on another localhost port | 200 (403 for a non-localhost referer) |
| HMR | WebSocket at `/_next/hmr?id=…`, JSON text frames mixed with binary frames |

## smoke.mjs

`node scripts/smoke.mjs` starts the `dev` script on a free port, runs the checks and kills the server's process group. It exits 0 only if every check that ran passed.

- HTTP checks: labels file, Turbopack banner, every page and its labels, nonce on every script tag, CSS, element count on `/big`, streaming gap, auth flow, Server Action with a same-origin and a foreign `Origin`.
- Browser checks (Chromium through `@playwright/test`, resolved from the repo root): the un-nonced script is blocked and the app causes no other violation; hydration, Server Action submit and login work. Printed as SKIP when Playwright cannot be resolved or with `--no-browser`.
- `--break` adds the break/repair check. It edits the two target files in place and restores them, so use it on a copy or when nothing else is using this directory.
