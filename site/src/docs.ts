/**
 * The documentation: one HTML page per topic, a shared sidebar and previous/next links.
 * Facts come from README.md, the CLI (packages/cli/src) and the MCP tool descriptions
 * (packages/cli/src/mcp-shim.ts), rewritten for people.
 */

import { command, esc, page, shot } from './layout.ts'
import { statusTable, testedMatrix } from './shared.ts'

interface DocPage {
  slug: string
  title: string
  description: string
  body: (root: string) => string
}

const pre = (text: string): string => `<pre><code>${esc(text)}</code></pre>`

const CURSOR_JSON = JSON.stringify({ mcpServers: { primp: { type: 'stdio', command: 'npx', args: ['-y', 'primp', 'mcp', '--project', '${workspaceFolder}'] } } }, null, 2)

export const DOCS: DocPage[] = [
  {
    slug: 'index.html',
    title: 'Getting started',
    description: 'Install-free start with primp: the demo, running it in front of your dev server, and the options.',
    body: (root) => `
<h1>Getting started</h1>
<p class="lede">primp is a proxy you run in front of your dev server. It serves your app through its own port, adds a dock to every page, and remembers the changes you make there until your coding agent has implemented them and primp has checked the result.</p>
<p>It never writes to your source files and installs nothing in your project. It runs on your machine and talks only to your dev server and your browser.</p>

<h2 id="requirements">What you need</h2>
<ul>
<li>Node 22.22 or later in the 22 line, or 24.11 and later.</li>
<li>A dev server for your app (Vite, Next, SvelteKit, a plain static server, or anything else that serves HTML).</li>
<li>A Chromium-based browser. It is the only engine primp has been run in, and layout shifts need it in any case.</li>
<li>Optionally a coding agent that speaks MCP (Claude Code, Codex, Cursor or another client). Without one, you paste a prompt.</li>
</ul>
<p>primp has been run on macOS only. On Windows, pass <code>--target</code>, because finding the dev server automatically is untested there.</p>

<h2 id="demo">Try the demo</h2>
${command('npx primp demo')}
<p>This copies a one-page site with one seeded layout shift into <code>./primp-demo</code>, serves it, starts primp in front of it and opens it in your browser with the dock. The terminal tells you what to say to your agent. Pass <code>--dir &lt;directory&gt;</code> to put the site elsewhere, and <code>--no-open</code> to skip opening the browser.</p>
<p>The site has one deliberate problem: the picture under the headline has no reserved space, so everything below it jumps when it loads. Open the dock's <strong>Shifts</strong> tab to see it, then ask your agent to <em>&ldquo;Fix the layout shift primp found, then verify it.&rdquo;</em></p>
<p>No time to install anything? The <a href="${root}demo/">live demo</a> runs the same dock on the same site in your browser, without a server or an agent.</p>

<h2 id="project">Use it on your project</h2>
<p>Start your dev server as usual, then, in the project directory:</p>
${command('npx primp')}
<p>primp finds the dev server by looking at the processes of this project, starts a proxy on the next port and opens your app through it. Use the page it opens; the dock is only there.</p>
<div class="table-scroll"><table>
<thead><tr><th scope="col">Option</th><th scope="col">What it does</th></tr></thead>
<tbody>
<tr><td><code>--target &lt;url or port&gt;</code></td><td>The dev server to sit in front of, when primp cannot find it or finds the wrong one.</td></tr>
<tr><td><code>--exec "&lt;command&gt;"</code></td><td>Start the dev server too, and stop it on exit: <code>npx primp --exec "npm run dev"</code>.</td></tr>
<tr><td><code>--port &lt;n&gt;</code></td><td>Port for the proxy. Default: the dev server's port plus one, or the next free one.</td></tr>
<tr><td><code>--project &lt;dir&gt;</code></td><td>The project directory, when it is not the working directory.</td></tr>
<tr><td><code>--no-open</code></td><td>Do not open the browser.</td></tr>
</tbody>
</table></div>
<p>primp keeps running in that terminal; stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd>. With <code>--exec</code>, that stops the dev server as well.</p>
<p>If something does not work, <code>npx primp doctor</code> checks the environment: Node, the project, the framework, the dev server, a running session and the dock's bundles.</p>

<h2 id="agent">Connect your agent</h2>
${command('npx primp setup')}
<p>This registers primp's MCP server with Claude Code and Codex, after asking, and prints the configuration for Cursor. See <a href="agents.html">Connecting your agent</a> for what it runs and for the clipboard flow without MCP.</p>

<h2 id="from-source">Before it is on npm</h2>
<p>primp is pre-release and not published to npm yet, so the <code>npx</code> commands above work once it is. Until then, run it from a checkout of the repository, in the checkout's directory:</p>
${pre('pnpm install\npnpm exec tsx packages/cli/src/index.ts demo\npnpm exec tsx packages/cli/src/index.ts --project ~/code/your-app\npnpm exec tsx packages/cli/src/index.ts setup')}
<p>Run this way, <code>setup</code> registers the MCP server with absolute paths into the checkout, so your agent can reach it without the npm package.</p>

<h2 id="next">Next</h2>
<ul>
<li><a href="dock.html">Using the dock</a>: edits, states, reorder, resize, Send.</li>
<li><a href="verification.html">Verification statuses</a>: what pass, drift and fail mean, and the statuses that are not a pass.</li>
<li><a href="limits.html">Limits and privacy</a>.</li>
</ul>`,
  },
  {
    slug: 'dock.html',
    title: 'Using the dock',
    description: 'Pick an element, edit CSS at rest or in a state, resize, reorder, hide, and send the changes to your agent. Side effects and bystanders.',
    body: (root) => `
<h1>Using the dock</h1>
<p class="lede">The dock is a small panel primp adds to every page it serves. It has three tabs: <strong>Edits</strong> for changes, <strong>Shifts</strong> for layout shifts and <strong>Verify</strong> for the results after your agent edited the source.</p>
<p>It opens in the bottom-right corner. Drag its header, or use the move button, to put it in another corner; the minus button collapses it to a small round button. Nothing in the dock is part of your page: primp's measurements leave it out.</p>

${shot({ name: 'edit', dark: true, lazy: false, root, alt: 'The Edits tab with a button selected: its ancestors, its source line index.html:24, the media query and state controls, and the rules that style it with their values.', caption: 'A selected element: where it is in the page and in your source, the controls for media query and state, and every rule that styles it.' })}

<h2 id="pick">Pick an element</h2>
<p>Press <strong>Pick element</strong>, move the pointer over the page and click. While picking, <kbd>&uarr;</kbd> goes to the parent, <kbd>&darr;</kbd> to the first child, <kbd>&larr;</kbd> and <kbd>&rarr;</kbd> to the siblings, <kbd>Enter</kbd> picks and <kbd>Esc</kbd> stops. The breadcrumbs above the element's name select an ancestor.</p>
<p>Next to the name, primp shows where the element comes from in your source, such as <code>index.html:24</code>. A filled green dot means the position is exact: that line holds the element's tag. Otherwise the chip says <em>file</em> (the file is right, the line is a best guess) or <em>guess</em>, and the agent is told how sure the position is.</p>

<h2 id="styles">Change styles</h2>
<p>The element's rules are listed with their selector and stylesheet, and below them its computed values. Click a value to change it: <kbd>Enter</kbd> keeps it, <kbd>Esc</kbd> cancels, <kbd>&uarr;</kbd> and <kbd>&darr;</kbd> step a number by 1 (with <kbd>Shift</kbd>, by 10). <strong>Add property</strong> takes any CSS property, with completion. The page shows the change at once, as a preview; nothing is written anywhere.</p>
<ul>
<li><strong>Media query.</strong> Make the change only under one of the page's media queries, for example the one for wide screens.</li>
<li><strong>Apply to.</strong> When the same component renders several elements like this one, choose between this element and all of them.</li>
</ul>

<h2 id="states">Hover, focus and active</h2>
<p>The <strong>State</strong> control shows the element as it looks in <code>:hover</code>, <code>:focus</code>, <code>:focus-visible</code> or <code>:active</code>, without you holding the mouse still or keeping the focus there. Edits made while a state is shown are recorded for that state only. Choose <strong>Rest</strong> to go back.</p>
<p>The state is emulated from the page's own stylesheets, and verification reads the value in that state, not at rest. A hover made by script, or a rule in a stylesheet from another origin, cannot be emulated; such a change is reported as fail or not measurable, never as a pass.</p>

${shot({ name: 'hover', lazy: true, root, alt: 'The dock showing a button in its :hover state; the page shows the hover look with a ":hover" label on the button, and the dock says new edits apply to :hover only.', caption: 'The button shown in <code>:hover</code>. New edits apply to that state only.' })}

<h2 id="resize">Resize</h2>
<p>A selected element has handles on its right edge, its bottom edge and the corner. Drag one; the size is shown as you go. <kbd>Shift</kbd> on the corner keeps the aspect ratio and <kbd>Esc</kbd> cancels the drag. A resize is recorded as an ordinary <code>width</code> and <code>height</code> change (one or both) and checked like any other. There are no handles on the left and top edges.</p>

${shot({ name: 'resize', lazy: true, root, alt: 'A bean card being resized by its right-hand handle; a label shows the new size, 380 by 168.', caption: 'Dragging the right-hand handle of a card. The label shows the border-box size.' })}

<h2 id="reorder">Reorder</h2>
<p>Drag the grip above a selected element to another place among its siblings, or use <strong>Move earlier</strong> and <strong>Move later</strong>. An element moves only among the children of its parent, never into another parent. The change is verified by the order of the elements in the page, and when the elements come from a list, the agent is told to reorder the data rather than the markup.</p>

<h2 id="hide">Hide and remove</h2>
<p><strong>Hide</strong> and <strong>Remove</strong> record that the element should not be shown, or should not be there at all. The agent decides how in your code; primp checks that it is gone from view or from the page.</p>

<h2 id="side-effects">Side effects</h2>
<p>primp measures the page before and after every edit. Each recorded change carries a one-line summary of what else moved, for example <em>&ldquo;25 elements moved down 8px; .btn became 8px taller&rdquo;</em>. Open it to see the elements one by one.</p>
<p>Tick <strong>unwanted</strong> next to one and it becomes a constraint: the agent is told that element must not move, and verification checks it.</p>

<h2 id="bystanders">Bystanders</h2>
<p>A change is often made through a CSS rule that other elements share. When the value you changed came from such a rule, the dock says so (&ldquo;rule .btn also styles 1 other element&rdquo;), and primp records up to three of those elements with their current values. The agent is told not to edit the rule in place, and verification fails the change if one of them changed:</p>
<blockquote class="note"><p><code>a.btn "See this week's beans"</code> was not part of this change, but its <code>padding-top</code> went from <code>10px</code> to <code>14px</code>.</p></blockquote>
<p>State changes (<code>:hover</code> and the others) do not get this check.</p>

<h2 id="undo">Undo, notes and Send</h2>
<p><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> undoes, with <kbd>Shift</kbd> it redoes. The &times; on a change drops it. Each change has a <strong>Note for the agent</strong> field for anything the values do not say.</p>
<p><strong>Send</strong> queues the changes for your agent and copies the same instructions to your clipboard. An agent connected over MCP picks them up with <code>get_pending_changes</code>; otherwise paste the prompt. If the browser does not allow copying, the dock shows the prompt for you to copy.</p>

<h2 id="verify">The Verify tab</h2>
<p>Once your agent has edited the source, primp waits for the page to update, measures every change with its own previews switched off and shows the result per change: what was expected, what the page has, and why it failed. <strong>Check again</strong> measures once more. See <a href="verification.html">Verification statuses</a>.</p>`,
  },
  {
    slug: 'layout-shifts.html',
    title: 'Layout shifts',
    description: 'How primp records a page load, attributes each layout shift to its culprit, cause and source line, and checks a fix.',
    body: (root) => `
<h1>Layout shifts</h1>
<p class="lede">A layout shift is visible content jumping after it was first shown, scored as in Cumulative Layout Shift (CLS). primp tells you which element caused each one, why, and where it is in your source.</p>

${shot({ name: 'shifts', dark: true, lazy: false, root, alt: 'The Shifts tab: CLS 0.11, one issue with cause unsized media and culprit img#hero-art at index.html line 29, its evidence, and the picture outlined on the page as the culprit.', caption: 'The seeded shift of the demo site. <strong>Show on page</strong> outlines the culprit and the elements it moved.' })}

<h2 id="recording">What is recorded</h2>
<p>primp's head script is the first script of every page it serves. From there it records the load: the browser's layout-shift entries, changes to the DOM and who made them, element sizes, images and fonts as they arrive, and resource timing. Everything stays in your browser until primp's own process analyses it.</p>
<p>Every response through primp is sent uncached, so each load is a first visit: the load whose shifts matter most, and the one a cache would otherwise hide.</p>

<h2 id="attribution">Culprit, cause, evidence</h2>
<p>The elements that move are the victims; primp looks for the element whose change accounts for their movement. Each issue in the <strong>Shifts</strong> tab has:</p>
<ul>
<li><strong>The culprit</strong>, with its source position when primp can find it.</li>
<li><strong>The cause</strong>: <em>unsized media</em> (an image, video or frame without reserved space), <em>font swap</em> (a web font arriving and changing the size of text), <em>injected content</em> (something inserted above existing content), or <em>unknown</em>. Restyling done by the dev server itself, such as a hot update of a stylesheet, is listed but not scored.</li>
<li><strong>A confidence</strong>. A high confidence needs a geometric match: the culprit's change in size must account for how far the victims moved.</li>
<li><strong>The evidence</strong>, in plain sentences: sizes before and after, timings, whether space was reserved.</li>
</ul>
<p>When nothing explains the movement well enough, the cause is <em>unknown</em> and no culprit is named. primp prefers that to a confident guess.</p>
<p>primp's own changes to the page (its previews, the dock) are marked as they happen and never counted as your page's shifts.</p>

<h2 id="fix">Fixing one with your agent</h2>
<p>Ask your agent to fix the layout shift primp found. It reads the shifts with <code>get_layout_shifts</code>, which includes the usual fix for each cause, edits the source and calls <code>verify_layout_shift</code>. That reloads your tab three times with the cache switched off for the page and reports <span class="status ok">pass</span> only if the shift did not come back in any of them.</p>
<p>In the dock, <strong>Measure again</strong> reports the shifts of the current load again.</p>

<h2 id="accuracy">How accurate it is</h2>
<p>Attribution is measured on sets of pages written without sight of its code. On the current held-out set of 14 realistic pages, scored once:</p>
<ul>
<li>on 7 of the 10 pages that shift, the cause and the culprit were named correctly, with confidence;</li>
<li>the other 3 were reported as unknown, without a confident claim;</li>
<li>no page was given a confident wrong answer, and none of the 4 pages that must not be accused was.</li>
</ul>
<p>The goal was 8 of 10. An earlier blind set scored 5 of 11 and led to three fixes, after which it scores 11 of 11; that is no longer a measurement, so it is not quoted as one.</p>

<h2 id="limits">Limits</h2>
<ul>
<li>Layout shifts need Chromium: it is the only engine with the Layout Instability API.</li>
<li>Resources from other origins never pass through the proxy, so their timing cannot be replayed cold.</li>
<li>A dev server's shifts can differ from production. Point primp at a preview build (<code>vite preview</code>, <code>next start</code>) to check; source positions are then less precise.</li>
</ul>`,
  },
  {
    slug: 'agents.html',
    title: 'Connecting your agent',
    description: 'Register primp with Claude Code, Codex, Cursor or any MCP client, or use the clipboard.',
    body: () => `
<h1>Connecting your agent</h1>
<p class="lede">Your agent talks to primp through a small MCP server, <code>primp mcp</code>, that its host starts. It holds no state: every call finds the primp process running for the project, so it does not matter which of the two you start first.</p>

<h2 id="setup">primp setup</h2>
${command('npx primp setup')}
<p>For each client it knows, <code>setup</code> prints the client's own registration command and asks before running it. It runs a command only when that client is installed, and it never opens or writes a configuration file itself. Pass <code>--yes</code> to skip the questions.</p>

<h3 id="claude-code">Claude Code</h3>
${pre('claude mcp add primp -- npx -y primp mcp')}

<h3 id="codex">Codex</h3>
${pre('codex mcp add primp -- npx -y primp mcp')}

<h3 id="cursor">Cursor</h3>
<p>Put this in <code>.cursor/mcp.json</code> in the project. Cursor starts servers outside the project directory, hence <code>--project</code>:</p>
${pre(CURSOR_JSON)}

<h3 id="other">Any other MCP client</h3>
<p>Register a stdio server with the command <code>npx -y primp mcp</code>, started in the project directory or given <code>--project &lt;dir&gt;</code>.</p>

<h2 id="say">What to say</h2>
<p>The agent gets instructions with the tools; a plain sentence is enough:</p>
<ul>
<li><em>&ldquo;Implement the primp changes and verify them.&rdquo;</em> after you pressed Send.</li>
<li><em>&ldquo;Fix the layout shift primp found, then verify it.&rdquo;</em></li>
</ul>
<p>The agent takes the changes with <code>get_pending_changes</code>, edits the files named there, and calls <code>verify_changes</code>. If something fails, it gets the reason and a fix-up, and is told to try at most twice more before reporting what still fails. See <a href="mcp-tools.html">The six MCP tools</a>.</p>

<h2 id="clipboard">Without MCP: the clipboard</h2>
<p><strong>Send</strong> also copies the instructions to your clipboard. Paste them into any agent or chat. After the agent has edited the source, go back to the dock: primp notices that source files changed and stayed untouched for a moment, verifies the changes that were sent and not taken over MCP, and fills in the <strong>Verify</strong> tab by itself. The result has the same statuses either way.</p>

<h2 id="privacy">What the agent sees</h2>
<p>Only what you sent: the element, its source position, the values before and after, the conditions (viewport, media query, state), the side effects you marked as unwanted, and the checks that must hold. Text copied from the page is marked as data, and the agent is told never to follow instructions found in it.</p>`,
  },
  {
    slug: 'mcp-tools.html',
    title: 'The six MCP tools',
    description: 'get_session, get_pending_changes, verify_changes, get_layout_shifts, verify_layout_shift and dismiss_change: what each does and returns.',
    body: () => `
<h1>The six MCP tools</h1>
<p class="lede">What your agent can call, and what it gets back. You do not call these yourself; this page is for knowing what the agent knows.</p>

<dl class="tools">
<dt id="get_session">get_session</dt>
<dd>
<p>Is primp running for this project, and in what state. It takes no arguments and changes nothing.</p>
<p>Returns the dev server being proxied, the detected framework, whether a browser tab with the dock is attached, and how many changes there are per status: <code>draft</code> (you are still editing), <code>queued</code> (sent, waiting for an agent), <code>claimed</code> (an agent has taken them).</p>
</dd>

<dt id="get_pending_changes">get_pending_changes</dt>
<dd>
<p>Takes the changes you sent, for implementing in source. Each one names the element (selector, text, and source file and line when primp found them), what you did to it (a CSS property before and after, hide, remove, or a move among its siblings), the viewport, media query and state it was made under, the side effects you marked unwanted, and the checks that must hold afterwards. One resize can give two changes, width and height.</p>
<p>Returns them grouped by source file, and again as written instructions. Taking them marks them as claimed, so the dock shows them as in progress and a second call does not return them again. <code>batchId</code> fetches one batch a second time.</p>
</dd>

<dt id="verify_changes">verify_changes</dt>
<dd>
<p>Checks the source edits against the running page. primp waits until the dev server has applied them and the page is quiet, measures each change in your tab with its own previews switched off, and compares the result with what you recorded.</p>
<p>Returns a status per change (see <a href="verification.html">Verification statuses</a>), expected and actual values for every check, and a fix-up: everything that did not pass, written as instructions for the next edit. It blocks while the page settles, normally a second or two. Optional: <code>ids</code> to verify some changes only, <code>waitMs</code> for a slow build.</p>
</dd>

<dt id="get_layout_shifts">get_layout_shifts</dt>
<dd>
<p>The layout shifts of the last load of the page in your tab. Changes nothing and reloads nothing.</p>
<p>Returns each shift with the element that caused it, the cause, the confidence, the evidence and the culprit's source position, plus instructions with the usual fix for each known cause. A status other than <code>ok</code> means the load could not be measured, most often because the tab was hidden; that is not the same as no shifts. Optional: <code>minValue</code> to leave out small shifts.</p>
</dd>

<dt id="verify_layout_shift">verify_layout_shift</dt>
<dd>
<p>Checks that a shift is gone after a source edit. primp reloads your tab three times with the cache switched off for the page, because a cached image or font would hide the shift, and looks in each load for a shift with the same culprit or the same moved elements.</p>
<p>Returns <code>pass</code> if it came back in none of them, <code>fail</code> with how much remains if it did, or a status saying primp could not look. It visibly reloads the page and takes a few seconds per reload. Takes the shift's <code>id</code>.</p>
</dd>

<dt id="dismiss_change">dismiss_change</dt>
<dd>
<p>Closes a change without implementing it, with a reason written for you: the element is rendered by a dependency, it contradicts another change in the batch, or you asked to leave it. The dock shows the reason next to the change. Takes the change's <code>id</code> and the <code>reason</code>.</p>
</dd>
</dl>

<div class="note"><p>A result of <code>no_browser</code>, <code>tab_hidden</code> or <code>not_measurable</code> means primp could not look. The agent is told to say so rather than treat it as a pass: the tab with your app has to be open and in front.</p></div>`,
  },
  {
    slug: 'verification.html',
    title: 'Verification statuses',
    description: 'pass, drift, fail and the statuses that mean primp could not measure. None of the latter is counted as success.',
    body: (root) => `
<h1>Verification statuses</h1>
<p class="lede">A change only passes when the page was measured and the value is there. Everything else has a status of its own.</p>
${statusTable()}
<p>The last three, <code>not_measurable</code>, <code>tab_hidden</code> and <code>no_browser</code>, are never counted as success. Neither are <code>no_update_observed</code> and <code>unresolved</code>.</p>

${shot({ name: 'verify', dark: true, lazy: true, root, alt: 'The Verify tab: the letter-spacing change of the headline passed; the padding change of a button failed, because another button that shares the .btn rule changed its padding too.', caption: 'One pass and one fail on the demo site. The stylesheet was edited by a script standing in for an agent: it changed the shared <code>.btn</code> rule in place, so the other button changed too.' })}

<h2 id="how">How a change is checked</h2>
<p>When you record a change, primp derives the checks that must hold once the source matches: the computed value of each property you changed (a shorthand such as <code>padding</code> becomes its longhands), the values of the bystanders, and &ldquo;must not move&rdquo; for each side effect you marked unwanted.</p>
<p>To verify, primp waits for the dev server to apply the edit and for the page to be quiet, switches its previews off so it sees only what your source produces, measures in your tab and judges each check.</p>
<ul>
<li><strong>Values</strong> are compared as computed values, so <code>1rem</code> and <code>16px</code> agree.</li>
<li><strong>States</strong> are measured with the state emulated, not at rest.</li>
<li><strong>Reorders</strong> are checked by the order of the elements in the page.</li>
<li><strong>Resizes</strong> are width and height changes, checked like any other.</li>
<li><strong>Static HTML</strong> has no hot reload; primp reloads the page before measuring.</li>
</ul>

<h2 id="drift">Drift</h2>
<p><span class="status warn">drift</span> means the value landed close to the one you asked for, as happens when the agent used the nearest design token instead of a literal. The agent is told to keep it only if that was intended, and to say so. You decide whether it is right.</p>

<h2 id="fail">Fail</h2>
<p>A <span class="status bad">fail</span> comes with expected and actual values, and a hint. When an element you did not touch changed with the change, the hint names it and says why, for example that a shared rule was edited in place. The agent gets the same text as a fix-up.</p>`,
  },
  {
    slug: 'limits.html',
    title: 'Limits and privacy',
    description: 'What primp does not do, what has not been tested, and what it sends where: nothing beyond your machine.',
    body: () => `
<h1>Limits and privacy</h1>

<h2 id="privacy">Privacy</h2>
<p>primp runs on your machine and talks only to your dev server and your browser. It has no telemetry and makes no network requests of its own. The proxy accepts connections from <code>localhost</code> only. The MCP server it registers runs on your machine too, started by your agent's host.</p>

<h2 id="tested">What has been tested</h2>
${testedMatrix()}
<ul>
<li><strong>Other frameworks</strong> (Vue, Astro, Solid, Angular, server-rendered templates): the proxy and the dock are framework-independent and should work; source positions fall back to ranked guesses. Untested.</li>
<li><strong>Browsers:</strong> only Chromium has been run. Layout shifts need it in any case.</li>
<li><strong>Systems:</strong> only macOS has been run. On Windows, pass <code>--target</code>.</li>
<li><strong>Layout-shift attribution:</strong> 7 of 10 shifting pages named correctly with confidence on a held-out set, the other 3 reported as unknown, no confident wrong answer. See <a href="layout-shifts.html#accuracy">How accurate it is</a>.</li>
</ul>

<h2 id="limits">Known limits</h2>
<ul>
<li>Because the proxy listens on its own port, logins kept in <code>localStorage</code> and OAuth redirect URLs tied to the dev server's port do not carry over.</li>
<li>Every response through primp is sent uncached, so each load is a first visit. That is deliberate (it is the load whose layout shifts matter, and an edit is never hidden by a stale stylesheet), but pages load a little slower than straight from the dev server.</li>
<li>A dev server's shifts can differ from production. Point primp at <code>vite preview</code> or <code>next start</code> to check; source positions are then less precise.</li>
<li>Resources from other origins never pass through the proxy, so their timing cannot be replayed cold.</li>
<li>If your app opens a modal <code>&lt;dialog&gt;</code>, the dock cannot be used until it closes.</li>
<li>Reordering moves an element among the children of its parent only, never into another parent.</li>
<li>Resize has right, bottom and corner handles; there are none on the left and top edges.</li>
<li><code>:hover</code> and focus changes are verified by emulating the state from the page's readable stylesheets. Behaviour made by script (a class added on mouse-over) and rules in stylesheets from another origin cannot be checked: such a change is reported as <code>fail</code> or <code>not_measurable</code>, never as a pass.</li>
<li>State changes do not get the bystander check: other elements that share the rule are not recorded for them.</li>
<li>A preview cannot override an author <code>!important</code> of higher specificity.</li>
</ul>`,
  },
  {
    slug: 'faq.html',
    title: 'FAQ',
    description: 'Common questions about primp: how it differs from a screenshot and a prompt, whether it writes code, frameworks and browsers.',
    body: (root) => `
<h1>FAQ</h1>

<h2 id="screenshot">How is this different from a screenshot and a prompt?</h2>
<p>A screenshot shows the result you want; it does not say which element, which source line, which property, under which media query or state, or what else on the page moved. The agent has to guess all of that, and you have to check its work by eye.</p>
<p>primp records the change itself: the element and its line in your source, the exact values before and after, the conditions, the side effects and the elements that share the rule. After the agent's edit it measures the page and reports pass, drift or fail per change, so the agent can correct itself without you looking at every pixel.</p>

<h2 id="writes-code">Does it write my code?</h2>
<p>No. primp never writes to your source files. Your agent makes the edits, in your project's own style; primp tells it what to change and checks the result.</p>

<h2 id="framework">Does it work with my framework?</h2>
<p>It has been tested end to end with Vite + React 19, Next 16 (Turbopack, Server Components, strict CSP), SvelteKit (Svelte 5) and plain HTML. The proxy and the dock do not depend on a framework, so others should work, but they are untested and source positions fall back to ranked guesses. See <a href="limits.html#tested">What has been tested</a>.</p>

<h2 id="browsers">Which browsers?</h2>
<p>Only Chromium has been run. The dock may work elsewhere, untested; layout shifts need Chromium in any case, as it is the only engine with the Layout Instability API.</p>

<h2 id="data">Does it send anything anywhere?</h2>
<p>No. No telemetry, no requests of its own; the proxy accepts connections from <code>localhost</code> only. What reaches your agent is what you send with the Send button, and the agent's own host decides where that goes.</p>

<h2 id="agents">Which agents?</h2>
<p>Any MCP client: <code>primp setup</code> registers it with Claude Code and Codex and prints the Cursor configuration. Without MCP, paste the prompt that Send copies; primp still verifies once the source changes.</p>

<h2 id="production">Can I point it at production?</h2>
<p>primp is for development: it sits in front of a server on your machine. To see shifts closer to production, run it in front of a local preview build.</p>

<h2 id="demo">What does the live demo run?</h2>
<p>The <a href="${root}demo/">live demo</a> runs primp's real dock, layout-shift recorder, source lookup, prompt and attribution code in your browser, on a copy of the demo site. A small stand-in replaces primp's server. There is no agent, so nothing is verified there.</p>`,
  },
]

function sidebar(current: string): string {
  const items = DOCS.map((doc) => `<li><a href="${doc.slug === 'index.html' ? './' : doc.slug}"${doc.slug === current ? ' aria-current="page"' : ''}>${esc(doc.title)}</a></li>`).join('\n')
  return `<nav class="docs-nav" aria-label="Documentation"><p class="docs-nav-title">Docs</p><ol>\n${items}\n</ol></nav>`
}

function pager(index: number): string {
  const href = (doc: DocPage): string => (doc.slug === 'index.html' ? './' : doc.slug)
  const previous = DOCS[index - 1]
  const next = DOCS[index + 1]
  return `<nav class="pager" aria-label="Previous and next">${previous === undefined ? '' : `<a class="prev" href="${href(previous)}"><span>Previous</span>${esc(previous.title)}</a>`}${next === undefined ? '' : `<a class="next" href="${href(next)}"><span>Next</span>${esc(next.title)}</a>`}</nav>`
}

export function docPages(): { path: string; html: string }[] {
  return DOCS.map((doc, index) => {
    const path = `docs/${doc.slug}`
    const body = `<div class="wrap docs">
${sidebar(doc.slug)}
<main id="main" class="prose">
${doc.body('../')}
${pager(index)}
</main>
</div>`
    return { path, html: page({ path, title: doc.title, description: doc.description, section: 'docs', body }) }
  })
}
