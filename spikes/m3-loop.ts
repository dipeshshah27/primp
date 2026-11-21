/**
 * M3: the closed loop, end to end, with nothing faked except the agent's judgement.
 *
 *   developer (Playwright driving the real dock through window.__reglet_test)
 *     -> edits in the page, presses Send
 *   agent (an MCP client over the real `reglet mcp` stdio shim)
 *     -> get_pending_changes, then a scripted source patch (right, wrong, near miss, none, broken),
 *     -> verify_changes
 *   reglet -> waits for the dev server to apply the patch, measures the page, judges.
 *
 * Passes when each kind of patch gets the status the plan names for it, and nothing
 * is ever reported as pass without the source having been edited to match.
 *
 * Parts: Vite + React 19; Next 16 with Turbopack, Server Components and a strict nonce CSP;
 * SvelteKit with Svelte 5; plain HTML with no hot reload.
 *
 *   pnpm spike:m3-loop            all parts
 *   pnpm spike:m3-loop vite       one part: vite | next | svelte | static (the run then counts as incomplete)
 */

import type { ChangeItem } from '../packages/protocol/src/change.ts'
import { createReport, editFile, expect, newPage, replaceOnce, runCleanups, sleep, waitFor } from './lib/index.ts'
import { startLoop } from './lib/loop.ts'

const only = process.argv[2]
const report = createReport('M3 closed loop: edit in the dock, agent patches source, reglet verifies')

async function vite(): Promise<void> {
  const loop = await startLoop('vite-react-19', { shimCwd: 'src' })
  const { fixture, page, record, verify, describe, itemStatus } = loop
  const one = loop.only

  report.section('Vite + React 19: setup')
  const ready = await report.attempt('the dock loads through reglet and the MCP shim lists verify_changes', async () => {
    await loop.open('/')
    const names = (await loop.client.listTools()).tools.map((tool) => tool.name)
    expect(names.includes('verify_changes'), `tools: ${names.join(', ')}`)
    return `dock ready at ${loop.reglet.url}; tools ${names.join(', ')}`
  })
  if (!ready) return

  report.section('Vite A. A correct patch passes; without a patch it never does')
  let cardItem: ChangeItem | undefined
  await report.attempt('before the source is edited: no_update_observed, not pass', async () => {
    cardItem = await loop.editAndClaim('[data-label="card"]', { property: 'padding', value: '28px' })
    const result = one((await verify([cardItem.id], 1200)).outcome)
    expect(result.status === 'no_update_observed', `status ${describe(result)}`)
    expect(itemStatus(cardItem.id) === 'failed', `item status ${itemStatus(cardItem.id)}`)
    return describe(result)
  })
  await report.attempt('after the agent sets padding: 28px in Card.module.css: pass, item verified, shown in the dock', async () => {
    expect(cardItem !== undefined, 'no item from the previous check')
    const id = (cardItem as ChangeItem).id
    editFile(fixture, 'src/components/Card.module.css', replaceOnce('gap: 8px;\n  padding: 20px;', 'gap: 8px;\n  padding: 28px;'))
    const { outcome } = await verify([id])
    const result = one(outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(result.attempt === 2, `attempt ${result.attempt}`)
    expect(outcome.fixup === '', 'a fix-up prompt was returned for a pass')
    expect(itemStatus(id) === 'verified', `item status ${itemStatus(id)}`)
    const inPage = await page.evaluate(() => getComputedStyle(document.querySelector('[data-label="card"]') as Element).paddingTop)
    expect(inPage === '28px', `the page shows padding-top ${inPage}`)
    const shown = await loop.shownStatus(id)
    expect(shown === 'pass', `the dock shows ${shown}`)
    return describe(result)
  })

  report.section('Vite B. A wrong patch fails with expected and actual; the corrected patch passes')
  let navItem: ChangeItem | undefined
  await report.attempt('padding-left asked 16px, agent wrote 11px: fail, and the fix-up names both values', async () => {
    navItem = await loop.editAndClaim('.site-nav a', { property: 'padding-left', value: '16px' })
    editFile(fixture, 'src/styles/site.css', replaceOnce('padding: 6px 10px;', 'padding: 6px 11px;'))
    const { outcome, text } = await verify([navItem.id])
    const result = one(outcome)
    expect(result.status === 'fail', `status ${describe(result)}`)
    expect(outcome.fixup.includes('16px') && outcome.fixup.includes('11px'), `the fix-up does not name 16px and 11px:\n${outcome.fixup}`)
    expect(text.includes(navItem.id), 'the tool text does not name the change')
    expect(itemStatus(navItem.id) === 'failed', `item status ${itemStatus(navItem.id)}`)
    return describe(result)
  })
  await report.attempt('the agent corrects it to 16px: pass on the next attempt', async () => {
    expect(navItem !== undefined, 'no item from the previous check')
    const id = (navItem as ChangeItem).id
    editFile(fixture, 'src/styles/site.css', replaceOnce('padding: 6px 11px;', 'padding: 6px 16px;'))
    const result = one((await verify([id])).outcome)
    expect(result.status === 'pass' && result.attempt === 2, `status ${describe(result)}`)
    expect(itemStatus(id) === 'verified', `item status ${itemStatus(id)}`)
    return describe(result)
  })

  report.section('Vite C. A near miss is drift, not pass and not fail')
  await report.attempt('font-size asked 29px, agent used a 28px step: drift', async () => {
    const item = await loop.editAndClaim('.pricing__title', { property: 'font-size', value: '29px' })
    editFile(fixture, 'src/styles/site.css', replaceOnce('.pricing__title {\n  font-size: 24px;', '.pricing__title {\n  font-size: 28px;'))
    const { outcome } = await verify([item.id])
    const result = one(outcome)
    expect(result.status === 'drift', `status ${describe(result)}`)
    expect(outcome.fixup.includes('28px') && outcome.fixup.includes('29px'), 'the fix-up does not name both values')
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    return describe(result)
  })

  report.section('Vite D. A broken build is reported as build_error, and the loop recovers')
  await report.attempt('the agent leaves a syntax error in Hero.tsx: build_error with the message; after the repair the same change passes', async () => {
    const item = await loop.editAndClaim('[data-label="hero-subtitle"]', { property: 'letter-spacing', value: '1px', scope: 'instance' })
    const broken = editFile(fixture, 'src/components/Hero.tsx', replaceOnce('<p data-label="hero-subtitle" className="', '<p data-label="hero-subtitle" style={{ letterSpacing: \'1px\' } className="'))
    const first = one((await verify([item.id])).outcome)
    expect(first.status === 'build_error', `status ${describe(first)}`)
    expect(first.hint.length > 20, 'the hint does not carry the build error')
    expect(itemStatus(item.id) === 'failed', `item status ${itemStatus(item.id)}`)
    broken.revert()
    await sleep(300)
    editFile(fixture, 'src/components/Hero.tsx', replaceOnce('<p data-label="hero-subtitle" className="', '<p data-label="hero-subtitle" style={{ letterSpacing: \'1px\' }} className="'))
    const second = one((await verify([item.id], 8000)).outcome)
    expect(second.status === 'pass', `after the repair: ${describe(second)}`)
    return `broken: ${describe(first)}\n        repaired: ${describe(second)}`
  })

  report.section('Vite E. A media-scoped change is not judged outside its media query')
  await report.attempt('gap inside @media (min-width: 768px): not_measurable at 600px wide, pass at 1280px', async () => {
    const item = await loop.editAndClaim('.pricing-grid', { property: 'gap', value: '24px', media: '(min-width: 768px)' })
    expect(item.kind === 'style' && item.condition.media === '(min-width: 768px)', `recorded media: ${item.kind === 'style' ? item.condition.media : '-'}`)
    editFile(fixture, 'src/styles/site.css', replaceOnce('    grid-template-columns: repeat(3, minmax(0, 1fr));', '    grid-template-columns: repeat(3, minmax(0, 1fr));\n    gap: 24px;'))
    await page.setViewportSize({ width: 600, height: 900 })
    const narrow = one((await verify([item.id])).outcome)
    expect(narrow.status === 'not_measurable', `at 600px: ${describe(narrow)}`)
    expect(itemStatus(item.id) === 'claimed', `item status at 600px: ${itemStatus(item.id)}`)
    await page.setViewportSize({ width: 1280, height: 900 })
    const wide = one((await verify([item.id])).outcome)
    expect(wide.status === 'pass', `at 1280px: ${describe(wide)}`)
    return `600px: ${describe(narrow)}\n        1280px: ${describe(wide)}`
  })

  report.section('Vite F. Removing and hiding an element')
  await report.attempt('remove the banner: still rendered is fail, removed from Home.tsx is pass', async () => {
    const item = await loop.editAndClaim('[data-label="banner"]', 'remove')
    // A patch that does something else: the banner is still there.
    editFile(fixture, 'src/components/Banner.tsx', replaceOnce('className="banner__text"', 'className="banner__text" title="still here"'))
    const still = one((await verify([item.id])).outcome)
    expect(still.status === 'fail', `with the banner still rendered: ${describe(still)}`)
    editFile(fixture, 'src/pages/Home.tsx', replaceOnce('      <Banner />\n', ''))
    const gone = one((await verify([item.id])).outcome)
    expect(gone.status === 'pass', `after removing it: ${describe(gone)}`)
    const present = await page.evaluate(() => document.querySelector('[data-label="banner"]') !== null)
    expect(!present, 'the banner is still in the page')
    return `still rendered: ${describe(still)}\n        removed: ${describe(gone)}`
  })
  await report.attempt('hide the hero art: hidden with the hidden attribute is pass, and the element stays in the DOM', async () => {
    const item = await loop.editAndClaim('[data-label="hero-art"]', 'hide')
    editFile(fixture, 'src/components/Hero.tsx', replaceOnce('<div data-label="hero-art" ', '<div data-label="hero-art" hidden style={{ display: \'none\' }} '))
    const result = one((await verify([item.id])).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    const state = await page.evaluate(() => {
      const el = document.querySelector('[data-label="hero-art"]')
      return el === null ? 'absent' : getComputedStyle(el).display
    })
    expect(state === 'none', `the element is ${state}`)
    return describe(result)
  })

  report.section('Vite G. Without MCP: a pasted prompt is verified by itself after the source changes')
  await report.attempt('a queued change nobody claimed turns verified in the dock once the source matches', async () => {
    const { item, prompt } = await loop.editAndSend('.pricing__lead', { property: 'margin-top', value: '14px' })
    expect(prompt.includes('return to the reglet dock'), 'the clipboard prompt does not tell the agent to send the user back to the dock')
    expect(itemStatus(item.id) === 'queued', `item status ${itemStatus(item.id)}`)
    editFile(fixture, 'src/styles/site.css', replaceOnce('.pricing__lead {\n  margin-top: 8px;', '.pricing__lead {\n  margin-top: 14px;'))
    const started = Date.now()
    await waitFor(() => itemStatus(item.id) === 'verified', { what: 'automatic verification', timeoutMs: 12_000 })
    const shown = await loop.shownStatus(item.id)
    expect(shown === 'pass', `the dock shows ${shown}`)
    return `verified ${Date.now() - started} ms after the file was written, with no MCP call; the dock shows ${shown}`
  })

  report.section('Vite H. Bystanders: a rule shared with elements outside the change must not be edited in place')
  // `.plan` (site.css) sets the gap of all three plan cards. The two plain ones are instances of each
  // other (`div.plan`); the featured one (`div.plan.plan--featured`) is styled by the same rule and is not.
  const PLAIN_PLAN = '.plan:not(.plan--featured)'
  const gapOf = (selector: string): Promise<string> => page.evaluate((sel) => getComputedStyle(document.querySelector(sel) as Element).rowGap, selector)
  let planItem: ChangeItem | undefined
  let featuredLabel = ''
  await report.attempt('gap of the two plain plans, all instances: the featured plan is recorded as the one bystander, and the agent prompt says to leave the rule alone', async () => {
    const { item } = await loop.editAndSend(PLAIN_PLAN, { property: 'gap', value: '16px', scope: 'all-instances' })
    expect(item.kind === 'style', 'not a style change')
    if (item.kind !== 'style') return ''
    expect(item.target.instanceCount === 2, `instances: ${item.target.instanceCount}`)
    expect(item.origin?.via === 'rule' && item.origin.selector === '.plan', `origin: ${JSON.stringify(item.origin)}`)
    expect(item.origin?.alsoStyles !== undefined && item.origin.alsoStyles >= 1, `origin.alsoStyles: ${item.origin?.alsoStyles}`)
    const bystanders = item.bystanders ?? []
    // The other plain plan is an instance, so it is part of the change; only the featured plan is left.
    expect(item.origin?.alsoStyles === 1 && bystanders.length === 1, `alsoStyles ${item.origin?.alsoStyles}, bystanders: ${JSON.stringify(bystanders.map((entry) => entry.label))}`)
    const featured = bystanders[0]!
    featuredLabel = featured.label
    const isFeatured = await page.evaluate((selector) => document.querySelector(selector)?.classList.contains('plan--featured') === true, featured.selector)
    expect(isFeatured && featured.label.includes('Team'), `the bystander is ${featured.label} (${featured.selector})`)
    expect(featured.values['row-gap'] === '12px' && featured.values['column-gap'] === '12px', `recorded values: ${JSON.stringify(featured.values)}`)
    const kinds = item.expect.map((entry) => (entry.type === 'unchanged' ? `unchanged ${entry.property}` : entry.type))
    expect(kinds.filter((kind) => kind.startsWith('unchanged')).length === 2, `expectations: ${kinds.join(', ')}`)

    const pending = await loop.takePending()
    const claimed = pending.files.flatMap((group) => group.items)
    expect(claimed.length === 1 && claimed[0]?.id === item.id && claimed[0].status === 'claimed', `claimed: ${claimed.map((entry) => `${entry.id} ${entry.status}`).join(', ')}`)
    planItem = claimed[0]
    const section = pending.prompt.slice(pending.prompt.indexOf(`### \`${item.id}\``))
    expect(section.includes(featured.label), `the prompt does not name the bystander ${featured.label}:\n${section}`)
    expect(section.includes('That rule also styles 1 other element') && section.includes('Do not edit the rule in place'), `the prompt does not say to leave the rule alone:\n${section}`)
    expect(!section.includes('Change the shared source (the component or the CSS rule)'), 'the prompt still offers the shared CSS rule as the place to edit')
    expect(pending.prompt.includes('never edit such a rule in place'), 'the introduction does not take back "edit the shared CSS rule"')
    const line = section.split('\n').find((text) => text.startsWith('- Previous value set by:')) ?? ''
    return `alsoStyles ${item.origin?.alsoStyles}; bystander ${featured.label} with ${JSON.stringify(featured.values)}; expectations ${kinds.join(', ')}\n        prompt: ${line}`
  })
  await report.attempt('the agent edits the shared .plan rule: the plain plans are right, the featured plan changed with them: fail, and the fix-up names it', async () => {
    expect(planItem !== undefined, 'no item from the previous check')
    const id = (planItem as ChangeItem).id
    editFile(fixture, 'src/styles/site.css', replaceOnce('  gap: 12px;\n  padding: 24px;', '  gap: 16px;\n  padding: 24px;'))
    const { outcome } = await verify([id])
    const result = one(outcome)
    expect(result.status === 'fail', `status ${describe(result)}`)
    const own = result.checks.filter((check) => check.expectation.type === 'computed')
    const others = result.checks.filter((check) => check.expectation.type === 'unchanged')
    expect(own.length === 2 && own.every((check) => check.status === 'pass'), `the change itself: ${own.map((check) => `${check.status} ${check.actual}`).join(', ')}`)
    expect(others.length === 2 && others.every((check) => check.status === 'fail' && check.expected === '12px' && check.actual === '16px'), `bystander checks: ${others.map((check) => `${check.status} ${check.expected} -> ${check.actual}`).join(', ')}`)
    expect(result.hint.includes(featuredLabel) && result.hint.includes('The rule you edited is shared'), `hint: ${result.hint}`)
    expect(outcome.fixup.includes(featuredLabel) && outcome.fixup.includes('was not part of this change') && outcome.fixup.includes('went from `12px` to `16px`'), `the fix-up does not name the bystander:\n${outcome.fixup}`)
    expect(itemStatus(id) === 'failed', `item status ${itemStatus(id)}`)
    expect((await gapOf('.plan--featured')) === '16px', 'the featured plan did not change in the page: the scenario is not what it claims')
    return describe(result)
  })
  await report.attempt('the agent restores .plan and adds a rule for the plain plans only: pass, the bystander kept its gap', async () => {
    expect(planItem !== undefined, 'no item from the previous check')
    const id = (planItem as ChangeItem).id
    editFile(
      fixture,
      'src/styles/site.css',
      replaceOnce('  gap: 16px;\n  padding: 24px;', '  gap: 12px;\n  padding: 24px;'),
    )
    editFile(fixture, 'src/styles/site.css', replaceOnce('.plan:hover {', '.plan:not(.plan--featured) {\n  gap: 16px;\n}\n\n.plan:hover {'))
    const { outcome } = await verify([id])
    const result = one(outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    const others = result.checks.filter((check) => check.expectation.type === 'unchanged')
    expect(others.length === 2 && others.every((check) => check.status === 'pass' && check.actual === '12px' && check.note === undefined), `bystander checks: ${others.map((check) => `${check.status} ${check.actual} ${check.note ?? ''}`).join(', ')}`)
    expect(outcome.fixup === '', 'a fix-up prompt was returned for a pass')
    expect(itemStatus(id) === 'verified', `item status ${itemStatus(id)}`)
    const inPage = [await gapOf(PLAIN_PLAN), await gapOf('.plan--featured')]
    expect(inPage[0] === '16px' && inPage[1] === '12px', `in the page: plain ${inPage[0]}, featured ${inPage[1]}`)
    return `${describe(result)}\n        in the page: plain plans ${inPage[0]}, featured plan ${inPage[1]}`
  })

  // Closes the tab, so it stays the last scenario of this part.
  report.section('Vite I. No browser, no verdict')
  await report.attempt('with the tab closed a matching source is reported as no_browser, not pass', async () => {
    const item = await loop.editAndClaim('.pricing__lead', { property: 'color', value: 'rgb(51, 65, 85)' })
    editFile(fixture, 'src/styles/site.css', replaceOnce('  color: #475569;\n}\n\n.pricing-grid', '  color: #334155;\n}\n\n.pricing-grid'))
    await sleep(600)
    await page.close()
    await sleep(300)
    const result = one((await verify([item.id], 1500)).outcome)
    expect(result.status === 'no_browser', `status ${describe(result)}`)
    expect(itemStatus(item.id) === 'claimed', `item status ${itemStatus(item.id)}`)
    return describe(result)
  })

  const unexpected = record
    .consoleErrors()
    .map((entry) => entry.text)
    .filter((line) => !/Hero\.tsx|Failed to (load|fetch)|500|Internal Server Error|\[vite\]|hmr/i.test(line))
  report.check('no console errors in the page during the loop (the syntax-error step aside)', unexpected.length === 0, unexpected.slice(0, 5).join('\n') || 'none')
}

async function next(): Promise<void> {
  const loop = await startLoop('next-16-turbopack')
  const { fixture, page, record, verify, describe, itemStatus } = loop
  const one = loop.only

  // Next's own dev tools violate the fixture's strict policy by themselves. A violation counts against
  // reglet unless the same one happens on the page without it, or it is on reglet's own elements.
  const key = (violation: { effectiveDirective: string; blockedURI: string; target: string }): string => `${violation.effectiveDirective} ${violation.blockedURI} (${violation.target})`
  const baseline = await newPage(loop.browser)
  await baseline.page.goto(`${fixture.url}/`, { waitUntil: 'load' })
  await sleep(1500)
  const own = new Set(baseline.record.cspViolations.map(key))
  const ownCount = baseline.record.cspViolations.length
  await baseline.close()
  const fromReglet = (): string[] =>
    record.cspViolations.filter((violation) => !own.has(key(violation)) || violation.target === 'reglet-root' || violation.documentURI === 'about:blank').map((violation) => `${key(violation)} in ${violation.documentURI}`)

  report.section('Next 16 + Turbopack (strict nonce CSP): setup')
  const ready = await report.attempt('the dock loads under the strict CSP and adds no violation of its own', async () => {
    await loop.open('/')
    await sleep(1000)
    expect(fromReglet().length === 0, `CSP violations from reglet: ${fromReglet().slice(0, 3).join(' | ')}`)
    return `dock ready at ${loop.reglet.url}; framework ${loop.reglet.framework}; 0 violations from reglet (the page has ${ownCount} of its own without reglet, ${record.cspViolations.length} with it)`
  })
  if (!ready) return

  report.section('Next A. A Server Component styled by a CSS module')
  await report.attempt('card padding 16px -> 22px in page.module.css: fail on a wrong patch, pass on the right one', async () => {
    const item = await loop.editAndClaim('[data-label="home-card-edits"]', { property: 'padding', value: '22px' })
    expect(item.target.source?.file === 'app/page.tsx', `source ${item.target.source?.file}:${item.target.source?.line} (${item.target.source?.level})`)
    editFile(fixture, 'app/page.module.css', replaceOnce('.card {\n  padding: 16px;', '.card {\n  padding: 18px;'))
    const wrong = one((await verify([item.id], 8000)).outcome)
    expect(wrong.status === 'fail', `wrong patch: ${describe(wrong)}`)
    editFile(fixture, 'app/page.module.css', replaceOnce('.card {\n  padding: 18px;', '.card {\n  padding: 22px;'))
    const right = one((await verify([item.id], 8000)).outcome)
    expect(right.status === 'pass' && right.attempt === 2, `right patch: ${describe(right)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    return `source ${item.target.source?.file}:${item.target.source?.line} (${item.target.source?.level})\n        wrong: ${describe(wrong)}\n        right: ${describe(right)}`
  })

  report.section('Next B. An inline style written into a Server Component')
  await report.attempt('h1 letter-spacing: the agent edits app/page.tsx (a server render), pass', async () => {
    const item = await loop.editAndClaim('[data-label="home-title"]', { property: 'letter-spacing', value: '-0.5px', scope: 'instance' })
    editFile(fixture, 'app/page.tsx', replaceOnce('<h1 data-label="home-title">', '<h1 data-label="home-title" style={{ letterSpacing: \'-0.5px\' }}>'))
    const result = one((await verify([item.id], 8000)).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    return describe(result)
  })

  report.section('Next C. A Client Component')
  await report.attempt('counter value font-size 24px -> 32px in Counter.module.css: pass, and the component keeps working', async () => {
    const item = await loop.editAndClaim('[data-label="counter-value"]', { property: 'font-size', value: '32px' })
    editFile(fixture, 'components/client/Counter.module.css', replaceOnce('font-size: 1.5rem;', 'font-size: 2rem;'))
    const result = one((await verify([item.id], 8000)).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    const before = await page.textContent('[data-label="counter-value"]')
    await page.click('[data-label="counter-inc"]')
    const after = await page.textContent('[data-label="counter-value"]')
    expect(Number(after) === Number(before) + 1, `counter went from ${before} to ${after}`)
    return `${describe(result)}; counter ${before} -> ${after} after a click`
  })

  report.section('Next D. A broken build')
  await report.attempt('a syntax error in a client component: build_error; repaired: the pending change passes', async () => {
    const item = await loop.editAndClaim('[data-label="home-lede"]', { property: 'max-width', value: '48ch', scope: 'instance' })
    const broken = editFile(fixture, 'components/client/Counter.tsx', replaceOnce('const [count, setCount] = useState(initial)', 'const [count, setCount] = useState(initial'))
    const first = one((await verify([item.id], 8000)).outcome)
    expect(first.status === 'build_error', `status ${describe(first)}`)
    broken.revert()
    await sleep(500)
    editFile(fixture, 'app/page.module.css', replaceOnce('.lede {\n  max-width: 60ch;', '.lede {\n  max-width: 48ch;'))
    const second = one((await verify([item.id], 10_000)).outcome)
    expect(second.status === 'pass', `after the repair: ${describe(second)}`)
    return `broken: ${first.status}; hint: ${first.hint.slice(0, 160)}\n        repaired: ${describe(second)}`
  })

  report.check('reglet added no CSP violation during the whole Next loop', fromReglet().length === 0, fromReglet().slice(0, 3).join(' | ') || 'none')
}

async function svelte(): Promise<void> {
  const loop = await startLoop('sveltekit-svelte-5')
  const { fixture, verify, describe, itemStatus } = loop
  const one = loop.only

  report.section('SvelteKit + Svelte 5')
  await report.attempt('a scoped component style (Hero.svelte): wrong patch fails, right patch passes, source is Hero.svelte', async () => {
    await loop.open('/')
    const item = await loop.editAndClaim('[data-label="hero-title"]', { property: 'font-size', value: '52px' })
    expect(item.target.source?.file === 'src/lib/components/Hero.svelte', `source ${item.target.source?.file}:${item.target.source?.line} (${item.target.source?.level})`)
    editFile(fixture, 'src/lib/components/Hero.svelte', replaceOnce('font-size: 44px;', 'font-size: 47px;'))
    const wrong = one((await verify([item.id], 8000)).outcome)
    expect(wrong.status === 'fail', `wrong patch: ${describe(wrong)}`)
    editFile(fixture, 'src/lib/components/Hero.svelte', replaceOnce('font-size: 47px;', 'font-size: 52px;'))
    const right = one((await verify([item.id], 8000)).outcome)
    expect(right.status === 'pass', `right patch: ${describe(right)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    return `source ${item.target.source?.file}:${item.target.source?.line} (${item.target.source?.level})\n        wrong: ${describe(wrong)}\n        right: ${describe(right)}`
  })
  await report.attempt('a syntax error in a Svelte component: build_error', async () => {
    const item = await loop.editAndClaim('[data-label="hero-lede"]', { property: 'font-size', value: '21px' })
    const broken = editFile(fixture, 'src/lib/components/Hero.svelte', replaceOnce('<p class="lede" data-label="hero-lede">{lede}</p>', '<p class="lede" data-label="hero-lede">{lede</p>'))
    const result = one((await verify([item.id], 8000)).outcome)
    broken.revert()
    expect(result.status === 'build_error', `status ${describe(result)}`)
    return `${result.status}; hint: ${result.hint.slice(0, 200)}`
  })
}

async function staticSite(): Promise<void> {
  const loop = await startLoop('static-html')
  const { fixture, page, record, verify, describe, itemStatus } = loop
  const one = loop.only

  report.section('Plain HTML, no build step and no hot reload')
  await report.attempt('the agent edits css/site.css; reglet reloads the page by itself and then judges: fail, then pass', async () => {
    await loop.open('/')
    const item = await loop.editAndClaim('[data-label="hero-title"]', { property: 'font-size', value: '52px' })
    expect(item.target.source?.file === 'index.html', `source ${item.target.source?.file}:${item.target.source?.line} (${item.target.source?.level})`)
    const loadsBefore = record.documentRequests.length
    editFile(fixture, 'css/site.css', replaceOnce('  font-size: 46px;', '  font-size: 48px;'))
    const wrong = one((await verify([item.id], 1500)).outcome)
    expect(wrong.status === 'fail', `wrong patch: ${describe(wrong)}`)
    expect(wrong.checks[0]?.actual === '48px', `the page was not reloaded before measuring: actual ${wrong.checks[0]?.actual}`)
    editFile(fixture, 'css/site.css', replaceOnce('  font-size: 48px;', '  font-size: 52px;'))
    const right = one((await verify([item.id], 1500)).outcome)
    expect(right.status === 'pass', `right patch: ${describe(right)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    const reloads = record.documentRequests.length - loadsBefore
    expect(reloads === 2, `the page was loaded ${reloads} times for two verifications`)
    const shown = await loop.shownStatus(item.id)
    expect(shown === 'pass', `after the reload the dock shows ${shown}`)
    return `source ${item.target.source?.file}:${item.target.source?.line} (${item.target.source?.level}); ${reloads} reloads by reglet\n        wrong: ${describe(wrong)}\n        right: ${describe(right)}`
  })
  await report.attempt('removing an element from index.html: pass after the reload', async () => {
    const item = await loop.editAndClaim('[data-label="hero-emphasis"]', 'remove')
    editFile(fixture, 'index.html', (source) => source.replace(/<em data-label="hero-emphasis">([^<]*)<\/em>/, '$1'))
    const result = one((await verify([item.id], 1500)).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    const present = await page.evaluate(() => document.querySelector('[data-label="hero-emphasis"]') !== null)
    expect(!present, 'the element is still in the page')
    return describe(result)
  })
  await report.attempt('without a source edit: no_update_observed and no reload', async () => {
    const item = await loop.editAndClaim('[data-label="hero-lede"]', { property: 'font-size', value: '21px' })
    const loadsBefore = record.documentRequests.length
    const result = one((await verify([item.id], 1200)).outcome)
    expect(result.status === 'no_update_observed', `status ${describe(result)}`)
    expect(record.documentRequests.length === loadsBefore, 'the page was reloaded although nothing changed')
    return describe(result)
  })
}

const PARTS: Record<string, () => Promise<void>> = { vite, next, svelte, static: staticSite }

try {
  for (const [name, run] of Object.entries(PARTS)) {
    if (only !== undefined && only !== name) continue
    await run()
    await runCleanups()
  }
  if (only !== undefined) report.skip('all four fixtures', `only "${only}" was run, so the spike is incomplete`)
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
  // If something still holds the process open two seconds from now, say what, and leave.
  setTimeout(() => {
    const handles = (process as unknown as { _getActiveHandles(): { constructor: { name: string }; remoteAddress?: string; remotePort?: number; spawnfile?: string }[] })._getActiveHandles()
    console.error(`still open after cleanup: ${handles.map((handle) => `${handle.constructor.name}${handle.remotePort === undefined ? '' : `(${handle.remoteAddress}:${handle.remotePort})`}${handle.spawnfile === undefined ? '' : `(${handle.spawnfile})`}`).join(', ')}`)
    process.exit(process.exitCode ?? 0)
  }, 2000).unref()
}
