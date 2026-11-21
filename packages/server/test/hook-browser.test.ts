import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from '@playwright/test'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ShiftRecording } from '../../protocol/src/shift.ts'
import { buildOverlayAssets } from '../src/assets.ts'
import { runCleanups, startProxy, startUpstream } from './helpers.ts'
import { removeDir, tempDir } from './session-helpers.ts'

/**
 * What the layout-shift hook records, in a real Chromium, with the hook built and minified as the
 * product builds it and served from `/__primp/hook.js`: the stack of a DOM call, the unclipped
 * box of a shift victim, the fonts of inline children.
 *
 * Stacks: the hook wraps DOM methods to capture the stack. A frame of the wrapper on top of the recorded
 * stack reads as "a script of primp made this call": on 2026-11-21 that classified a page's own
 * `insertAdjacentHTML` as development tooling and hid its layout shift. Every wrapped method is
 * checked here: the first recorded frame must be the page's statement.
 */

const HOOK_ENTRY = fileURLToPath(new URL('../../overlay/src/hook/index.ts', import.meta.url))

/** One function per wrapped method, each on a line of its own; `el(name)` is the node it puts in. */
const PAGE_SCRIPT = `
function el(name) { const node = document.createElement('p'); node.id = 'added-' + name; node.textContent = name; return node }
function html(name) { return '<p id="added-' + name + '">' + name + '</p>' }
const host = (name) => document.getElementById('host-' + name)
const OPS = {
  appendChild(h) { h.appendChild(el('appendChild')) },
  insertBefore(h) { h.insertBefore(el('insertBefore'), h.firstChild) },
  replaceChild(h) { h.replaceChild(el('replaceChild'), h.firstElementChild) },
  append(h) { h.append(el('append')) },
  prepend(h) { h.prepend(el('prepend')) },
  replaceChildren(h) { h.replaceChildren(el('replaceChildren')) },
  before(h) { h.firstElementChild.before(el('before')) },
  after(h) { h.firstElementChild.after(el('after')) },
  replaceWith(h) { h.firstElementChild.replaceWith(el('replaceWith')) },
  innerHTML(h) { h.innerHTML = html('innerHTML') },
  outerHTML(h) { h.firstElementChild.outerHTML = html('outerHTML') },
  'insertAdjacentHTML-beforebegin'(h) { h.firstElementChild.insertAdjacentHTML('beforebegin', html('insertAdjacentHTML-beforebegin')) },
  'insertAdjacentHTML-afterbegin'(h) { h.insertAdjacentHTML('afterbegin', html('insertAdjacentHTML-afterbegin')) },
  'insertAdjacentHTML-beforeend'(h) { h.insertAdjacentHTML('beforeend', html('insertAdjacentHTML-beforeend')) },
  'insertAdjacentHTML-afterend'(h) { h.firstElementChild.insertAdjacentHTML('afterend', html('insertAdjacentHTML-afterend')) },
  'insertAdjacentElement-beforebegin'(h) { h.firstElementChild.insertAdjacentElement('beforebegin', el('insertAdjacentElement-beforebegin')) },
  'insertAdjacentElement-beforeend'(h) { h.insertAdjacentElement('beforeend', el('insertAdjacentElement-beforeend')) },
  'insertAdjacentElement-afterend'(h) { h.firstElementChild.insertAdjacentElement('afterend', el('insertAdjacentElement-afterend')) },
  setAttribute(h) { h.setAttribute('data-state', 'set') },
  removeAttribute(h) { h.removeAttribute('data-initial') },
  // The call is made by the browser, not by a statement of the page: no frame of the page exists.
  'appendChild-bound'(h) { [el('appendChild-bound')].forEach(h.appendChild, h) },
}
window.__ops = Object.keys(OPS)
for (const name of window.__ops) {
  const h = document.createElement('div')
  h.id = 'host-' + name
  h.setAttribute('data-initial', '1')
  h.appendChild(document.createElement('i'))
  document.body.appendChild(h)
}
// After the first frame (the hook records nothing before it), one call per task, so that every
// call gets a mutation batch of its own.
requestAnimationFrame(() => requestAnimationFrame(async () => {
  for (const name of window.__ops) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    OPS[name](host(name))
  }
  await new Promise((resolve) => setTimeout(resolve, 30))
  window.__done = true
}))
`

let browser: Browser
let dir: string
beforeAll(async () => {
  browser = await chromium.launch()
  dir = tempDir('hook-stacks-test')
  writeFileSync(join(dir, 'overlay.ts'), 'export {}\n')
})
afterAll(async () => {
  await browser?.close()
  removeDir(dir)
})
afterEach(runCleanups)

/**
 * A page of 2000px with a block at y=500. After the first frame a 400px strip is inserted above it
 * (the block ends below an 800px viewport), and a heading whose words sit in a `span` of another
 * font is made narrower, so that it changes size.
 */
const SHIFT_PAGE = `<!doctype html><html><head><title>shift</title>
<style>body{margin:0;font-family:Arial,sans-serif} #slot{height:0} #block{height:500px;margin-top:500px;background:#ccd} #tail{height:1000px}
h1{margin:0;font-size:20px;width:600px} h1 span{font-family:"Web Display",Georgia,serif}</style></head>
<body><div id="slot"></div><h1 id="title"><span>Words in another font than the heading around them, long enough to wrap</span></h1>
<div id="block">block</div><div id="tail"></div>
<script>
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
  document.getElementById('slot').style.height = '400px'
  document.getElementById('title').style.width = '200px'
  setTimeout(() => { window.__done = true }, 300)
}, 50)))
</script></body></html>`

describe('what the hook records about a layout shift, in Chromium', () => {
  it('the unclipped box of a victim that the browser reports with an empty rectangle, and the fonts of inline children', async () => {
    const built = await buildOverlayAssets({ hookEntry: HOOK_ENTRY, overlayEntry: join(dir, 'overlay.ts'), prebuiltDir: false })
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(SHIFT_PAGE)
    })
    const proxy = await startProxy(upstream.port, { assets: built.assets, headScripts: built.headScripts })
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    try {
      await page.goto(proxy.url)
      await page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, undefined, { timeout: 10_000 })
      const recording = await page.evaluate(() => (window as unknown as { __primp: { recording(): ShiftRecording } }).__primp.recording())
      const block = recording.shifts.flatMap((entry) => entry.sources).find((source) => source.node?.id === 'block')
      // What the Layout Instability API says: visible from y=500+ to the bottom edge before, nothing after.
      expect(block?.previousRect.height).toBeGreaterThan(0)
      expect(block?.previousRect.y + (block?.previousRect.height ?? 0)).toBe(800)
      expect(block?.currentRect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
      // What the hook adds: where the block really is, 400px (plus the heading's growth) further down.
      expect(block?.rect?.height).toBe(500)
      expect(block?.rect?.y).toBeGreaterThanOrEqual((block?.previousRect.y ?? 0) + 400)
      expect(block?.rect?.y).toBeGreaterThanOrEqual(800)
      // The heading changed size; its own font is Arial, the span's is not, and the span has no size of its own.
      const title = recording.resizes.find((record) => record.node.id === 'title' && record.before !== null)
      expect(title?.style?.fontFamily).toBe('Arial, sans-serif')
      expect(title?.inlineFonts).toEqual(['"Web Display", Georgia, serif'])
      expect(recording.resizes.some((record) => record.node.tag === 'span')).toBe(false)
      // A block whose children are blocks in its own font notes nothing.
      expect(recording.resizes.find((record) => record.node.tag === 'body')?.inlineFonts).toBeUndefined()
    } finally {
      await page.close()
    }
  })
})

describe('DOM-call stacks recorded by the hook, in Chromium', () => {
  it('start at the page\'s own statement for every wrapped DOM method, never at a frame of primp', async () => {
    const built = await buildOverlayAssets({ hookEntry: HOOK_ENTRY, overlayEntry: join(dir, 'overlay.ts'), prebuiltDir: false })
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/page.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.end(PAGE_SCRIPT)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><head><title>stacks</title></head><body><main>page</main><script src="/page.js"></script></body></html>')
    })
    const proxy = await startProxy(upstream.port, { assets: built.assets, headScripts: built.headScripts })
    const page = await browser.newPage()
    try {
      await page.goto(proxy.url)
      await page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, undefined, { timeout: 10_000 })
      const { ops, recording } = await page.evaluate(() => {
        const w = window as unknown as { __ops: string[]; __primp: { recording(): ShiftRecording } }
        return { ops: w.__ops, recording: w.__primp.recording() }
      })
      expect(ops.length).toBeGreaterThanOrEqual(21)
      const problems: string[] = []
      for (const name of ops) {
        const attr = name === 'setAttribute' || name === 'removeAttribute'
        const mutation = recording.mutations.find((m) => (attr ? m.kind === 'attr' && m.node.id === `host-${name}` && m.attr !== 'id' : m.kind === 'add' && m.node.id === `added-${name}`))
        if (mutation === undefined) {
          problems.push(`${name}: no mutation record`)
          continue
        }
        const stack = mutation.stack ?? ''
        if (stack.includes('/__primp/')) problems.push(`${name}: a frame of primp is on the stack:\n${stack}`)
        const first = stack.split('\n')[0] ?? ''
        if (name === 'appendChild-bound') {
          // Called through Array.prototype.forEach: the browser's frame, then the page's function.
          if (!/Array\.forEach/.test(first) || !/appendChild-bound.*\/page\.js/.test(stack.split('\n')[1] ?? '')) problems.push(`${name}: unexpected stack:\n${stack}`)
        } else if (!first.includes('/page.js:') || !first.includes(name.split('-')[0] as string)) {
          problems.push(`${name}: the first frame is not the page's statement:\n${stack}`)
        }
      }
      expect(problems).toEqual([])
    } finally {
      await page.close()
    }
  })
})
