# Working on reglet

Instructions for coding agents (and people) changing this repository. What reglet is and does is in `README.md`; the legal rules are in `CONTRIBUTING.md` and apply to you too.

## Layout

```
packages/protocol   zod schemas shared by browser and server (change items, expectations, socket messages, shift recordings)
packages/engine     PURE logic: side effects, shift attribution, prompts, expectations, the pass/drift/fail judge
packages/source     element -> file:line (browser collectors, node resolvers)
packages/server     proxy, HMR tee, settle detection, session, verification, layout-shift tools, MCP control endpoint
packages/overlay    browser code: the injected hook (src/hook, entry/hook.ts) and the dock (probe/, state/, ui/, entry/overlay.ts)
packages/cli        the published `reglet` binary: run, demo, setup, doctor, mcp (stdio MCP shim)
fixtures/           apps the checks run against; standalone, NOT in the pnpm workspace
spikes/             end-to-end checks; each prints a table and exits 0 or 1
```

How a change flows: the dock records a `ChangeItem` (protocol) -> the server stores it -> `get_pending_changes` renders it with `engine/prompt.ts` -> the agent edits source -> `verify_changes` waits for settle (`server/settle.ts`), the dock measures (`overlay/probe/measure.ts`), the engine judges (`engine/judge.ts`).

## Commands

```sh
pnpm typecheck                 # must be clean
pnpm test                      # vitest, all packages
pnpm build                     # packages/cli/dist (one bundled file + page scripts)
pnpm spike:<name>              # end-to-end checks; list in package.json
```

The end-to-end checks that matter for most changes: `spike:m3-loop` (edit -> agent -> verify, four frameworks), `spike:m1-overlay` (the dock), `spike:m1-server`, `spike:m4-shifts`, `spike:demo`, `spike:pack`. `spike:agent` calls the real `claude` CLI and costs money; run it only when asked. Several spikes accept a section argument to run part of them (read the file header).

Fixtures have their own installs: `pnpm install --ignore-workspace` inside each `fixtures/*` directory. Tests copy a fixture to `.tmp/` before editing it; never edit the checked-in fixtures to make a test pass.

## Rules

- **Never weaken a check to make it pass.** No lowered thresholds, skipped cases or hard-coded answers. A truthful failure with an explanation is the right outcome when something does not work.
- **Verification must never pass unmeasured.** No browser, a hidden tab, a state that cannot be emulated, an element that cannot be found again: each has its own status, never `pass`.
- **`packages/engine/src` has no DOM and no Node APIs.** Browser code imports protocol *types* only, so zod stays out of the injected bundles.
- **Layout-shift attribution is measured on blind page sets.** `fixtures/cls-heldout-2` is the held-out set: do not open it while changing the attributor, and do not tune anything to it. If you change attribution because of a set's results, that set becomes a development set; record it (see `spikes/m4-heldout.ts`).
- **Prompt wording is product.** Changes to `engine/prompt.ts` show up in the golden files under `packages/engine/test/golden`; regenerate with `UPDATE_GOLDEN=1` and read the result as the agent receiving it would.
- **Headless browsers only.** Use `launchBrowser()` from `spikes/lib`, not `chromium.launch()`.
- **Clean up.** Temp files only under `.tmp/` (git-ignored). Stop every process you start, by PID; never `pkill -f` a generic name.
- **Do not run `pnpm install` at the root while other agents work in the repo** (lockfile races).
- **Commits:** no `Co-Authored-By`, `Claude-Session` or "Generated with" lines, in commits or pull requests. Do not push or publish unless asked.

## Gotchas learned the hard way

- Dev servers listen on `::1` only: always use `localhost`, never `127.0.0.1`.
- Playwright keeps every page "visible"; hidden-tab behaviour needs `spikes/s7-assets/raw-chromium.ts`.
- tsx compiles with keep-names: a function passed to `page.evaluate` may reference `__name`; define `globalThis.__name = (fn) => fn` with `addInitScript` (see `spikes/m5-risks.ts`).
- Wait for the HMR socket before editing a fixture file, or the update is missed.
- The proxy sends every response `no-store` on purpose (cold loads, no stale stylesheet after an edit).
- In the dock, change the forced state only through `holdState()` in `state/controller.ts`, and call `markSelf` before any DOM write so layout-shift attribution counts it as reglet's own.
