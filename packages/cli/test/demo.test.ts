import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DemoError, demoGuide, demoTemplateDir, prepareDemo, startDemoServer, type DemoServer } from '../src/demo.ts'

const TMP_ROOT = join(import.meta.dirname, '../../../.tmp')

describe('primp demo', () => {
  let work: string
  let server: DemoServer | undefined
  beforeEach(() => {
    mkdirSync(TMP_ROOT, { recursive: true })
    work = mkdtempSync(join(TMP_ROOT, 'demo-test-'))
  })
  afterEach(async () => {
    await server?.close()
    server = undefined
    rmSync(work, { recursive: true, force: true })
  })

  it('finds the template and copies it into a new directory', () => {
    expect(demoTemplateDir()).toMatch(/demo-site$/)
    const site = prepareDemo(join(work, 'primp-demo'))
    expect(site.created).toBe(true)
    const html = readFileSync(join(site.dir, 'index.html'), 'utf8')
    expect(html).toContain('<title>Corvane')
    // The seeded problem: a late image with no reserved space.
    expect(html).toMatch(/<img id="hero-art"[^>]*\?delay=700/)
    expect(html).not.toMatch(/<img id="hero-art"[^>]*(width|height)=/)
    expect(readFileSync(join(site.dir, 'css/site.css'), 'utf8')).not.toMatch(/aspect-ratio/)
    // The other pictures are sized, and nothing else is fetched: no web font, no script.
    expect(html).not.toMatch(/<script|@import|(src|href)="(https?:)?\/\//)
    expect(readFileSync(join(site.dir, 'css/site.css'), 'utf8')).not.toMatch(/@font-face|@import|url\((?!"data:)/)
    for (const svg of html.match(/<svg[^>]*>/g) ?? []) expect(svg).toMatch(/width="\d+" height="\d+"/)
    expect(html.match(/<img /g)).toHaveLength(1)
  })

  it('still recognises a demo copied out by an earlier version', () => {
    const dir = join(work, 'old-demo')
    mkdirSync(dir)
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Tidewater Coffee</title>')
    expect(prepareDemo(dir).created).toBe(false)
  })

  it('reuses a demo that is already there and refuses any other non-empty directory', () => {
    const dir = join(work, 'site')
    prepareDemo(dir)
    writeFileSync(join(dir, 'index.html'), readFileSync(join(dir, 'index.html'), 'utf8').replace('id="hero-art"', 'id="hero-art" width="1200" height="750"'))
    const again = prepareDemo(dir)
    expect(again.created).toBe(false)
    // The user's (or the agent's) edit is kept.
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('width="1200"')

    const other = join(work, 'project')
    mkdirSync(other)
    writeFileSync(join(other, 'package.json'), '{}')
    expect(() => prepareDemo(other)).toThrow(DemoError)
  })

  it('serves the site cacheably, holds back ?delay= responses, and stays inside its directory', async () => {
    const site = prepareDemo(join(work, 'site'))
    server = await startDemoServer(site.dir)
    const page = await fetch(`${server.url}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('cache-control')).toBe('no-cache')

    const started = performance.now()
    const image = await fetch(`${server.url}/img/dashboard.svg?delay=300`)
    expect(performance.now() - started).toBeGreaterThanOrEqual(280)
    expect(image.headers.get('content-type')).toBe('image/svg+xml')
    expect(image.headers.get('cache-control')).toBe('public, max-age=3600')
    const etag = image.headers.get('etag') ?? ''
    expect((await fetch(`${server.url}/img/dashboard.svg`, { headers: { 'if-none-match': etag } })).status).toBe(304)

    expect((await fetch(`${server.url}/nope.css`)).status).toBe(404)
    expect((await fetch(`${server.url}/..%2F..%2Fpackage.json`)).status).toBeGreaterThanOrEqual(403)
  })

  it('prints what to do next, with the directory relative to where the user is', () => {
    const guide = demoGuide('/home/me/work/primp-demo', '/home/me/work')
    expect(guide).toContain('./primp-demo')
    expect(guide).toContain('get_layout_shifts')
    expect(guide).toContain('verify_layout_shift')
    // The dock's own names, and how to open it.
    expect(guide).toContain('Layout shifts')
    expect(guide).not.toMatch(/Shifts tab|Edits tab/)
    expect(demoGuide('/x/primp-demo', '/x', '⌘⇧E')).toContain('Open the dock: the round button at the bottom right of the page, or ⌘⇧E.')
  })
})
