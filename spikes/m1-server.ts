/**
 * Integration check for the server side of M1 + M2.
 *
 *   browser (stub head script + stub dock) ── primp (startPrimp) ── fixture dev server
 *   MCP client ── real stdio shim (`primp mcp`) ── control port ──┘
 *
 *   A. vite-react-19 through `startPrimp`, with STUB browser bundles (spikes/m1-assets):
 *      injection and assets, hello -> state, the settle detector on the same socket,
 *      `session:resolve` with the real `collectEvidence` against the fixture's labels.json,
 *      upsert, send -> prompt, and the measure plumbing.
 *   B. An MCP client over the real stdio shim: get_session, get_pending_changes (claimed,
 *      grouped by file, journal mark recorded), dismiss_change.
 *   C. Shutdown: session file, ports, and what the shim says afterwards.
 *   D. cls-corpus: `session:shifts` with real recordings; each expected culprit must come back
 *      with the file and line of expected.json (the measure of spike S7, section E, taken
 *      through the session instead of in the spike).
 *
 * Run: pnpm spike:m1-server            (exit 0 = pass)
 *      pnpm spike:m1-server -- --sections a,b,c    only these (the run then fails as incomplete)
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Browser, Page } from '@playwright/test'
import { NOT_RUNNING } from '../packages/cli/src/mcp-shim.ts'
import { renderPrompt } from '../packages/engine/src/prompt.ts'
import type { ChangeItem, Locator, SourceLoc, StructuralChange, StyleChange } from '../packages/protocol/src/change.ts'
import { HOOK_ASSET_PATH, OVERLAY_ASSET_PATH, type ClientMessage, type ServerMessage } from '../packages/protocol/src/messages.ts'
import { DismissChangeResultSchema, PendingChangesSchema, SessionSummarySchema } from '../packages/protocol/src/session.ts'
import type { ShiftIssue } from '../packages/protocol/src/shift.ts'
import { startPrimp, type PrimpHandle } from '../packages/server/src/app.ts'
import { SESSION_DIR_ENV } from '../packages/server/src/session-file.ts'
import { createReport, expect, labelsOnPage, launchBrowser, newPage, rawNavigate, rawRequest, REPO_ROOT, runCleanups, sleep, startFixture, TMP_ROOT, waitFor, onCleanup, type FixtureHandle, type FixtureLabel } from './lib/index.ts'
import type { M1Stub } from './m1-assets/hook-stub.ts'
import { listCorpus, type CorpusPage } from './s7-assets/corpus.ts'

const HOOK_STUB = fileURLToPath(new URL('./m1-assets/hook-stub.ts', import.meta.url))
const OVERLAY_STUB = fileURLToPath(new URL('./m1-assets/overlay-stub.ts', import.meta.url))
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/index.ts')
/** tsx's loader as a file URL, so `node --import` finds it from the fixture's working directory. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const SESSION_DIR = join(TMP_ROOT, `m1-server-sessions-${process.pid}`)
const SOURCE_TARGET = 0.95
const CULPRIT_TARGET = 0.8

const argv = process.argv.slice(2)
const sectionsArg = argv.includes('--sections') ? argv[argv.indexOf('--sections') + 1] : undefined
const sections = new Set((sectionsArg ?? 'a,b,c,d').split(','))
const partial = sections.size < 4

const report = createReport('M1 + M2 server: startPrimp, session, MCP shim')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startFor(fixture: FixtureHandle): Promise<PrimpHandle & { logs: string[] }> {
  const logs: string[] = []
  const primp = await startPrimp({
    projectRoot: fixture.dir,
    target: fixture.url,
    assets: { hookEntry: HOOK_STUB, overlayEntry: OVERLAY_STUB },
    sessionDir: SESSION_DIR,
    // The harness has its own signal handling and cleanup order.
    handleSignals: false,
    version: '0.0.0-spike',
    log: (level, message, detail) => {
      if (level !== 'debug') logs.push(`${level}: ${message}${detail === undefined ? '' : ` ${detail instanceof Error ? detail.message : JSON.stringify(detail)}`}`)
    },
  })
  onCleanup(() => primp.close())
  return Object.assign(primp, { logs })
}

const stubOf = (page: Page): Promise<Pick<M1Stub, 'doc' | 'firstInHead' | 'scriptSrc' | 'overlayLoaded' | 'socketOpen' | 'settleMessages'> & { received: number }> =>
  page.evaluate(() => {
    const stub = window.__primpM1
    if (stub === undefined) throw new Error('window.__primpM1 is missing: the stub head script did not run')
    return { doc: stub.doc, firstInHead: stub.firstInHead, scriptSrc: stub.scriptSrc, overlayLoaded: stub.overlayLoaded, socketOpen: stub.socketOpen, settleMessages: stub.settleMessages, received: stub.received.length }
  })

const send = (page: Page, message: ClientMessage): Promise<void> => page.evaluate((payload) => window.__primpM1?.send(payload), message)

const request = <T extends ServerMessage['type']>(page: Page, message: ClientMessage & { reqId: string }): Promise<Extract<ServerMessage, { type: T }>> =>
  page.evaluate((payload) => (window.__primpM1 as M1Stub).request(payload), message) as Promise<Extract<ServerMessage, { type: T }>>

const waitForMessage = <T extends ServerMessage['type']>(page: Page, type: T, from = 0, timeoutMs = 10_000): Promise<Extract<ServerMessage, { type: T }>> =>
  page.evaluate(([wanted, start, timeout]) => (window.__primpM1 as M1Stub).waitFor(wanted, start, timeout), [type, from, timeoutMs] as const) as Promise<Extract<ServerMessage, { type: T }>>

/** The newest `session:state` the page has, once `ready` accepts it. */
async function stateWhere(page: Page, ready: (items: ChangeItem[]) => boolean, what: string): Promise<ChangeItem[]> {
  return waitFor(
    async () => {
      const items = await page.evaluate(() => {
        const states = (window.__primpM1 as M1Stub).received.filter((message) => message.type === 'session:state')
        const last = states.at(-1)
        return last === undefined || last.type !== 'session:state' ? null : last.items
      })
      return items !== null && ready(items) ? items : undefined
    },
    { timeoutMs: 8000, what },
  )
}

const where = (source: SourceLoc | null | undefined): string => (source?.file === undefined ? '(nothing)' : `${source.file}:${source.line ?? '?'}:${source.col ?? '?'} [${source.level}, ${source.via}]`)
const statusOf = (items: ChangeItem[]): string => items.map((item) => `${item.id}=${item.status}`).join(', ')
const textOf = (result: CallToolResult): string => result.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
const sessionFiles = (): string[] => (existsSync(SESSION_DIR) ? readdirSync(SESSION_DIR).filter((name) => name.endsWith('.json')) : [])

interface ElementFacts {
  selector: string
  tag: string
  classes: string[]
  text: string
  rect: { x: number; y: number; w: number; h: number }
  locator: Locator
  paddingTop: string
}

/** What a dock would record about the element with this `data-label`. */
const factsOf = (page: Page, label: string): Promise<ElementFacts> =>
  page.evaluate((name) => {
    const element = document.querySelector(`[data-label="${name}"]`)
    if (element === null) throw new Error(`no element with data-label ${name}`)
    const indexPath: number[] = []
    const ancestors: string[] = []
    for (let el: Element = element; el.parentElement !== null && el !== document.body; el = el.parentElement) {
      indexPath.unshift([...el.parentElement.children].indexOf(el))
      ancestors.unshift(el.parentElement.localName)
    }
    const rect = element.getBoundingClientRect()
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    return {
      selector: `[data-label="${name}"]`,
      tag: element.localName,
      classes: [...element.classList],
      text,
      rect: { x: rect.x + scrollX, y: rect.y + scrollY, w: rect.width, h: rect.height },
      locator: { tag: element.localName, indexPath, ancestors, ...(text === '' ? {} : { text }) },
      paddingTop: getComputedStyle(element).paddingTop,
    }
  }, label)

function baseItem(id: string, facts: ElementFacts, source: SourceLoc | null) {
  return {
    id,
    seq: 0,
    createdAt: Date.now(),
    page: '/',
    status: 'draft' as const,
    target: {
      uid: `uid-${id}`,
      selector: facts.selector,
      tag: facts.tag,
      classes: facts.classes,
      text: facts.text,
      label: `${facts.tag} "${facts.text.slice(0, 24)}"`,
      rect: facts.rect,
      instanceCount: 1,
      source,
      locator: facts.locator,
    },
    sideEffects: [],
  }
}

// ---------------------------------------------------------------------------
// A + B + C: vite-react-19
// ---------------------------------------------------------------------------

async function viteSections(browser: Browser): Promise<void> {
  const fixture = await startFixture('vite-react-19')
  const primp = await startFor(fixture)
  const { page, record } = await newPage(browser)
  let items: { style: StyleChange; structure: StructuralChange } | undefined
  let batchId: string | undefined
  let docId = ''

  if (sections.has('a')) {
    report.section('A. vite-react-19 through startPrimp, stub bundles')
    report.info(`fixture ${fixture.url} (${fixture.dir}); proxy ${primp.url}; control port ${primp.controlPort}; framework "${primp.framework}"; hook.js ${primp.assets.hook.bytes} B, overlay.js ${primp.assets.overlay.bytes} B (both ${primp.assets.hook.from})`)

    await report.attempt('the proxy takes the port after the dev server, or the next free one', () => {
      expect(primp.port > fixture.port && primp.port <= fixture.port + 20, `dev server on ${fixture.port}, proxy on ${primp.port}`)
      expect(primp.target === fixture.url, `target ${primp.target}, fixture ${fixture.url}`)
      return `dev server ${fixture.port}, proxy ${primp.port}`
    })

    await report.attempt('the document gets the hook as the first script of <head>; both bundles are served with Cache-Control: no-store', async () => {
      const html = await rawNavigate(`${primp.url}/`)
      const tag = `<script src="${HOOK_ASSET_PATH}?v=${primp.assets.hook.hash}" data-primp></script>`
      const head = html.text.indexOf('<head>')
      expect(html.status === 200 && html.text.slice(head + 6, head + 6 + tag.length) === tag, `status ${html.status}; after <head>: ${html.text.slice(head + 6, head + 120)}`)
      const seen: string[] = []
      for (const [path, asset] of [
        [`${HOOK_ASSET_PATH}?v=${primp.assets.hook.hash}`, primp.assets.hook],
        [OVERLAY_ASSET_PATH, primp.assets.overlay],
      ] as const) {
        const response = await rawRequest(primp.url + path)
        expect(response.status === 200, `${path}: HTTP ${response.status}`)
        expect(response.headers['cache-control'] === 'no-store', `${path}: cache-control ${String(response.headers['cache-control'])}`)
        expect(response.text === asset.code, `${path}: body differs from the built bundle`)
        seen.push(`${path} ${response.body.length} B ${String(response.headers['content-type'])}`)
      }
      return `tag right after <head>; ${seen.join('; ')}`
    })

    await report.attempt('the page loads through the proxy: stub hook first in <head>, socket open, second bundle loaded, app rendered', async () => {
      await page.goto(`${primp.url}/`, { waitUntil: 'load' })
      await page.waitForSelector('[data-label="hero-title"]')
      const stub = await waitFor(async () => {
        const current = await stubOf(page)
        return current.socketOpen && current.overlayLoaded ? current : undefined
      }, { what: 'the stub socket and the second bundle' })
      docId = stub.doc
      expect(stub.firstInHead, 'the stub hook was not the first element of <head> when it ran')
      expect(stub.scriptSrc === `${HOOK_ASSET_PATH}?v=${primp.assets.hook.hash}`, `script src ${stub.scriptSrc}`)
      expect(record.pageErrors.length === 0, `page errors: ${record.pageErrors.join(' | ')}`)
      return `doc ${stub.doc}; hook src ${stub.scriptSrc}; ${record.webSockets.length} WebSocket(s) opened by the page; no page errors`
    })

    await report.attempt('session:hello is answered with session:state (target, framework, project name, no items)', async () => {
      const state = await waitForMessage(page, 'session:state')
      expect(state.info.target === fixture.url, `info.target ${state.info.target}`)
      expect(state.info.framework === 'vite', `info.framework ${state.info.framework}`)
      expect(state.info.projectName === 'vite-react-19', `info.projectName ${state.info.projectName}`)
      expect(state.items.length === 0, `${state.items.length} items in a new session`)
      const documents = primp.session.documents()
      expect(documents.length === 1 && documents[0]?.doc === docId && documents[0].visible, `session documents: ${JSON.stringify(documents)}`)
      return `info ${JSON.stringify(state.info)}; session knows 1 document, visible, viewport ${documents[0].viewport.w}x${documents[0].viewport.h}`
    })

    await report.attempt('the same socket reaches the settle detector, and the HMR socket passes through the tee', async () => {
      await waitFor(() => primp.detector.status().browsers === 1, { what: 'the settle detector to count the document' })
      await waitFor(() => primp.hmr.status().live, { what: 'the HMR socket to pass through the proxy' })
      const stub = await waitFor(async () => {
        const current = await stubOf(page)
        return current.settleMessages > 0 ? current : undefined
      }, { what: 'a settle:probe to reach the page' })
      const hmr = primp.hmr.status()
      return `detector: ${primp.detector.status().browsers} browser, watch backend ${primp.detector.status().watchBackend}; page got ${stub.settleMessages} settle:* message(s); tee: framework ${hmr.framework}, live ${hmr.live}, ${hmr.recognised} recognised message(s)`
    })

    // --- resolve -------------------------------------------------------------
    const labels = labelsOnPage(fixture, '/')
    const resolved = new Map<string, SourceLoc | null>()
    await report.attempt(`session:resolve with real collectEvidence: at least ${SOURCE_TARGET * 100}% of the labels on / come back with the labelled file and line, at level exact`, async () => {
      const rows: { label: FixtureLabel; source: SourceLoc | null; ok: boolean }[] = []
      for (const label of labels) {
        const evidence = await page.evaluate((name) => window.__primpM1?.collect?.(`[data-label="${name}"]`, 0) ?? null, label.label)
        if (evidence === null) {
          rows.push({ label, source: null, ok: false })
          continue
        }
        const answer = await request<'session:resolved'>(page, { type: 'session:resolve', reqId: `resolve-${label.label}`, evidence })
        resolved.set(label.label, answer.source)
        rows.push({ label, source: answer.source, ok: answer.source?.file === label.file && answer.source.line === label.line && answer.source.level === 'exact' })
      }
      const right = rows.filter((row) => row.ok)
      const wrongExact = rows.filter((row) => !row.ok && row.source?.level === 'exact')
      const misses = rows.filter((row) => !row.ok).map((row) => `${row.label.label}: expected ${row.label.file}:${row.label.line}, got ${where(row.source)}`)
      expect(rows.length >= 20, `only ${rows.length} labels on /`)
      expect(wrongExact.length === 0, `resolved as exact but wrong: ${wrongExact.map((row) => row.label.label).join(', ')}`)
      expect(right.length >= Math.ceil(SOURCE_TARGET * rows.length), `${right.length}/${rows.length} right\n${misses.join('\n')}`)
      const hero = rows.find((row) => row.label.label === 'hero-title')
      return `${right.length}/${rows.length} labels right (file + line + level exact), 0 wrong at level exact${misses.length > 0 ? `; misses: ${misses.join('; ')}` : ''}; e.g. hero-title -> ${where(hero?.source)} (labels.json: ${hero?.label.file}:${hero?.label.line})`
    })

    await report.attempt('a resolve request that carries no evidence is answered with source: null, not an error or silence', async () => {
      const answer = await request<'session:resolved'>(page, { type: 'session:resolve', reqId: 'resolve-nothing', evidence: { not: 'evidence' } })
      expect(answer.source === null, `source ${JSON.stringify(answer.source)}`)
      return 'source: null'
    })

    // --- upsert --------------------------------------------------------------
    await report.attempt('session:upsert of two drafts: both documents-wide states carry them, numbered by the server', async () => {
      const hero = await factsOf(page, 'hero-title')
      const banner = await factsOf(page, 'banner')
      const condition = { viewport: { w: 1280, h: 800, dpr: 1 }, colorScheme: 'light' as const }
      const style: StyleChange = {
        ...baseItem('m1-style', hero, resolved.get('hero-title') ?? null),
        kind: 'style',
        property: 'padding-top',
        scope: 'instance',
        before: { computed: hero.paddingTop },
        after: { authored: '24px', computed: '24px' },
        condition,
        stylingSystem: 'tailwind',
        note: 'more air above the title',
        expect: [{ type: 'computed', property: 'padding-top', value: '24px', condition }],
      }
      const structure: StructuralChange = { ...baseItem('m1-remove', banner, resolved.get('banner') ?? null), kind: 'structure', op: 'remove', expect: [{ type: 'absent' }] }
      items = { style, structure }
      // A second document, to see the broadcast.
      const second = await newPage(browser)
      try {
        await second.page.goto(`${primp.url}/`, { waitUntil: 'load' })
        await waitForMessage(second.page, 'session:state')
        await send(page, { type: 'session:upsert', item: style })
        await send(page, { type: 'session:upsert', item: structure })
        const here = await stateWhere(page, (current) => current.length === 2, 'both drafts in the first document')
        const there = await stateWhere(second.page, (current) => current.length === 2, 'both drafts in the second document')
        expect(here.every((item) => item.status === 'draft') && here[0]?.seq === 1 && here[1]?.seq === 2, `first document: ${here.map((item) => `${item.id} seq ${item.seq} ${item.status}`).join(', ')}`)
        expect(JSON.stringify(there) === JSON.stringify(here), 'the second document has a different state')
        expect(here[0]?.target.source?.file === 'src/components/Hero.tsx' && here[1]?.target.source?.file === 'src/components/Banner.tsx', `sources: ${here.map((item) => item.target.source?.file).join(', ')}`)
        return `${here.map((item) => `${item.id} seq ${item.seq} ${item.status} -> ${item.target.source?.file}:${item.target.source?.line}`).join('; ')}; the second open document received the same state`
      } finally {
        await second.close()
        await waitFor(() => primp.session.documents().length === 1, { what: 'the second document to disconnect' })
      }
    })

    // --- send ----------------------------------------------------------------
    await report.attempt('session:send queues both as one batch and answers with the prompt for the clipboard', async () => {
      expect(items !== undefined, 'the items were not created')
      const sent = await request<'session:sent'>(page, { type: 'session:send', reqId: 'send-1', ids: [items.style.id, items.structure.id] })
      batchId = sent.batch.batchId
      expect(batchId !== '', 'empty batch id: nothing was queued')
      expect(sent.batch.items.length === 2 && sent.batch.items.every((item) => item.status === 'queued' && item.batchId === batchId), `batch items: ${statusOf(sent.batch.items)}`)
      expect(sent.batch.prompt === renderPrompt(sent.batch.items, { batchId, channel: 'clipboard' }), 'the prompt is not what renderPrompt gives for these items with channel "clipboard"')
      expect(sent.batch.prompt.trim().length > 0, 'the prompt is empty')
      const after = await stateWhere(page, (current) => current.every((item) => item.status === 'queued'), 'both items queued')
      return `batch ${batchId}: ${statusOf(after)}; prompt ${sent.batch.prompt.length} chars, first line: ${JSON.stringify(sent.batch.prompt.split('\n')[0])}`
    })

    await report.attempt('session.measure reaches the visible document and resolves with its answer (plumbing only; the stub measures nothing)', async () => {
      expect(items !== undefined, 'the items were not created')
      const outcome = await primp.session.measure([items.style, items.structure], 5000)
      expect(outcome.status === 'measured', `outcome ${JSON.stringify(outcome)}`)
      expect(outcome.doc === docId && outcome.visible, `doc ${outcome.doc}, visible ${outcome.visible}`)
      expect(outcome.results.map((result) => result.itemId).join(',') === 'm1-style,m1-remove', `results for ${outcome.results.map((result) => result.itemId).join(',')}`)
      const none = await primp.session.measure([], 150).then((first) => first.status)
      return `status measured from doc ${outcome.doc}, visible ${outcome.visible}, ${outcome.results.length} per-item results; an empty request is answered too (${none})`
    })
  }

  // --- B: MCP ----------------------------------------------------------------
  if (sections.has('b')) {
    report.section('B. MCP client over the real stdio shim (primp mcp)')
    if (batchId === undefined || items === undefined) {
      report.skip('MCP checks', 'section A did not queue a batch (run with sections a,b)')
    } else {
      const queued = items
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', TSX_LOADER, CLI_ENTRY, 'mcp'],
        // An agent host starts the shim somewhere inside the project.
        cwd: join(fixture.dir, 'src'),
        env: { ...getDefaultEnvironment(), [SESSION_DIR_ENV]: SESSION_DIR },
        stderr: 'pipe',
      })
      let stderr = ''
      transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const client = new Client({ name: 'primp-spike-m1', version: '0.0.0' })
      onCleanup(() => client.close().catch(() => undefined))
      const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => (await client.callTool({ name, arguments: args })) as CallToolResult

      const connected = await report.attempt('the shim starts from a subdirectory of the project and lists get_session, get_pending_changes, dismiss_change', async () => {
        await client.connect(transport)
        const { tools } = await client.listTools()
        const names = tools.map((tool) => tool.name)
        expect(['get_session', 'get_pending_changes', 'dismiss_change'].every((name) => names.includes(name)), `tools: ${names.join(', ')}`)
        const instructions = client.getInstructions() ?? ''
        expect(instructions.includes('get_pending_changes') && instructions.includes('dismiss_change'), 'the server instructions do not describe the loop')
        return `tools: ${names.join(', ')}; instructions ${instructions.length} chars; descriptions ${tools.map((tool) => `${tool.name} ${tool.description?.length ?? 0}`).join(', ')} chars`
      })

      if (!connected) {
        report.skip('MCP tool calls', `no connection to the shim${stderr === '' ? '' : `; its stderr: ${stderr.trim()}`}`)
      } else {
        await report.attempt('get_session: browser connected, two queued, nothing claimed', async () => {
          const result = await call('get_session')
          expect(result.isError !== true, textOf(result))
          const summary = SessionSummarySchema.parse(result.structuredContent)
          expect(summary.browserConnected && summary.target === fixture.url && summary.framework === 'vite', JSON.stringify(summary))
          expect(summary.counts.queued === 2 && Object.keys(summary.counts).length === 1, `counts ${JSON.stringify(summary.counts)}`)
          expect(textOf(result).includes(primp.url), 'the text does not name the proxy URL')
          return `structuredContent ${JSON.stringify(summary)}; text ${textOf(result).length} chars`
        })

        await report.attempt('get_pending_changes: both items come back claimed, grouped by source file, with the MCP prompt; the batch is anchored at the journal mark', async () => {
          const markBefore = primp.detector.mark()
          const result = await call('get_pending_changes')
          expect(result.isError !== true, textOf(result))
          const pending = PendingChangesSchema.parse(result.structuredContent)
          expect(pending.count === 2 && pending.batchIds.join() === batchId, `count ${pending.count}, batches ${pending.batchIds.join()}`)
          const groups = pending.files.map((group) => `${group.file}: ${group.items.map((item) => `${item.id} ${item.status}`).join(', ')}`)
          expect(
            pending.files.length === 2 &&
              pending.files[0]?.file === 'src/components/Hero.tsx' &&
              pending.files[0].items[0]?.id === queued.style.id &&
              pending.files[1]?.file === 'src/components/Banner.tsx' &&
              pending.files[1].items[0]?.id === queued.structure.id,
            `groups: ${groups.join(' | ')}`,
          )
          const all = pending.files.flatMap((group) => group.items)
          expect(all.every((item) => item.status === 'claimed' && item.claimedAt === pending.claimedAt), `statuses: ${statusOf(all)}`)
          expect(pending.prompt === renderPrompt(all, { batchId: batchId as string, channel: 'mcp' }), 'the prompt is not what renderPrompt gives for these items with channel "mcp"')
          expect(textOf(result).includes(pending.prompt) && textOf(result).includes('src/components/Hero.tsx'), 'the text content lacks the prompt or the file list')
          const batch = primp.session.batch(batchId as string)
          const markAfter = primp.detector.mark()
          expect(batch?.claimedAt === pending.claimedAt, `batch.claimedAt ${batch?.claimedAt}, result ${pending.claimedAt}`)
          expect(batch?.claimMark !== undefined && batch.claimMark.seq >= markBefore.seq && batch.claimMark.seq <= markAfter.seq, `claimMark ${JSON.stringify(batch?.claimMark)}, journal before ${markBefore.seq}, after ${markAfter.seq}`)
          const inPage = await stateWhere(page, (current) => current.every((item) => item.status === 'claimed'), 'the page to see both items claimed')
          const again = PendingChangesSchema.parse((await call('get_pending_changes')).structuredContent)
          expect(again.count === 0, `a second call returned ${again.count} item(s)`)
          return `${groups.join(' | ')}; claimedAt ${pending.claimedAt}; claimMark seq ${batch.claimMark.seq}; the page shows ${statusOf(inPage)}; a second call returns 0`
        })

        await report.attempt('dismiss_change: the item is dismissed with the reason, the page sees it, and a repeat is refused as a tool error', async () => {
          const reason = 'The banner is rendered by a shared package; spike check.'
          const result = await call('dismiss_change', { id: queued.structure.id, reason })
          expect(result.isError !== true, textOf(result))
          const dismissed = DismissChangeResultSchema.parse(result.structuredContent)
          expect(dismissed.dismissed && dismissed.status === 'dismissed', JSON.stringify(dismissed))
          const inPage = await stateWhere(page, (current) => current.some((item) => item.status === 'dismissed'), 'the page to see the dismissal')
          const item = inPage.find((candidate) => candidate.id === queued.structure.id)
          expect(item?.dismissReason === reason, `dismissReason ${item?.dismissReason}`)
          const repeat = await call('dismiss_change', { id: queued.structure.id, reason: 'again' })
          expect(repeat.isError === true && textOf(repeat).includes('was not dismissed'), `repeat: ${JSON.stringify(repeat)}`)
          const summary = SessionSummarySchema.parse((await call('get_session')).structuredContent)
          expect(summary.counts.claimed === 1 && summary.counts.dismissed === 1, `counts ${JSON.stringify(summary.counts)}`)
          return `${textOf(result)} The page shows ${statusOf(inPage)}; repeat -> isError with "${textOf(repeat)}"; counts ${JSON.stringify(summary.counts)}`
        })
      }

      // --- C: shutdown ---------------------------------------------------------
      if (sections.has('c')) {
        report.section('C. shutdown')
        await report.attempt('close() removes the session file, closes the socket and both ports; the shim then says primp is not running', async () => {
          const before = sessionFiles()
          expect(before.length === 1 && existsSync(primp.sessionFile), `session files before close: ${before.join(', ')}`)
          await primp.close()
          expect(sessionFiles().length === 0 && !existsSync(primp.sessionFile), `session files after close: ${sessionFiles().join(', ')}`)
          await waitFor(async () => !(await stubOf(page)).socketOpen, { what: 'the page to see its socket close' })
          const proxyGone = await rawRequest(`${primp.url}/`).then(() => false, () => true)
          const controlGone = await rawRequest(`http://127.0.0.1:${primp.controlPort}/rpc`, { method: 'POST' }).then(() => false, () => true)
          expect(proxyGone && controlGone, `proxy refuses: ${proxyGone}, control refuses: ${controlGone}`)
          expect((await rawRequest(`${fixture.url}/`)).status === 200, 'the dev server stopped answering')
          let shimSays = '(shim not connected)'
          if (connected) {
            const result = await call('get_session')
            shimSays = textOf(result)
            expect(result.isError === true && shimSays.startsWith(NOT_RUNNING), `shim after close: ${shimSays}`)
          }
          const warnings = primp.logs.filter((line) => line.startsWith('warn') || line.startsWith('error'))
          expect(warnings.length === 0, `primp logged: ${warnings.join(' | ')}`)
          return `session file gone; proxy port ${primp.port} and control port ${primp.controlPort} refuse connections; dev server still answers; shim: "${shimSays.split('\n')[0]}"; no warnings or errors logged by primp`
        })
      }
      await client.close().catch(() => undefined)
    }
  }
  await primp.close()
  await fixture.stop()
}

// ---------------------------------------------------------------------------
// D: cls-corpus, shifts through the session
// ---------------------------------------------------------------------------

interface CulpritRow {
  page: string
  kind: string
  expected: string
  got: string
  level: string
  ok: boolean
}

async function corpusSection(browser: Browser): Promise<void> {
  report.section('D. cls-corpus: session:shifts -> session:shift-report with culprit sources')
  const fixture = await startFixture('cls-corpus')
  const primp = await startFor(fixture)
  const pages = listCorpus(fixture.sourceDir).filter((page) => page.expected.positive)
  const rows: CulpritRow[] = []
  const problems: string[] = []

  const runPage = async (corpusPage: CorpusPage): Promise<void> => {
    const handle = await newPage(browser)
    try {
      await handle.page.goto(primp.url + corpusPage.path, { waitUntil: 'commit' })
      for (const step of corpusPage.expected.interactions ?? []) {
        await sleep(step.afterMs ?? 0)
        await handle.page.click(step.click)
      }
      const observeMs = corpusPage.expected.observeMs ?? 2000
      await handle.page.waitForFunction((ms) => performance.now() >= ms, observeMs, { polling: 50, timeout: observeMs + 15_000 })
      const from = (await stubOf(handle.page)).received
      // The page hands over what its hook recorded, as the dock will.
      await handle.page.evaluate(() => {
        const stub = window.__primpM1 as M1Stub
        const hook = window.__primp
        if (hook === undefined) throw new Error('window.__primp is missing')
        stub.send({ type: 'session:shifts', doc: stub.doc, recording: hook.recording() })
      })
      const answer = await waitForMessage(handle.page, 'session:shift-report', from, 15_000)
      if (answer.report.status !== 'ok') problems.push(`${corpusPage.name}: report status ${answer.report.status} (${answer.report.reason ?? 'no reason'})`)
      const scored: ShiftIssue[] = answer.report.issues.filter((issue) => issue.scored).sort((a, b) => a.startTime - b.startTime)
      for (const [index, want] of corpusPage.expected.shifts.entries()) {
        const issue = scored[index]
        const source = issue === undefined ? undefined : answer.culpritSources[issue.id]
        const got = source?.file === undefined ? '-' : `${source.file}:${source.line ?? '?'}`
        const expected = `${want.culpritFile}:${want.culpritLine}`
        rows.push({ page: corpusPage.name, kind: want.culpritLineKind, expected, got, level: source === undefined ? '-' : `${source.level}, ${source.via}`, ok: got === expected })
      }
    } catch (error) {
      problems.push(`${corpusPage.name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      for (const want of corpusPage.expected.shifts) rows.push({ page: corpusPage.name, kind: want.culpritLineKind, expected: `${want.culpritFile}:${want.culpritLine}`, got: '(page failed)', level: '-', ok: false })
    } finally {
      await handle.close()
    }
  }
  const queue = [...pages]
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await runPage(next)
    }),
  )
  rows.sort((a, b) => a.page.localeCompare(b.page))

  report.info(
    `Culprit source per expected shift (${pages.length} positive pages, one load each, through ${primp.url}):\n` +
      rows.map((row) => `${row.ok ? 'ok  ' : 'MISS'} ${row.page.padEnd(42)} ${row.kind.padEnd(13)} expected ${row.expected.padEnd(56)} got ${row.got}  [${row.level}]`).join('\n'),
  )
  report.check('every corpus page loaded through primp and got an "ok" shift report over the socket', problems.length === 0 && rows.length > 0, problems.join('\n') || `${pages.length} pages, ${rows.length} expected shifts`)
  const right = rows.filter((row) => row.ok)
  const byKind = (kind: string): string => `${rows.filter((row) => row.kind === kind && row.ok).length}/${rows.filter((row) => row.kind === kind).length}`
  report.check(
    `culpritSources names the labelled file and line for at least ${CULPRIT_TARGET * 100}% of the expected shifts`,
    rows.length > 0 && right.length >= Math.ceil(CULPRIT_TARGET * rows.length),
    `${right.length}/${rows.length}: opening-tag culprits ${byKind('opening-tag')} (index path in the page's HTML file), script-insert culprits ${byKind('script-insert')} (stack of the DOM call)`,
  )
  const wrongExact = rows.filter((row) => !row.ok && row.level.startsWith('exact'))
  report.check('no culprit source is reported at level exact with the wrong file or line', wrongExact.length === 0, wrongExact.map((row) => `${row.page}: expected ${row.expected}, got ${row.got} [${row.level}]`).join('\n') || `${rows.filter((row) => row.level.startsWith('exact')).length} sources at level exact, all right`)
  const warnings = primp.logs.filter((line) => line.startsWith('warn') || line.startsWith('error'))
  report.check('primp logged no warnings or errors while doing so', warnings.length === 0, warnings.slice(0, 5).join('\n') || 'none')
  await primp.close()
  await fixture.stop()
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(SESSION_DIR, { recursive: true })
  onCleanup(() => rmSync(SESSION_DIR, { recursive: true, force: true }))
  const browser = await launchBrowser()
  report.info(`Chromium ${browser.version()} headless; session files in ${SESSION_DIR} (${SESSION_DIR_ENV}), not in the home directory`)
  if (sections.has('a') || sections.has('b') || sections.has('c')) await viteSections(browser)
  if (sections.has('d')) await corpusSection(browser)
  if (partial) report.check('complete run', false, 'this was a partial run (--sections); it cannot pass')
}

try {
  await main()
} catch (error) {
  report.check('spike ran to completion', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await runCleanups()
  report.finish()
}
