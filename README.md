# reglet

Visual edits, layout shifts and verification for AI coding agents. Work in progress; nothing is published yet.

`npx reglet` will start a proxy in front of your dev server and add a dock to your running app with three tabs:

- **Edits**: change any CSS property, hide or remove elements, and see what else moved because of it.
- **Shifts**: see the layout shifts of the current page load, with the culprit element, its source line and the likely cause.
- **Verify**: after your coding agent (Claude Code, Cursor, Codex, any MCP client, or a pasted prompt) edits the source, reglet re-measures the page and reports pass, drift or fail per change.

reglet never rewrites your source. It records what you changed and checks what the agent did.

## Repo layout

```
packages/protocol   zod schemas shared by browser and server
packages/engine     pure logic: rect diff, side effects, shift attribution, locator, judge, prompts
packages/source     element to file:line (browser collectors, node resolvers)
packages/server     proxy, HMR tee, settle detection, session, control port, MCP tools
packages/overlay    injected hook, probe and dock UI
packages/cli        the published `reglet` binary
fixtures/           standalone apps used by tests (outside the pnpm workspace)
e2e/                Playwright tests and the fake-agent patcher
spikes/             feasibility checks; each exits 0 or 1 (`pnpm spike:s1` ... `spike:s7`)
```

All dependencies are declared at the workspace root during the spike phase; only `packages/cli` is published, as a bundled executable.

## Licence

MIT. See `CONTRIBUTING.md` for the clean-room rule and `NOTICE` for derived code.
