# Changelog

## 0.1.0

The first release.

- `npx @primp/cli`: a local proxy in front of your dev server that adds the dock to your app. It finds the dev server, starts on the next port and opens your app through it.
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
- **MCP:** six tools for Claude Code, Codex, Cursor or any MCP client (`npx @primp/cli setup`). Without MCP, Send copies the prompt.
- `npx @primp/cli demo`: a demo site with one seeded layout shift.
- **Element to source:** exact positions for React 19, Svelte 5 and plain HTML; ranked guesses elsewhere.
