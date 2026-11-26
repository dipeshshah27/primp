/**
 * M3: the closed loop, end to end, with nothing faked except the agent's judgement.
 *
 *   developer (Playwright driving the real dock through window.__primp_test)
 *     -> edits in the page, presses Send
 *   agent (an MCP client over the real `primp mcp` stdio shim)
 *     -> get_pending_changes, then a scripted source patch (right, wrong, near miss, none, broken),
 *     -> verify_changes
 *   primp -> waits for the dev server to apply the patch, measures the page, judges.
 *
 * Passes when each kind of patch gets the status the plan names for it, and nothing
 * is ever reported as pass without the source having been edited to match.
 *
 * Parts: Vite + React 19; Next 16 with Turbopack, Server Components and a strict nonce CSP;
 * SvelteKit with Svelte 5; plain HTML with no hot reload.
 *
 *   pnpm spike:m3-loop            all parts
 *   pnpm spike:m3-loop vite       one part: vite | next | svelte | static | notes (the run then counts as incomplete)
 */

import type { ChangeItem } from '../packages/protocol/src/change.ts'
import { createReport, editFile, expect, newPage, replaceOnce, runCleanups, sleep, waitFor } from './lib/index.ts'
import { startLoop } from './lib/loop.ts'

const only = process.argv[2]
const report = createReport('M3 closed loop: edit in the dock, agent patches source, primp verifies')

/** The part of an agent prompt about one change: from its heading on. */
const sectionOf = (prompt: string, id: string): string => {
  const at = prompt.indexOf(`### \`${id}\``)
  return at < 0 ? '' : prompt.slice(at)
}

async function vite(): Promise<void> {
  const loop = await startLoop('vite-react-19', { shimCwd: 'src' })
  const { fixture, page, record, verify, describe, itemStatus } = loop
  const one = loop.only

  report.section('Vite + React 19: setup')
  const ready = await report.attempt('the dock loads through primp and the MCP shim lists verify_changes', async () => {
    await loop.open('/')
    const names = (await loop.client.listTools()).tools.map((tool) => tool.name)
    expect(names.includes('verify_changes'), `tools: ${names.join(', ')}`)
    return `dock ready at ${loop.primp.url}; tools ${names.join(', ')}`
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

  report.section('Vite W. Watching: the agent waits, the developer presses Send, nobody switches windows')
  await report.attempt('wait_for_changes: the dock shows the agent waiting, Send wakes it with the change claimed, its patch passes', async () => {
    const waiting = loop.tool('wait_for_changes', { timeoutMs: 30_000 })
    // The dock learns an agent is waiting: the Send button gets its dot.
    await waitFor(() => page.locator('primp-root').evaluate((host) => host.shadowRoot?.querySelector<HTMLIFrameElement>('iframe[data-primp-dock="bar"]')?.contentDocument?.querySelector('.tb.send .waiting') != null), { what: 'the waiting dot on Send', timeoutMs: 5000 })
    await loop.dock('open', true)
    const { item } = await loop.editAndSend('.pricing__title', { property: 'font-weight', value: '700', scope: 'all-instances' })
    const woke = await waiting
    // The dock says the agent has the changes (the server decided it at Send), instead of asking for a paste.
    const notice = await waitFor(
      async () => {
        const text = await page.locator('primp-root').evaluate((host) => [...(host.shadowRoot?.querySelectorAll('iframe') ?? [])].map((frame) => frame.contentDocument?.body?.innerText ?? '').join('\n'))
        return /Your agent was waiting and has the change now/.test(text) ? text : undefined
      },
      { what: 'the dock saying the agent has the change', timeoutMs: 5000 },
    )
    void notice
    const pending = woke.structuredContent as { count: number; files: { items: { id: string; status: string }[] }[] }
    expect(woke.isError !== true && pending.count === 1 && pending.files[0]?.items[0]?.id === item.id && itemStatus(item.id) === 'claimed', `wait_for_changes answered: ${JSON.stringify(woke.structuredContent).slice(0, 300)}`)
    // Section C left the title at 28px.
    editFile(fixture, 'src/styles/site.css', replaceOnce('.pricing__title {\n  font-size: 28px;\n  font-weight: 600;', '.pricing__title {\n  font-size: 28px;\n  font-weight: 700;'))
    const result = one((await verify([item.id])).outcome)
    expect(result.status === 'pass' && itemStatus(item.id) === 'verified', `status ${describe(result)}`)
    return `woken by Send with ${pending.count} change claimed; ${describe(result)}`
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
    expect(prompt.includes('return to the primp dock'), 'the clipboard prompt does not tell the agent to send the user back to the dock')
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

  report.section('Vite J. A change made in the :hover state')
  // The plan CTAs (three instances of one button in PricingTable.tsx) have `.plan__cta { background-color: #0f172a }`
  // at rest and `.plan__cta:hover { background-color: #1e293b }` in src/styles/site.css.
  const CTA = '[data-label="plan-cta"]'
  const restingBackground = (): Promise<string> => page.evaluate((sel) => getComputedStyle(document.querySelector(sel) as Element).backgroundColor, CTA)
  /** The CTA's background under a real mouse hover, read once the pointer is on it; the pointer is moved off afterwards. */
  const hoveredBackground = async (): Promise<string> => {
    await page.hover(CTA)
    await sleep(100)
    const value = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel) as Element).backgroundColor, CTA)
    await page.mouse.move(1, 1)
    return value
  }
  await report.attempt('hover background #1e293b -> #0f172a: the claimed change is for :hover, the prompt names the .plan__cta:hover rule; the agent edits that rule: pass, the resting background is unchanged', async () => {
    const restingBefore = await restingBackground()
    const { item: recorded } = await loop.editAndSend(CTA, { property: 'background-color', value: '#0f172a', state: 'hover' })
    const { items, prompt } = await loop.claim(1)
    const item = items[0] as ChangeItem
    expect(item.id === recorded.id, `claimed ${item.id}, recorded ${recorded.id}`)
    expect(item.kind === 'style' && item.condition.state === 'hover', `condition: ${item.kind === 'style' ? JSON.stringify(item.condition) : item.kind}`)
    if (item.kind !== 'style') return ''
    expect(item.before.computed === 'rgb(30, 41, 59)', `the value before, in the hover state: ${item.before.computed}`)
    expect(item.origin?.via === 'rule' && item.origin.selector === '.plan__cta:hover', `origin: ${JSON.stringify(item.origin)}`)
    const section = sectionOf(prompt, item.id)
    expect(section.includes('only in the `:hover` state'), `the prompt does not limit the change to :hover:\n${section}`)
    expect(section.includes('`.plan__cta:hover`'), `the prompt does not name the .plan__cta:hover rule:\n${section}`)
    const line = section.split('\n').find((text) => text.startsWith('- Previous value')) ?? ''
    editFile(fixture, 'src/styles/site.css', replaceOnce('.plan__cta:hover {\n  background-color: #1e293b;', '.plan__cta:hover {\n  background-color: #0f172a;'))
    const { outcome } = await verify([item.id])
    const result = one(outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(outcome.fixup === '', 'a fix-up prompt was returned for a pass')
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    const forced = (await loop.dock('state')).forced
    expect(forced === null, `a state is still forced on the page: ${JSON.stringify(forced)}`)
    const restingAfter = await restingBackground()
    expect(restingAfter === restingBefore, `the resting background went from ${restingBefore} to ${restingAfter}`)
    const hovered = await hoveredBackground()
    expect(hovered === 'rgb(15, 23, 42)', `under a real mouse hover the background is ${hovered}`)
    return `${describe(result)}\n        prompt: ${line}\n        in the page: resting ${restingAfter} (was ${restingBefore}), real hover ${hovered}`
  })
  let hoverItem: ChangeItem | undefined
  await report.attempt('hover background -> #334155, the agent edits the RESTING .plan__cta rule instead: fail, the hover value is unchanged and the fix-up names the :hover state', async () => {
    hoverItem = await loop.editAndClaim(CTA, { property: 'background-color', value: '#334155', state: 'hover' })
    expect(hoverItem.kind === 'style' && hoverItem.condition.state === 'hover', 'not a :hover change')
    editFile(fixture, 'src/styles/site.css', replaceOnce('  border-radius: 8px;\n  background-color: #0f172a;', '  border-radius: 8px;\n  background-color: #334155;'))
    const { outcome } = await verify([hoverItem.id])
    const result = one(outcome)
    expect(result.status === 'fail', `status ${describe(result)}`)
    const check = result.checks.find((entry) => entry.expectation.type === 'computed')
    expect(check?.status === 'fail' && check.actual === 'rgb(15, 23, 42)', `the hover check: ${check?.status} expected ${check?.expected} actual ${check?.actual}`)
    expect(outcome.fixup.includes('`:hover`'), `the fix-up does not mention the :hover state:\n${outcome.fixup}`)
    expect(itemStatus(hoverItem.id) === 'failed', `item status ${itemStatus(hoverItem.id)}`)
    const resting = await restingBackground()
    expect(resting === 'rgb(51, 65, 85)', `the wrong patch did not reach the page: resting ${resting}`)
    return `${describe(result)}\n        fix-up: ${outcome.fixup.split('\n').filter((text) => text.includes(':hover')).slice(0, 2).join(' / ')}`
  })
  await report.attempt('the agent puts the resting rule back and edits .plan__cta:hover: pass on the next attempt', async () => {
    expect(hoverItem !== undefined, 'no item from the previous check')
    const id = (hoverItem as ChangeItem).id
    editFile(fixture, 'src/styles/site.css', replaceOnce('  border-radius: 8px;\n  background-color: #334155;', '  border-radius: 8px;\n  background-color: #0f172a;'))
    editFile(fixture, 'src/styles/site.css', replaceOnce('.plan__cta:hover {\n  background-color: #0f172a;', '.plan__cta:hover {\n  background-color: #334155;'))
    const result = one((await verify([id])).outcome)
    expect(result.status === 'pass' && result.attempt === 2, `status ${describe(result)}`)
    expect(itemStatus(id) === 'verified', `item status ${itemStatus(id)}`)
    const resting = await restingBackground()
    const hovered = await hoveredBackground()
    expect(resting === 'rgb(15, 23, 42)' && hovered === 'rgb(51, 65, 85)', `in the page: resting ${resting}, real hover ${hovered}`)
    return `${describe(result)}\n        in the page: resting ${resting}, real hover ${hovered}`
  })

  report.section('Vite K. Reordering the pricing plans (rendered by plans.map from src/data/plans.json)')
  const planNames = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('[data-label="plan-name"]')].map((element) => element.textContent?.trim() ?? ''))
  /** The agent rewrites plans.json with its entries in this order of ids, one entry per line as the file has them. */
  const orderPlans = (ids: string[]): void => {
    editFile(fixture, 'src/data/plans.json', (source) => {
      const byId = new Map((JSON.parse(source) as { id: string }[]).map((plan) => [plan.id, plan]))
      return `[\n${ids.map((id) => `  ${JSON.stringify(byId.get(id))}`).join(',\n')}\n]\n`
    })
  }
  await report.attempt('the first plan moved one place later: the prompt says to reorder the data; Send leaves the page as it was; the agent swaps the first two entries of plans.json: pass, the page has the new order', async () => {
    const { item, prompt } = await loop.reorderAndClaim('[data-label="plan"]', { by: 1 })
    expect(item.kind === 'structure' && item.move?.fromIndex === 0 && item.move.toIndex === 1, `move: ${item.kind === 'structure' ? JSON.stringify({ from: item.move?.fromIndex, to: item.move?.toIndex }) : item.kind}`)
    const section = sectionOf(prompt, item.id)
    expect(section.includes('move this element') && section.includes('change the order of the data'), `the prompt does not say to move the element by reordering the data:\n${section}`)
    const afterSend = await planNames()
    expect(afterSend.join() === 'Starter,Team,Scale', `after Send the page shows ${afterSend.join(', ')}, not the original order`)
    orderPlans(['team', 'starter', 'scale'])
    const { outcome } = await verify([item.id])
    const result = one(outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(outcome.fixup === '', 'a fix-up prompt was returned for a pass')
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    const inPage = await planNames()
    expect(inPage.join() === 'Team,Starter,Scale', `the page shows ${inPage.join(', ')}`)
    const line = section.split('\n').find((text) => text.startsWith('- Do: move')) ?? ''
    return `${describe(result)}\n        prompt: ${line}\n        in the page: ${inPage.join(', ')}`
  })
  let lastPlan: ChangeItem | undefined
  const at = (text: string, name: string): number => text.indexOf(name)
  /** True when `text` names the three plans in this order. */
  const readsInOrder = (text: string, names: string[]): boolean => names.every((name, index) => at(text, name) >= 0 && (index === 0 || at(text, names[index - 1] as string) < at(text, name)))
  await report.attempt('the last plan (Scale) moved to the front; the agent moves the wrong item (Starter to the end): fail, and the fix-up gives the order found', async () => {
    const { item } = await loop.reorderAndClaim('[data-label="pricing-grid"] > [data-label="plan"]:last-child', { to: 0 })
    lastPlan = item
    expect(item.kind === 'structure' && item.move?.fromIndex === 2 && item.move.toIndex === 0, `move: ${item.kind === 'structure' ? JSON.stringify({ from: item.move?.fromIndex, to: item.move?.toIndex }) : item.kind}`)
    orderPlans(['team', 'scale', 'starter'])
    const { outcome } = await verify([item.id])
    const result = one(outcome)
    expect(result.status === 'fail', `status ${describe(result)}`)
    const check = result.checks.find((entry) => entry.expectation.type === 'order')
    expect(check?.status === 'fail' && readsInOrder(check.actual, ['Team', 'Scale']), `the order check: ${check?.status} expected ${check?.expected} actual ${check?.actual}`)
    const fixupLine = outcome.fixup.split('\n').find((text) => readsInOrder(text, ['Team', 'Scale'])) ?? ''
    expect(fixupLine !== '', `the fix-up does not give the order found (Team, then Scale):\n${outcome.fixup}`)
    expect(itemStatus(item.id) === 'failed', `item status ${itemStatus(item.id)}`)
    const inPage = await planNames()
    expect(inPage.join() === 'Team,Scale,Starter', `the page shows ${inPage.join(', ')}`)
    return `${describe(result)}\n        fix-up: ${fixupLine.trim()}`
  })
  await report.attempt('the agent then reverses the original array (Scale, Starter, Team): Scale is first but Team does not follow it as asked: fail', async () => {
    expect(lastPlan !== undefined, 'no item from the previous check')
    const id = (lastPlan as ChangeItem).id
    orderPlans(['scale', 'starter', 'team'])
    const { outcome } = await verify([id])
    const result = one(outcome)
    const inPage = await planNames()
    expect(inPage.join() === 'Scale,Starter,Team', `the page shows ${inPage.join(', ')}`)
    expect(result.status === 'fail', `the page reads ${inPage.join(', ')}, the user asked for Scale, Team, Starter: status ${describe(result)}`)
    const check = result.checks.find((entry) => entry.expectation.type === 'order')
    // The sentence that reports what was found must give the page's actual order (other lines name the plans in other orders).
    const found = outcome.fixup.split('\n').find((line) => line.includes('Found:') && line.includes('the order in the page is')) ?? ''
    const actualPart = found.slice(found.indexOf('the order in the page is'), found.indexOf('the wanted order'))
    expect(check?.status === 'fail' && readsInOrder(actualPart, ['Scale', 'Starter', 'Team']), `the order check: ${check?.status} actual ${check?.actual}; fix-up:\n${outcome.fixup}`)
    return describe(result)
  })
  await report.attempt('the agent puts Scale in front of Team and Starter: pass', async () => {
    expect(lastPlan !== undefined, 'no item from the previous check')
    const id = (lastPlan as ChangeItem).id
    orderPlans(['scale', 'team', 'starter'])
    const result = one((await verify([id])).outcome)
    expect(result.status === 'pass' && result.attempt === 3, `status ${describe(result)}`)
    expect(itemStatus(id) === 'verified', `item status ${itemStatus(id)}`)
    const inPage = await planNames()
    expect(inPage.join() === 'Scale,Team,Starter', `the page shows ${inPage.join(', ')}`)
    return `${describe(result)}\n        in the page: ${inPage.join(', ')}`
  })

  report.section('Vite L. Resizing a card by its corner: width and height from one gesture')
  // The CSS value a border-box size needs is worked out here from the page's own box model, independently of the dock.
  const CARD = '[data-label="card"]'
  const cssLength = async (axis: 'width' | 'height', borderBox: number): Promise<string> => {
    const box = await page.evaluate(([sel, which]) => {
      const style = getComputedStyle(document.querySelector(sel) as Element)
      const sides = which === 'width' ? ['left', 'right'] : ['top', 'bottom']
      const extra = sides.reduce((sum, side) => sum + Number.parseFloat(style.getPropertyValue(`padding-${side}`)) + Number.parseFloat(style.getPropertyValue(`border-${side}-width`)), 0)
      return { sizing: style.boxSizing, extra }
    }, [CARD, axis] as const)
    return `${Math.round(box.sizing === 'border-box' ? borderBox : borderBox - box.extra)}px`
  }
  let sized: { width?: ChangeItem; height?: ChangeItem; wantWidth: number; wantHeight: number; cssWidth: string; wrongWidth: string } | undefined
  await report.attempt('the corner dragged 40px wider and 30px taller: two items (width, height), sent as one batch; the agent gets the width wrong in Card.module.css: width fails, height passes', async () => {
    const box = await loop.borderBox(CARD)
    const wantWidth = Math.round(box.width) + 40
    const wantHeight = Math.round(box.height) + 30
    const cssWidth = await cssLength('width', wantWidth)
    const cssHeight = await cssLength('height', wantHeight)
    const wrongWidth = `${Number.parseFloat(cssWidth) + 12}px`
    const { recorded, items } = await loop.resizeAndClaim(CARD, { width: wantWidth, height: wantHeight })
    const byProperty = new Map(items.map((item) => [item.kind === 'style' ? item.property : item.kind, item]))
    expect(recorded.length === 2 && byProperty.has('width') && byProperty.has('height'), `recorded ${recorded.length}: ${[...byProperty.keys()].join(', ')}`)
    expect(new Set(items.map((item) => item.batchId)).size === 1 && items[0]?.batchId !== undefined, `batches: ${items.map((item) => item.batchId).join(', ')}`)
    const width = byProperty.get('width') as ChangeItem
    const height = byProperty.get('height') as ChangeItem
    sized = { width, height, wantWidth, wantHeight, cssWidth, wrongWidth }
    const css = (item: ChangeItem): string => (item.kind === 'style' ? item.after.authored : '')
    expect(css(width) === cssWidth && css(height) === cssHeight, `recorded width ${css(width)}, height ${css(height)} for a border box of ${wantWidth} x ${wantHeight}; the page's box model gives ${cssWidth} x ${cssHeight}`)
    // The "agent": the height as asked, the width 12px off.
    editFile(fixture, 'src/components/Card.module.css', replaceOnce('  background-color: #ffffff;\n}', `  background-color: #ffffff;\n  width: ${wrongWidth};\n  height: ${css(height)};\n}`))
    const { outcome } = await verify([width.id, height.id])
    const results = new Map(outcome.results.map((result) => [result.itemId, result]))
    const w = results.get(width.id)
    const h = results.get(height.id)
    expect(w?.status === 'fail', `width: ${w === undefined ? 'no result' : describe(w)}`)
    expect(h?.status === 'pass', `height: ${h === undefined ? 'no result' : describe(h)}`)
    expect(outcome.fixup.includes(`### \`${width.id}\``) && !outcome.fixup.includes(`### \`${height.id}\``) && outcome.fixup.includes(`Passed, leave as it is: \`${height.id}\``), `the fix-up should restate the width only and leave the height alone:\n${outcome.fixup}`)
    expect(itemStatus(width.id) === 'failed' && itemStatus(height.id) === 'verified', `item status width ${itemStatus(width.id)}, height ${itemStatus(height.id)}`)
    return `asked ${wantWidth} x ${wantHeight} border box (was ${box.width} x ${box.height}): width ${css(width)}, height ${css(height)}\n        width: ${w === undefined ? '-' : describe(w)}\n        height: ${h === undefined ? '-' : describe(h)}`
  })
  await report.attempt('the agent corrects the width: both pass, and the card has the dragged border-box size', async () => {
    expect(sized?.width !== undefined && sized.height !== undefined, 'no items from the previous check')
    const { width, height, wantWidth, wantHeight, cssWidth, wrongWidth } = sized as { width: ChangeItem; height: ChangeItem; wantWidth: number; wantHeight: number; cssWidth: string; wrongWidth: string }
    editFile(fixture, 'src/components/Card.module.css', replaceOnce(`  width: ${wrongWidth};`, `  width: ${cssWidth};`))
    const { outcome } = await verify([width.id, height.id])
    const statuses = outcome.results.map((result) => `${result.itemId === width.id ? 'width' : 'height'} ${describe(result)}`)
    expect(outcome.results.length === 2 && outcome.results.every((result) => result.status === 'pass'), statuses.join('\n'))
    expect(itemStatus(width.id) === 'verified' && itemStatus(height.id) === 'verified', `item status width ${itemStatus(width.id)}, height ${itemStatus(height.id)}`)
    const box = await loop.borderBox(CARD)
    expect(Math.round(box.width) === wantWidth && Math.round(box.height) === wantHeight, `the card is ${box.width} x ${box.height}, asked ${wantWidth} x ${wantHeight}`)
    return `${statuses.join('\n        ')}\n        in the page: ${box.width} x ${box.height}`
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
  // primp unless the same one happens on the page without it, or it is on primp's own elements.
  const key = (violation: { effectiveDirective: string; blockedURI: string; target: string }): string => `${violation.effectiveDirective} ${violation.blockedURI} (${violation.target})`
  const baseline = await newPage(loop.browser)
  await baseline.page.goto(`${fixture.url}/`, { waitUntil: 'load' })
  await sleep(1500)
  const own = new Set(baseline.record.cspViolations.map(key))
  const ownCount = baseline.record.cspViolations.length
  await baseline.close()
  const fromPrimp = (): string[] =>
    record.cspViolations.filter((violation) => !own.has(key(violation)) || violation.target === 'primp-root' || violation.documentURI === 'about:blank').map((violation) => `${key(violation)} in ${violation.documentURI}`)

  report.section('Next 16 + Turbopack (strict nonce CSP): setup')
  const ready = await report.attempt('the dock loads under the strict CSP and adds no violation of its own', async () => {
    await loop.open('/')
    await sleep(1000)
    expect(fromPrimp().length === 0, `CSP violations from primp: ${fromPrimp().slice(0, 3).join(' | ')}`)
    return `dock ready at ${loop.primp.url}; framework ${loop.primp.framework}; 0 violations from primp (the page has ${ownCount} of its own without primp, ${record.cspViolations.length} with it)`
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
    // Selecting the element opened the dock, whose clicks select; closed, the click is the app's again.
    await page.evaluate(() => window.__primp_test!.open(false))
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

  report.section('Next E. A :hover change where the page has no :hover rule')
  // The home CTA (`.cta` in app/page.module.css) has a resting background and no :hover rule anywhere.
  const HOME_CTA = '[data-label="home-hero"] > a'
  await report.attempt('hover background on the home CTA: the prompt names the resting .cta rule as not limited to :hover; the agent ADDS a .cta:hover rule to page.module.css: pass', async () => {
    const resting = (): Promise<string> => page.evaluate((sel) => getComputedStyle(document.querySelector(sel) as Element).backgroundColor, HOME_CTA)
    const restingBefore = await resting()
    const { item: recorded } = await loop.editAndSend(HOME_CTA, { property: 'background-color', value: '#1d4ed8', state: 'hover' })
    const { items, prompt } = await loop.claim(1)
    const item = items[0] as ChangeItem
    expect(item.id === recorded.id && item.kind === 'style' && item.condition.state === 'hover', `claimed ${item.id} (${item.kind === 'style' ? JSON.stringify(item.condition) : item.kind})`)
    if (item.kind !== 'style') return ''
    expect(item.before.computed === restingBefore, `the value before in :hover is ${item.before.computed}, the resting one ${restingBefore}`)
    expect(item.origin !== undefined && !/:hover/.test(item.origin.selector ?? ''), `origin: ${JSON.stringify(item.origin)}`)
    const section = sectionOf(prompt, item.id)
    expect(section.includes('only in the `:hover` state'), `the prompt does not limit the change to :hover:\n${section}`)
    const line = section.split('\n').find((text) => text.startsWith('- Previous value')) ?? ''
    expect(!/rule `[^`]*:hover`/.test(section), `the prompt claims an existing :hover rule:\n${section}`)
    expect(line.includes('not limited to `:hover`') && line.includes('add a `:hover` rule'), `the origin line does not say to add a :hover rule: ${line}`)
    editFile(fixture, 'app/page.module.css', replaceOnce('  font-weight: 600;\n}\n\n.cardGrid {', '  font-weight: 600;\n}\n\n.cta:hover {\n  background-color: #1d4ed8;\n}\n\n.cardGrid {'))
    const { outcome } = await verify([item.id], 8000)
    const result = one(outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    const restingAfter = await resting()
    expect(restingAfter === restingBefore, `the resting background went from ${restingBefore} to ${restingAfter}`)
    return `${describe(result)}\n        prompt: ${line}`
  })

  report.section('Next F. Reordering the nav links (NAV_LINKS in app/layout.tsx, a Server Component layout)')
  const navTexts = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('[data-label="site-nav"] > a')].map((element) => element.textContent?.trim() ?? ''))
  await report.attempt('"Stream" moved one place earlier: the prompt says to reorder the data; the agent swaps two entries of NAV_LINKS: pass, and the nav has the new order', async () => {
    const before = await navTexts()
    const { item, prompt } = await loop.reorderAndClaim('[data-label="site-nav"] > a:nth-child(3)', { by: -1 })
    expect(item.kind === 'structure' && item.move?.fromIndex === 2 && item.move.toIndex === 1, `move: ${item.kind === 'structure' ? JSON.stringify({ from: item.move?.fromIndex, to: item.move?.toIndex }) : item.kind}`)
    const section = sectionOf(prompt, item.id)
    expect(section.includes('move this element') && section.includes('change the order of the data'), `the prompt does not say to reorder the data:\n${section}`)
    editFile(fixture, 'app/layout.tsx', replaceOnce("  { href: '/actions', text: 'Actions' },\n  { href: '/stream', text: 'Stream' },", "  { href: '/stream', text: 'Stream' },\n  { href: '/actions', text: 'Actions' },"))
    const result = one((await verify([item.id], 10_000)).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    const after = await navTexts()
    expect(after.slice(0, 3).join() === 'Home,Stream,Actions', `the nav reads ${after.join(', ')}`)
    return `${describe(result)}\n        nav: ${before.slice(0, 3).join(', ')} -> ${after.slice(0, 3).join(', ')}`
  })

  report.check('primp added no CSP violation during the whole Next loop', fromPrimp().length === 0, fromPrimp().slice(0, 3).join(' | ') || 'none')
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
  await report.attempt('a :hover background on the CTA (scoped style, .cta:hover sets only a filter): the agent adds it to .cta:hover in Hero.svelte: pass', async () => {
    // After the syntax error above, the page must have recovered before the next edit.
    await sleep(500)
    const resting = (): Promise<string> => loop.page.evaluate(() => getComputedStyle(document.querySelector('[data-label="hero-cta"]') as Element).backgroundColor)
    const restingBefore = await resting()
    const item = await loop.editAndClaim('[data-label="hero-cta"]', { property: 'background-color', value: '#1e3a8a', state: 'hover' })
    expect(item.kind === 'style' && item.condition.state === 'hover', 'not a :hover change')
    expect(item.target.source?.file === 'src/lib/components/Hero.svelte', `source ${item.target.source?.file}:${item.target.source?.line}`)
    editFile(fixture, 'src/lib/components/Hero.svelte', replaceOnce('.cta:hover {\n\t\tfilter: brightness(1.08);', '.cta:hover {\n\t\tfilter: brightness(1.08);\n\t\tbackground-color: #1e3a8a;'))
    const result = one((await verify([item.id], 8000)).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    const restingAfter = await resting()
    expect(restingAfter === restingBefore, `the resting background went from ${restingBefore} to ${restingAfter}`)
    const origin = item.kind === 'style' ? item.origin : undefined
    return `${describe(result)}; origin ${origin?.via} ${origin?.selector ?? ''}`
  })
}

async function staticSite(): Promise<void> {
  const loop = await startLoop('static-html')
  const { fixture, page, record, verify, describe, itemStatus } = loop
  const one = loop.only

  report.section('Plain HTML, no build step and no hot reload')
  await report.attempt('the agent edits css/site.css; primp reloads the page by itself and then judges: fail, then pass', async () => {
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
    return `source ${item.target.source?.file}:${item.target.source?.line} (${item.target.source?.level}); ${reloads} reloads by primp\n        wrong: ${describe(wrong)}\n        right: ${describe(right)}`
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
  await report.attempt('a :hover background on .button (css/site.css has .button:hover): the agent edits that rule; pass after primp reloads the page', async () => {
    const item = await loop.editAndClaim('[data-label="hero-cta"]', { property: 'background-color', value: '#0b2a1f', state: 'hover' })
    expect(item.kind === 'style' && item.condition.state === 'hover', 'not a :hover change')
    const origin = item.kind === 'style' ? item.origin : undefined
    expect(origin?.via === 'rule' && origin.selector === '.button:hover', `origin: ${JSON.stringify(origin)}`)
    const loadsBefore = record.documentRequests.length
    editFile(fixture, 'css/site.css', replaceOnce('.button:hover {\n  background: #1a4131;', '.button:hover {\n  background: #0b2a1f;'))
    const result = one((await verify([item.id], 1500)).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    expect(record.documentRequests.length > loadsBefore, 'the page was not reloaded before measuring')
    return `${describe(result)}; origin ${origin?.selector} in ${origin?.sheet}`
  })
  await report.attempt('about.html: the second step of ol.about-steps moved to the front; the agent moves the li in about.html: pass after the reload', async () => {
    await loop.open('/about.html')
    const steps = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('ol.about-steps > li')].map((element) => element.getAttribute('data-label') ?? ''))
    const { item, prompt } = await loop.reorderAndClaim('[data-label="about-step-stitch"]', { to: 0 })
    expect(item.kind === 'structure' && item.move?.fromIndex === 1 && item.move.toIndex === 0, `move: ${item.kind === 'structure' ? JSON.stringify({ from: item.move?.fromIndex, to: item.move?.toIndex }) : item.kind}`)
    expect(sectionOf(prompt, item.id).includes('move this element'), 'the prompt does not say to move the element')
    expect(item.target.source?.file === 'about.html', `source ${item.target.source?.file}:${item.target.source?.line}`)
    editFile(fixture, 'about.html', (source) => {
      const fold = /\n\s*<li data-label="about-step-fold">[^\n]*/.exec(source)?.[0] ?? ''
      const stitch = /\n\s*<li data-label="about-step-stitch">[^\n]*/.exec(source)?.[0] ?? ''
      expect(fold !== '' && stitch !== '', 'the steps are not where the patch expects them')
      return source.replace(`${fold}${stitch}`, `${stitch}${fold}`)
    })
    const result = one((await verify([item.id], 1500)).outcome)
    expect(result.status === 'pass', `status ${describe(result)}`)
    expect(itemStatus(item.id) === 'verified', `item status ${itemStatus(item.id)}`)
    const order = await steps()
    expect(order.join() === 'about-step-stitch,about-step-fold,about-step-press', `the page has ${order.join(', ')}`)
    return `${describe(result)}\n        in the page: ${order.join(', ')}`
  })
}

/**
 * Notes: free text from the user, on an element or about the whole page. Sent in one batch with a
 * style change, a note reaches the agent with its text and where it is, and comes back from
 * verification as `not_checkable` (never `pass`), also when the agent did what it says; the
 * style change next to it is measured and judged as usual. Its own part, on the Vite fixture.
 */
async function notes(): Promise<void> {
  const loop = await startLoop('vite-react-19', { shimCwd: 'src' })
  const { fixture, page, verify, describe, itemStatus, dock } = loop

  report.section('Notes (Vite + React 19). A note is handed over in the user\'s words and is never reported as a pass')
  const ready = await report.attempt('the dock loads through primp', async () => {
    await loop.open('/')
    return `dock ready at ${loop.primp.url}`
  })
  if (!ready) return

  const CTA_NOTE = 'Say "Start your free trial" instead of "Start free"'
  const PAGE_NOTE = 'The browser tab title should be "Lumen | Ship the layout you meant"'
  let batch: { cta: ChangeItem; page: ChangeItem; radius: ChangeItem } | undefined
  await report.attempt('an element note, a page note and a style change, sent together: the agent prompt quotes both notes with where they are, and says they come back not_checkable', async () => {
    await dock('select', '[data-label="hero-cta-primary"]')
    const cta = await dock('addNote', CTA_NOTE)
    expect(cta.ok && cta.item?.kind === 'note' && cta.item.on === 'element', `the element note was not recorded: ${cta.error ?? JSON.stringify(cta.item)?.slice(0, 160)}`)
    const ctaItem = cta.item as ChangeItem
    expect(ctaItem.target.source?.file === 'src/components/Hero.tsx', `the note's element resolves to ${ctaItem.target.source?.file}:${ctaItem.target.source?.line}`)
    expect(ctaItem.expect.length === 0, `a note has expectations: ${JSON.stringify(ctaItem.expect)}`)
    const pageNote = await dock('addNote', PAGE_NOTE, { on: 'page' })
    expect(pageNote.ok && pageNote.item?.kind === 'note' && pageNote.item.on === 'page' && pageNote.item.target.tag === 'body', `the page note was not recorded: ${pageNote.error ?? JSON.stringify(pageNote.item)?.slice(0, 160)}`)
    await dock('select', '[data-label="card"]')
    const radius = await dock('setStyle', 'border-radius', '16px', { media: null, scope: 'all-instances', state: null })
    expect(radius.ok && radius.item?.kind === 'style', `the style change was not recorded: ${radius.error ?? 'no item'}`)
    const sent = await dock('send')
    expect(sent.includes(CTA_NOTE) && sent.includes(PAGE_NOTE), `the clipboard prompt does not carry both notes:\n${sent}`)

    const { items, prompt } = await loop.claim(3)
    const byId = new Map(items.map((item) => [item.id, item]))
    const ids = [ctaItem.id, (pageNote.item as ChangeItem).id, (radius.item as ChangeItem).id]
    expect(ids.every((id) => byId.has(id)), `claimed ${[...byId.keys()].join(', ')}, recorded ${ids.join(', ')}`)
    const ctaSection = sectionOf(prompt, ctaItem.id)
    const ctaLines = ctaSection.split('\n').slice(0, 4).join('\n')
    expect(ctaLines.includes(`> ${CTA_NOTE}`), `the element note text is not quoted in the prompt:\n${ctaLines}`)
    expect(ctaLines.includes('Note from the user on') && ctaLines.includes('src/components/Hero.tsx'), `the prompt does not say which element and file the note is about:\n${ctaLines}`)
    expect(ctaSection.includes('`not_checkable`') && ctaSection.includes('by eye'), `the prompt does not say how the note is verified:\n${ctaSection.slice(0, 900)}`)
    const pageSection = sectionOf(prompt, (pageNote.item as ChangeItem).id)
    expect(pageSection.includes('Note from the user about the whole page') && pageSection.includes(`> ${PAGE_NOTE}`), `the page note is not in the prompt as one:\n${pageSection.slice(0, 600)}`)
    expect(prompt.includes('## The whole page'), 'the page note has no section of its own')
    batch = { cta: byId.get(ctaItem.id) as ChangeItem, page: byId.get((pageNote.item as ChangeItem).id) as ChangeItem, radius: byId.get((radius.item as ChangeItem).id) as ChangeItem }
    return `claimed ${ids.join(', ')}; element note on ${ctaItem.target.label} (${ctaItem.target.source?.file}:${ctaItem.target.source?.line}), page note on <${(pageNote.item as ChangeItem).target.tag}>\n        ${ctaLines.split('\n').join('\n        ')}`
  })

  await report.attempt('the agent sets the radius in Card.module.css and does what the element note says: the style change passes, both notes are not_checkable, the batch is reported as such', async () => {
    expect(batch !== undefined, 'no batch from the previous check')
    const { cta, page: pageItem, radius } = batch as { cta: ChangeItem; page: ChangeItem; radius: ChangeItem }
    editFile(fixture, 'src/components/Card.module.css', replaceOnce('  border-radius: 12px;', '  border-radius: 16px;'))
    editFile(fixture, 'src/components/Hero.tsx', replaceOnce('            Start free\n', '            Start your free trial\n'))
    const { outcome, text } = await verify([radius.id, cta.id, pageItem.id])
    const results = new Map(outcome.results.map((result) => [result.itemId, result]))
    const r = results.get(radius.id)
    const c = results.get(cta.id)
    const p = results.get(pageItem.id)
    expect(r?.status === 'pass', `style change: ${r === undefined ? 'no result' : describe(r)}`)
    expect(c?.status === 'not_checkable' && p?.status === 'not_checkable', `notes: ${[c, p].map((result) => (result === undefined ? 'no result' : describe(result))).join(' | ')}`)
    expect(c?.checks.length === 0 && c.hint.includes('check it by eye'), `the element note result: ${c === undefined ? '-' : describe(c)}`)
    expect(outcome.counts.pass === 1 && outcome.counts.not_checkable === 2 && Object.keys(outcome.counts).length === 2, `counts ${JSON.stringify(outcome.counts)}`)
    expect(outcome.summary.includes('not checkable') && outcome.summary.includes('by eye') && !/all .*pass/i.test(outcome.summary), `summary: ${outcome.summary}`)
    expect(outcome.fixup === '', `a fix-up prompt was returned with nothing to fix:\n${outcome.fixup}`)
    expect(text.includes(cta.id), 'the tool text does not name the note')
    expect(itemStatus(radius.id) === 'verified', `style item status ${itemStatus(radius.id)}`)
    expect(itemStatus(cta.id) === 'claimed' && itemStatus(pageItem.id) === 'claimed', `note item status ${itemStatus(cta.id)}, ${itemStatus(pageItem.id)}: a note is never verified or failed`)
    const shown = await loop.shownStatus(cta.id)
    expect(shown === 'not_checkable', `the dock shows the element note as ${shown}`)
    const copy = await page.evaluate(() => document.querySelector('[data-label="hero-cta-primary"]')?.textContent?.trim() ?? '')
    expect(copy === 'Start your free trial', `the page shows the button as "${copy}"`)
    return `${outcome.summary}\n        style: ${r === undefined ? '-' : describe(r)}\n        note: ${c === undefined ? '-' : describe(c)}`
  })

  const unexpected = loop.record
    .consoleErrors()
    .map((entry) => entry.text)
    .filter((line) => !/Failed to (load|fetch)|\[vite\]|hmr/i.test(line))
  report.check('no console errors in the page during the notes part', unexpected.length === 0, unexpected.slice(0, 5).join('\n') || 'none')
}

const PARTS: Record<string, () => Promise<void>> = { vite, next, svelte, static: staticSite, notes }

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
