# primp demo

A landing page for Corvane, a made-up uptime-monitoring product, with one deliberate problem:
the product screenshot under the headline has no reserved space, so everything below it jumps
when it loads.

1. Open the page primp printed. In the dock, the **Shifts** tab shows the jump, the element
   that caused it (`img#hero-art`) and its line in `index.html`.
2. In your coding agent, in this directory, say: *"Fix the layout shift primp found, then verify it."*
   The agent reads the shift with `get_layout_shifts`, edits `index.html`, and calls
   `verify_layout_shift`, which reloads the page three times and reports whether the jump is gone.
3. Try an edit: in the **Edits** tab pick the "Start free trial" button, change its padding or
   colour, press **Send**, and tell your agent *"Implement the primp changes and verify them."*
   The padding comes from the shared `.btn` rule, so the change also reaches the second purple
   button further down, and the dock names the "Read the docs" button as one that must keep its
   own padding.
4. More to try in the same tab: pick the headline and tighten its letter spacing; choose the
   `:hover` state of the purple button and change its background (the page shows the hover look
   while you edit); drag the edge of a feature card to resize it, or move a card to another place
   in the grid. Each one goes to your agent and is verified the same way.

No agent connected over MCP? Run `npx primp setup`, or paste the prompt that Send copies.
