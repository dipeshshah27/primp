/**
 * The website's stand-in for primp's server: the session behind the fake socket of head.ts.
 * It answers the dock the way packages/server/src/session.ts does (messages:
 * packages/protocol/src/messages.ts):
 *
 *   session:hello    -> session:state
 *   session:resolve  -> session:resolved. primp's own text-search fallback (`grepCandidates`,
 *                       packages/source/src/node/grep.ts) over this website's .tsx and .mdx
 *                       sources, bundled as text at build time. A production React build carries
 *                       no source positions, so these are ranked guesses (level `candidates`),
 *                       exactly what primp reports on a project without framework evidence.
 *   session:upsert   -> stored in memory as a draft, then session:state
 *   session:delete   -> removed, then session:state
 *   session:send     -> drafts become queued; session:sent with the prompt rendered by the REAL
 *                       renderPrompt of packages/engine; the website shows it (components/live-dock.tsx)
 *   session:prompt   -> session:prompt-text: the same prompt for Copy, nothing queued
 *   session:shifts   -> session:shift-report from the REAL attributeShifts of packages/engine,
 *                       culprits looked up with the same text search
 *   anything else    -> ignored (settle:* traffic, reverify, visibility, measured)
 *
 * The server parses every message with the protocol's zod schemas; this bundle leaves zod out
 * (build-assets.ts swaps it for a pass-through stub) and trusts the dock, which is the real one.
 * Nothing is verified: verification needs an agent that edits source, and there is none here.
 */

import { renderPrompt } from '../../../packages/engine/src/prompt.ts'
import { attributeShifts } from '../../../packages/engine/src/shift-attributor.ts'
import type { ChangeItem, SourceLoc } from '../../../packages/protocol/src/change.ts'
import type { ClientMessage, ServerMessage, SessionInfo } from '../../../packages/protocol/src/messages.ts'
import type { ShiftIssue, ShiftRecording, ShiftReport } from '../../../packages/protocol/src/shift.ts'
import { toSourceLoc } from '../../../packages/server/src/source-loc.ts'
import type { ProjectFiles } from '../../../packages/source/src/node/files.ts'
import { grepCandidates } from '../../../packages/source/src/node/grep.ts'
import type { ElementContext, Evidence, Framework, SourceResult } from '../../../packages/source/src/types.ts'
import SOURCES from 'site-sources'
import { REPORT_EVENT, SENT_EVENT, type SiteEvents, type StandinHost, type StandinSocket } from './host.ts'

declare const __PRIMP_VERSION__: string

/**
 * The parts of ProjectFiles the text search uses (`list`, `read`), over the bundled sources.
 * Paths are relative to site/, as primp would report them for this project.
 */
const files: Pick<ProjectFiles, 'list' | 'read' | 'relative' | 'isFile' | 'bySuffix' | 'modifiedAt' | 'invalidate'> = {
  list: () => Object.keys(SOURCES),
  read: (rel) => SOURCES[rel],
  relative: (path) => {
    const rel = path.replace(/^\/+/, '')
    return rel in SOURCES ? rel : undefined
  },
  isFile: (rel) => rel in SOURCES,
  bySuffix: (suffix) => {
    const wanted = suffix.replace(/^\/+/, '')
    return Object.keys(SOURCES).filter((file) => file === wanted || file.endsWith(`/${wanted}`))
  },
  modifiedAt: () => 0,
  invalidate: () => undefined,
}
const projectFiles = files as unknown as ProjectFiles

function frameworkOfFile(file: string): Framework {
  return /\.[jt]sx$/.test(file) ? 'react' : 'unknown'
}

/** packages/source/src/node/resolve.ts, its last step: the text search, as ranked guesses. */
function search(context: ElementContext): SourceResult {
  const started = performance.now()
  const candidates = grepCandidates(projectFiles, context)
  const best = candidates[0]
  const resolveMs = performance.now() - started
  if (best === undefined) {
    return { framework: 'unknown', level: 'candidates', verifiedOnDisk: false, via: 'none', target: 'element', candidates: [], notes: [`no <${context.tag}> found in the project's markup files`], resolveMs }
  }
  return {
    framework: frameworkOfFile(best.file),
    file: best.file,
    line: best.line,
    col: best.col,
    level: 'candidates',
    verifiedOnDisk: true,
    via: 'grep',
    target: 'element',
    candidates,
    notes: [`no framework source information (a production React build); ranked by ${best.why.join(', ')}`],
    resolveMs,
  }
}

const isEvidence = (value: unknown): value is Evidence => {
  if (typeof value !== 'object' || value === null) return false
  const context = (value as { context?: unknown }).context
  return typeof context === 'object' && context !== null && typeof (context as { tag?: unknown }).tag === 'string'
}

/** packages/server/src/culprit-source.ts `contextOf` + its resolver fallback: tag, classes and the start of the text. */
function culpritSource(issue: ShiftIssue, recording: ShiftRecording): SourceLoc | undefined {
  const node = issue.culprit?.node
  if (node === undefined || node.tag === '#text') return undefined
  let pagePath = '/'
  try {
    pagePath = new URL(recording.url).pathname
  } catch {
    // Keep the default.
  }
  const context: ElementContext = {
    tag: node.tag,
    classes: [...(node.classes ?? [])],
    attrs: { ...node.attrs },
    ownText: node.text ?? '',
    text: node.text ?? '',
    path: [],
    pagePath,
    pageOrigin: location.origin,
    pageLoadedAt: 0,
  }
  if (node.id !== undefined) context.id = node.id
  const loc = toSourceLoc(search(context))
  if (loc === null || loc.file === undefined) return undefined
  return { ...loc, notes: [...loc.notes, 'guessed from the shift recording alone (tag, classes, start of the text); no framework evidence'] }
}

function start(host: StandinHost): void {
  const events: SiteEvents = { lastPrompt: null, lastReport: null }
  window.__primp_site = events

  const info: SessionInfo = { target: 'this website (in-browser stand-in)', framework: 'react', projectName: 'primp-site', version: __PRIMP_VERSION__ }
  const items = new Map<string, ChangeItem>()
  let seq = 0
  let batches = 0

  const sorted = (): ChangeItem[] => [...items.values()].sort((a, b) => a.seq - b.seq)
  const state = (): ServerMessage => ({ type: 'session:state', info, items: sorted() })
  const broadcast = (): void => {
    for (const socket of host.sockets) socket.deliver(state())
  }

  const receive = (socket: StandinSocket, text: string): void => {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return
    }
    const type = (raw as { type?: unknown } | null)?.type
    if (typeof type !== 'string' || !type.startsWith('session:')) return
    const message = raw as ClientMessage
    switch (message.type) {
      case 'session:hello':
        socket.doc = message.doc
        socket.deliver(state())
        return
      case 'session:resolve': {
        let source: SourceLoc | null = null
        if (isEvidence(message.evidence)) {
          try {
            source = toSourceLoc(search(message.evidence.context))
          } catch (error) {
            console.warn('[primp site] source lookup failed:', error)
          }
        }
        socket.deliver({ type: 'session:resolved', reqId: message.reqId, source })
        return
      }
      case 'session:upsert': {
        const incoming = message.item
        const existing = items.get(incoming.id)
        if (incoming.status !== 'draft' || (existing !== undefined && existing.status !== 'draft')) {
          socket.deliver(state())
          return
        }
        const item: ChangeItem = { ...incoming, status: 'draft', seq: existing?.seq ?? ++seq }
        delete item.batchId
        delete item.claimedAt
        delete item.verification
        delete item.dismissReason
        items.set(item.id, item)
        broadcast()
        return
      }
      case 'session:delete':
        if (items.get(message.id)?.status === 'draft') items.delete(message.id)
        broadcast()
        return
      case 'session:send': {
        const wanted = new Set(message.ids)
        const drafts = sorted().filter((item) => wanted.has(item.id) && item.status === 'draft')
        if (drafts.length === 0) {
          socket.deliver({ type: 'session:sent', reqId: message.reqId, batch: { batchId: '', items: [], prompt: '' } })
          socket.deliver(state())
          return
        }
        const batchId = `site-${++batches}`
        for (const item of drafts) {
          item.status = 'queued'
          item.batchId = batchId
        }
        let prompt: string
        try {
          prompt = renderPrompt(drafts, { batchId, channel: 'clipboard' })
        } catch (error) {
          prompt = `# primp batch ${batchId}: ${drafts.length} change(s)\n\nThe prompt could not be rendered (${error instanceof Error ? error.message : String(error)}).\n\n${JSON.stringify(drafts, null, 2)}`
        }
        events.lastPrompt = prompt
        socket.deliver({ type: 'session:sent', reqId: message.reqId, batch: { batchId, items: drafts, prompt } })
        broadcast()
        window.dispatchEvent(new CustomEvent(SENT_EVENT, { detail: { prompt, count: drafts.length } }))
        return
      }
      case 'session:prompt': {
        const wanted = new Set(message.ids)
        const drafts = sorted().filter((item) => wanted.has(item.id) && item.status === 'draft')
        let prompt = ''
        try {
          if (drafts.length > 0) prompt = renderPrompt(drafts, { batchId: 'preview', channel: 'clipboard' })
        } catch (error) {
          prompt = `The prompt could not be rendered (${error instanceof Error ? error.message : String(error)}).`
        }
        socket.deliver({ type: 'session:prompt-text', reqId: message.reqId, prompt, count: drafts.length })
        return
      }
      case 'session:shifts': {
        const recording: ShiftRecording = message.recording
        let report: ShiftReport
        try {
          report = attributeShifts(recording)
        } catch (error) {
          report = { status: 'not_measurable', reason: `the recording could not be analysed: ${error instanceof Error ? error.message : String(error)}`, cls: null, windows: [], issues: [], cachedResources: [], notes: [] }
        }
        const culpritSources: Record<string, SourceLoc> = {}
        for (const issue of report.issues) {
          try {
            const source = culpritSource(issue, recording)
            if (source !== undefined) culpritSources[issue.id] = source
          } catch {
            // Leave this culprit without a source.
          }
        }
        events.lastReport = report
        socket.deliver({ type: 'session:shift-report', doc: message.doc, report, culpritSources })
        window.dispatchEvent(new CustomEvent(REPORT_EVENT, { detail: { report, culpritSources } }))
        return
      }
      default:
        // session:measured, session:reverify, session:visibility: nothing asks for them here.
        return
    }
  }

  host.receive = receive
  for (const [socket, text] of host.pending.splice(0)) receive(socket, text)
}

const host = window.__primp_site_host
if (host !== undefined && host.receive === undefined) start(host)
