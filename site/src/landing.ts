/**
 * The landing page. Every example it quotes comes from assets/shots/facts.json and prompt.txt,
 * which site/capture.ts wrote from a real run of primp on the demo site.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { command, esc, page, shot, SHOTS_DIR } from './layout.ts'
import { testedMatrix } from './shared.ts'

interface Facts {
  shift: { cause: string; value: number; culprit: string; confidence: number; evidence: string[]; source: string | null; level: string | null }
  edit: { label: string; summary: string; source: string; bystanders: string[] }
  verify: { summary: string; results: { status: string; hint: string }[] }
}

function readFacts(): Facts {
  const facts = JSON.parse(readFileSync(join(SHOTS_DIR, 'facts.json'), 'utf8')) as Facts
  if (facts.shift?.source == null || facts.edit?.summary === undefined || facts.verify?.results === undefined) {
    throw new Error('assets/shots/facts.json is incomplete: run `pnpm exec tsx site/capture.ts`')
  }
  return facts
}

/** The prompt from `## \`index.html\`` on, trimmed to the first change and its notes. */
function promptExcerpt(): string {
  const prompt = readFileSync(join(SHOTS_DIR, 'prompt.txt'), 'utf8')
  const start = prompt.indexOf('## `index.html`')
  const body = start < 0 ? prompt : prompt.slice(start)
  return body.split('\n').slice(0, 26).join('\n').trim()
}

/** Inline `code` spans of a hint, as HTML. */
function codeSpans(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function landing(): string {
  const facts = readFacts()
  const root = ''
  const fail = facts.verify.results.find((result) => result.status === 'fail')
  const pass = facts.verify.results.find((result) => result.status === 'pass')
  if (fail === undefined || pass === undefined) throw new Error('facts.json: the verify capture should hold one pass and one fail')
  const firstSentence = fail.hint.split('. ')[0] + '.'
  const moved = facts.shift.evidence.find((line) => line.includes('moved down'))
  const reserved = facts.shift.evidence.find((line) => line.includes('not reserved'))
  const cls = facts.shift.value.toFixed(2)

  const body = `<main id="main">
<section class="hero" aria-labelledby="hero-title">
<div class="wrap">
<p class="eyebrow">Open source, MIT. Runs on your machine.</p>
<h1 id="hero-title">Edit the page. Your agent edits the code. primp checks they match.</h1>
<p class="lede">primp is a proxy you run in front of your dev server. It adds a dock to your app: you change the running page by hand, your coding agent writes the change into your source, and primp measures the page again and reports pass, drift or fail for every change.</p>
<div class="actions">
<a class="button primary" href="demo/">Try the live demo</a>
<a class="button" href="docs/">Get started</a>
</div>
${command('npx primp demo')}
${shot({
  name: 'tray',
  dark: true,
  root,
  alt: `The primp dock open on a small coffee-shop page. Two recorded changes: the padding of the "Start a subscription" button, with the note "${facts.edit.summary}", and the letter spacing of the headline. Each names its line in index.html.`,
  caption: `The dock on the page of <code>npx primp demo</code>. Two changes recorded, each with its source line; the first one moved other things on the page: &ldquo;${esc(facts.edit.summary)}&rdquo;.`,
})}
</div>
</section>

<section class="section" aria-labelledby="loop-title">
<div class="wrap">
<div class="section-head">
<h2 id="loop-title">Edit, hand off, verify</h2>
<p>You make the change where you can see it. The agent does the part it is good at, finding the right place in your code. primp checks the result against the page, not against the agent's account of it.</p>
</div>
<ol class="steps">
<li class="step">
<h3>Change the running page</h3>
<p>Pick an element and change any CSS property, at rest or for <code>:hover</code> or <code>:focus</code>. Resize it by its edge, move it among its siblings, hide or remove it. primp records the change, its source line and what else moved.</p>
<div class="frame">${shot({ name: 'step-edit', dark: true, lazy: true, root, alt: 'The Edits tab of the dock listing two changes: padding 10px 18px to 14px 26px on a button at index.html line 24, and letter-spacing on the headline at line 21.' })}</div>
</li>
<li class="step">
<h3>Your agent writes it</h3>
<p>Press Send. Your agent takes the changes over MCP, or you paste the prompt. This is the start of the prompt Send produced for those two changes:</p>
<div class="frame"><pre>${esc(promptExcerpt())}</pre></div>
</li>
<li class="step">
<h3>primp checks the page</h3>
<p>Once the source changes, primp waits for the page to update, measures each change in your tab and reports the result. Here the shared <code>.btn</code> rule was edited in place, so another button changed too: <span class="status bad">fail</span>.</p>
<div class="frame">${shot({ name: 'step-verify', dark: true, lazy: true, root, alt: `The Verify tab: the letter-spacing change passed; the padding change failed because ${firstSentence.replace(/`/g, '')}` })}</div>
</li>
</ol>
<p class="muted" style="margin-top:16px;font-size:0.9rem">Screenshots from a real run of <code>npx primp demo</code>. For the third step a script stood in for the agent and edited the stylesheet; the verdicts are primp's own.</p>
</div>
</section>

<section class="section" aria-labelledby="diff-title">
<div class="wrap">
<div class="section-head">
<h2 id="diff-title">Built around what happens before and after the hand-off</h2>
<p>Editing a live page and passing the result to an agent is the easy part. These three are where the work went.</p>
</div>
<div class="cards">
<article class="card">
<h3>Side effects and bystanders</h3>
<p>Every edit is measured. primp lists what else on the page moved; mark one as unwanted and it becomes a constraint the agent must keep. When a change is made through a CSS rule that other elements share, primp records those elements and fails the change if one of them moved.</p>
<div class="example"><span class="example-label">From the demo</span>
<p>${esc(facts.edit.summary)}</p>
<p>${codeSpans(firstSentence)}</p>
</div>
</article>
<article class="card">
<h3>Layout shifts, attributed</h3>
<p>primp records the page load from its first script and names the element that caused each shift, the cause (an image without reserved space, a web font swapping in, content inserted above) and the line in your source.</p>
<div class="example"><span class="example-label">From the demo</span>
<p>${esc(facts.shift.culprit)}: unsized media, ${esc(facts.shift.source ?? '')}, ${Math.round(facts.shift.confidence * 100)}% confident</p>
${reserved === undefined ? '' : `<p>${esc(reserved)}</p>`}
</div>
</article>
<article class="card">
<h3>Verification that never passes unmeasured</h3>
<p>A change passes only when the page was measured and the value is there. A hidden tab, a closed browser, a state that cannot be emulated, an element that cannot be found again: each has its own status, and none of them counts as success.</p>
<div class="example"><span class="example-label">Statuses</span>
<p><span class="status ok">pass</span> <span class="status warn">drift</span> <span class="status bad">fail</span> <span class="status bad">build_error</span> <span class="status none">no_update_observed</span> <span class="status none">unresolved</span> <span class="status none">not_measurable</span> <span class="status none">tab_hidden</span> <span class="status none">no_browser</span></p>
</div>
</article>
</div>
<div class="wide-shot">
${shot({
  name: 'shifts',
  dark: true,
  lazy: true,
  root,
  alt: `The Shifts tab: CLS ${cls}, one issue, cause unsized media, culprit img#hero-art at index.html line 29, with the evidence listed; on the page the picture is outlined as the culprit.`,
  caption: `The Shifts tab on the demo page. The picture has no reserved space; ${esc(moved ?? 'the content below it moves when it loads')}. <a href="docs/layout-shifts.html">How attribution works</a>.`,
})}
</div>
</div>
</section>

<section class="section" aria-labelledby="try-title">
<div class="wrap">
<div class="section-head">
<h2 id="try-title">Try it</h2>
<p>Needs Node 22.22 or later in the 22 line, or 24.11 and later. Nothing is installed in your project and primp never writes to your source files.</p>
</div>
<div class="try">
<div>
<h3>See it on a demo site</h3>
${command('npx primp demo')}
<p>Copies a one-page site with one seeded layout shift into <code>./primp-demo</code>, serves it and opens it with the dock. The terminal tells you what to say to your agent.</p>
</div>
<div>
<h3>Run it on your project</h3>
${command('npx primp')}
<p>In your project, with your dev server running. primp finds the server, starts a proxy on the next port and opens your app through it.</p>
</div>
<div>
<h3>Connect your agent</h3>
${command('npx primp setup')}
<p>Asks before running Claude Code's or Codex's own command to register primp's MCP server, and prints the configuration for Cursor. Without MCP, Send copies the prompt.</p>
</div>
</div>
<div class="note" style="margin-top:28px"><p><strong>Pre-release.</strong> primp is not on npm yet, so these commands work once it is published. Until then you can run it from the repository (see <a href="docs/#from-source">Getting started</a>), or try the <a href="demo/">live demo</a>, which runs the real dock in your browser.</p></div>
</div>
</section>

<section class="section" aria-labelledby="tested-title">
<div class="wrap">
<div class="section-head">
<h2 id="tested-title">What is tested</h2>
<p>Each claim below has an end-to-end script in the repository that exits 0 or 1.</p>
</div>
<div class="numbers">
<div>
${testedMatrix()}
<ul class="muted">
<li>Other frameworks (Vue, Astro, Solid, Angular, server-rendered templates): the proxy and the dock are framework-independent and should work; source positions fall back to ranked guesses. Untested.</li>
<li>Only Chromium and only macOS have been run. Layout shifts need Chromium in any case: it is the only engine with the Layout Instability API.</li>
</ul>
</div>
<div class="stat">
<span class="big">7 of 10</span>
<p>Layout-shift attribution on 14 realistic pages written without sight of the attribution code, scored once. On 7 of the 10 pages that shift, primp named the cause and the culprit correctly, with confidence.</p>
<p>The other 3 it reported as &ldquo;unknown&rdquo;, without a confident claim. No page got a confident wrong answer, and none of the 4 pages that must not be accused was. The goal was 8 of 10.</p>
<p class="muted">So: when it names a culprit with confidence, it was right on every page of this set; on 3 of 10 it said it did not know. An earlier blind set scored 5 of 11 and led to three fixes; it now scores 11 of 11, which no longer counts as a measurement.</p>
</div>
</div>
</div>
</section>

<section class="section" aria-labelledby="limits-title">
<div class="wrap">
<div class="section-head">
<h2 id="limits-title">Limits</h2>
<p>The ones you are most likely to meet. <a href="docs/limits.html">All limits, and privacy</a>.</p>
</div>
<ul>
<li>The proxy runs on its own port, so logins kept in <code>localStorage</code> and OAuth redirects tied to the dev server's port do not carry over.</li>
<li>Every response through primp is sent uncached, so each load is a first visit. Pages load a little slower than straight from the dev server.</li>
<li>A <code>:hover</code> made by script, or a rule in a stylesheet from another origin, cannot be checked: such a change is reported as fail or not measurable, never as a pass.</li>
<li>A dev server's shifts can differ from production. Point primp at a preview build to check.</li>
</ul>
</div>
</section>
</main>`

  return page({
    path: 'index.html',
    title: 'primp: edit your running app, let your agent write the code, verify the result',
    description: 'primp is a local proxy that adds a dock to your app: edit the page by hand, your coding agent implements the change, and primp re-measures the page and reports pass, drift or fail. Open source, MIT, no telemetry.',
    section: 'home',
    body,
  })
}
