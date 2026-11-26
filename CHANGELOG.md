# Changelog

## Unreleased

- **Your agent can watch for what you send.** A new MCP tool, `wait_for_changes`, returns as soon as you press Send. Tell the agent once to "watch primp", and every Send goes straight to it: no switching windows, no pasting. While it waits, the Send button shows a green dot, and after Send the dock says the agent has the changes.
- **Results find you.** While a change is checked the dock says "checking…". Results that arrive while the Verification panel is closed show as a toast and a coloured dot on the closed dock (grey when something could not be measured; never green for that). The terminal prints a line for each step: a tab attached, changes sent and taken, what passed and what failed (`--quiet` turns them off).
- **Copy fix-up**: what did not pass, as instructions to paste into an agent that has no MCP (the prompt always promised it).
- **Show what you asked**: the sent changes on the page again, to compare with what the agent made; never seen by a check. The Send notice says why the previews leave the page.
- **Take back** a sent change no agent has taken yet, to edit or delete it.
- **Copy fix prompt** for a layout shift, from the Shifts panel.
- **Getting started**: the start-up lines say how to open the dock, and print the agent commands only until an agent has primp (`doctor` checks it too). In a terminal primp waits up to 30 s for a dev server you are still starting, and waits for a first compile instead of giving up after 1.5 s. Dev servers on HTTPS are found. The demo brings `.mcp.json` and `.cursor/mcp.json`, so an agent opened there finds primp by itself. The first time the dock opens, a hint says what to do; `?` lists every shortcut.
- **Fixes**: `setup` registers Claude Code for every project (it was one project only), says when it is already connected, and the docs' Cursor config names the right package. The dock follows client-side navigation (`next/link`, a router's `pushState`). Tailwind 4 utilities that set logical properties (`px-4` is `padding-inline`) are found as the origin of `padding-left`, so the agent is pointed at the right rule. A run of ↑/↓ in a field is one undo step. The colour picker keeps transparency. Refusals of actions taken on the page are shown, and toasts are announced to screen readers.
- **The website** lets you watch verification: after Send, a simulated careful or sloppy agent applies the changes, and primp's real verifier judges them.
- **Reordering by drag is easier to aim and shows the result while you drag.** The grip moves the list item around the selection (the card around a clicked paragraph). The element is shown where it would land, its siblings slide into place, and a label at the pointer says where it goes. Dropping over a sibling takes its place. The dock fades out of the way, and the page scrolls at the window's edge. Alt+↑ / Alt+↓ moves the element one place. Hidden siblings (`<script>`, `display: none`) are no longer drop targets. When nothing can be moved, a greyed grip says why.

## 0.1.0

The first release.

- `npx @primpdev/cli`: a local proxy in front of your dev server that adds the dock to your app. It finds the dev server, starts on the next port and opens your app through it.
- **The dock:** closed until you open it (⌘⇧E / Ctrl⇧E). While it is open, a click selects any element and the inspector opens next to it. From there you can:
  - change any CSS property, at rest or for `:hover`, `:focus`, `:focus-visible` and `:active`;
  - resize the element by its edges;
  - move it among its siblings;
  - hide or remove it;
  - leave a note for your agent.

  Each changed element gets a numbered pin, coloured by its verification result.
- **Side effects and bystanders:** every edit is measured. Unwanted movement becomes a constraint, and elements that share the edited CSS rule must stay unchanged.
- **Layout shifts:** recorded from the first script and attributed to a culprit element, a cause (unsized media, font swap, injected content, a development artifact) and a source line.
- **Verification:** after your agent edits the source, primp waits for the page to update, measures it again and reports `pass`, `drift` or `fail` for each change. Anything it could not measure gets its own status and is never a pass.
- **MCP:** six tools for Claude Code, Codex, Cursor or any MCP client (`npx @primpdev/cli setup`). Without MCP, Send copies the prompt.
- `npx @primpdev/cli demo`: a demo site with one seeded layout shift.
- **Element to source:** exact positions for React 19, Svelte 5 and plain HTML; ranked guesses elsewhere.
