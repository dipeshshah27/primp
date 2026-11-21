# primp demo

A one-page site with one deliberate problem: the big picture under the headline has no
reserved space, so everything below it jumps when it loads.

1. Open the page primp printed. In the dock, the **Shifts** tab shows the jump, the element
   that caused it and the line in `index.html`.
2. In your coding agent, in this directory, say: *"Fix the layout shift primp found, then verify it."*
   The agent reads the shift with `get_layout_shifts`, edits `index.html`, and calls
   `verify_layout_shift`, which reloads the page three times and reports whether the jump is gone.
3. Try an edit: in the **Edits** tab pick the "Start a subscription" button, change its padding or
   colour, press **Send**, and tell your agent *"Implement the primp changes and verify them."*
4. More to try in the same tab: choose the `:hover` state and change the button's background (the
   page shows the hover look while you edit), drag the edge of a bean card to resize it, or move a
   card to another place in the grid. Each one goes to your agent and is verified the same way.

No agent connected over MCP? Run `npx primp setup`, or paste the prompt that Send copies.
