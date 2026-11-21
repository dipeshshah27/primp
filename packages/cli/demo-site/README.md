# reglet demo

A one-page site with one deliberate problem: the big picture under the headline has no
reserved space, so everything below it jumps when it loads.

1. Open the page reglet printed. In the dock, the **Shifts** tab shows the jump, the element
   that caused it and the line in `index.html`.
2. In your coding agent, in this directory, say: *"Fix the layout shift reglet found, then verify it."*
   The agent reads the shift with `get_layout_shifts`, edits `index.html`, and calls
   `verify_layout_shift`, which reloads the page three times and reports whether the jump is gone.
3. Try an edit: in the **Edits** tab pick the "Start a subscription" button, change its padding or
   colour, press **Send**, and tell your agent *"Implement the reglet changes and verify them."*

No agent connected over MCP? Run `npx reglet setup`, or paste the prompt that Send copies.
