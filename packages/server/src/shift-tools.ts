import { renderPrompt } from '@reglet/engine'
import type { SourceLoc } from '@reglet/protocol/change'
import type { NodeDescriptor, ShiftIssue, ShiftReport } from '@reglet/protocol/shift'
import type { Session, SessionShifts } from './session.ts'

/**
 * Layout shifts for an agent: what the page's last load showed
 * (`getLayoutShifts`), and whether a shift is gone after the source was
 * changed (`verifyLayoutShift`), measured by reloading the developer's tab a
 * few times with the browser cache out of the way.
 *
 * A shift only counts as gone when it was looked for and not found: a tab
 * that was hidden during a replay, or that did not report, gives
 * `tab_hidden` / `not_measurable`, never `pass`.
 */

export interface LayoutShiftSummary {
  id: string
  /** Layout-shift score of this issue; a page's total should stay under 0.1. */
  value: number
  cause: ShiftIssue['cause']
  /** 0 to 1; 0.7 and above only when the culprit's change in size explains the movement. */
  confidence: number
  culprit: { label: string; selector: string } | null
  source: SourceLoc | null
  /** Labels of the elements that moved. */
  moved: string[]
  evidence: string[]
}

export interface LayoutShiftsResult {
  /** `ok`: measured (an empty list then means no shifts). Anything else: not measured, see `message`. */
  status: ShiftReport['status'] | 'no_report'
  /** Page the shifts were measured on. */
  url: string | null
  /** The page's Cumulative Layout Shift for that load; null when not measured. */
  cls: number | null
  issues: LayoutShiftSummary[]
  /** The issues written out as instructions; empty when there is none. */
  prompt: string
  message: string
}

export interface ShiftReplay {
  load: number
  status: ShiftReport['status'] | 'no_browser' | 'no_report'
  /** The page's CLS in this load. */
  cls: number | null
  /** Score of what is left of the issue in this load: shifts with the same culprit or the same moved elements. */
  remaining: number | null
  /** Same-origin resources that came from the browser cache anyway; non-empty means this load was not fully cold. */
  cached: string[]
}

export interface ShiftVerification {
  id: string
  status: 'pass' | 'fail' | 'tab_hidden' | 'no_browser' | 'not_measurable' | 'unknown_id'
  /** Score of the issue when it was reported. */
  before: number | null
  replays: ShiftReplay[]
  /** One or two sentences an agent can act on. */
  hint: string
}

export interface ShiftToolsOptions {
  session: Pick<Session, 'shifts' | 'reload' | 'documents'>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long one reload may take to come back with a report. Default 20000. */
  replayTimeoutMs?: number
  /** After the first report of a load, how long to wait for a later, fuller one. Default 1200. */
  graceMs?: number
  /** Reloads per verification. Default 3. */
  loads?: number
}

export interface ShiftTools {
  getLayoutShifts(params?: { minValue?: number }): LayoutShiftsResult
  verifyLayoutShift(params: { id: string }): Promise<ShiftVerification>
  /** True while a replay is running: document responses then also clear what the browser cached earlier. */
  cold(): boolean
}

/** What is kept of a reported issue, to recognise it again in a later load. */
interface KnownIssue {
  id: string
  value: number
  url: string
  culprit: NodeDescriptor | undefined
  victims: NodeDescriptor[]
}

/** An issue with less than this share of its original score left counts as gone. */
const GONE_SHARE = 0.1
/** Below this score a remainder is noise whatever the original was. */
const GONE_FLOOR = 0.001

const label = (node: NodeDescriptor | null | undefined): string => {
  if (node === null || node === undefined) return '(node gone)'
  if (node.id !== undefined && node.id !== '') return `${node.tag}#${node.id}`
  const classes = (node.classes ?? []).slice(0, 2)
  return classes.length > 0 ? `${node.tag}.${classes.join('.')}` : node.selector
}

/** The same element in another load of the same page: by id when it has one, else by selector. Never by `uid`, which is per document. */
function sameNode(a: NodeDescriptor | null | undefined, b: NodeDescriptor | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (a.tag !== b.tag) return false
  if (a.id !== undefined && a.id !== '' && b.id !== undefined && b.id !== '') return a.id === b.id
  return a.selector === b.selector
}

/** Whether `issue`, from a later load, is (part of) the known issue: same culprit, or it moved one of the same elements. */
export function matchesKnown(issue: ShiftIssue, known: Pick<KnownIssue, 'culprit' | 'victims'>): boolean {
  if (sameNode(issue.culprit?.node, known.culprit)) return true
  return issue.victims.some((victim) => known.victims.some((before) => sameNode(victim.node, before)))
}

const pagePath = (url: string): string => {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}

export function createShiftTools(options: ShiftToolsOptions): ShiftTools {
  const { session } = options
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const replayTimeoutMs = options.replayTimeoutMs ?? 20_000
  const graceMs = options.graceMs ?? 1200
  const loads = options.loads ?? 3
  const known = new Map<string, KnownIssue>()
  let replaying = 0

  const summarise = (issue: ShiftIssue, latest: SessionShifts): LayoutShiftSummary => ({
    id: issue.id,
    value: issue.value,
    cause: issue.cause,
    confidence: issue.confidence,
    culprit: issue.culprit === undefined ? null : { label: label(issue.culprit.node), selector: issue.culprit.node.selector },
    source: latest.culpritSources[issue.id] ?? null,
    moved: [...new Set(issue.victims.map((victim) => label(victim.node)))].slice(0, 8),
    evidence: issue.evidence,
  })

  const getLayoutShifts = (params: { minValue?: number } = {}): LayoutShiftsResult => {
    const latest = session.shifts()
    if (latest === undefined) {
      const connected = session.documents().length > 0
      return {
        status: 'no_report',
        url: null,
        cls: null,
        issues: [],
        prompt: '',
        message: connected
          ? 'The page has not reported its layout shifts yet (the dock reports a few seconds after the page has loaded). Try again shortly.'
          : 'No browser tab with the reglet dock is connected, so nothing was measured. Ask the developer to open the app through reglet.',
      }
    }
    const { report, recording } = latest
    if (report.status !== 'ok') {
      return {
        status: report.status,
        url: recording.url,
        cls: null,
        issues: [],
        prompt: '',
        message:
          report.status === 'tab_hidden'
            ? 'The tab was not visible while the page loaded, so layout shifts could not be measured: this is not "no shifts". Ask the developer to bring the tab to the front and reload.'
            : `Layout shifts could not be measured${report.reason === undefined ? '' : `: ${report.reason}`}.`,
      }
    }
    const minValue = params.minValue ?? 0
    const issues = report.issues.filter((issue) => issue.scored && issue.value >= minValue)
    known.clear()
    for (const issue of issues) {
      known.set(issue.id, {
        id: issue.id,
        value: issue.value,
        url: recording.url,
        culprit: issue.culprit?.node,
        victims: issue.victims.map((victim) => victim.node).filter((node): node is NodeDescriptor => node !== null),
      })
    }
    // Only issues with a named cause are written out as instructions; the rest are listed for the reader to judge.
    const named = issues.some((issue) => issue.cause !== 'unknown' && issue.cause !== 'dev-artifact')
    const prompt = !named ? '' : renderPrompt([], { batchId: 'layout-shifts', channel: 'mcp' }, { shifts: issues, culpritSources: latest.culpritSources })
    const cls = report.cls ?? 0
    return {
      status: 'ok',
      url: recording.url,
      cls,
      issues: issues.map((issue) => summarise(issue, latest)),
      prompt,
      message:
        issues.length === 0
          ? `No layout shifts on ${pagePath(recording.url)} in its last load (CLS ${cls.toFixed(3)}).`
          : `${issues.length} layout shift${issues.length === 1 ? '' : 's'} on ${pagePath(recording.url)} (CLS ${cls.toFixed(3)}; a page should stay under 0.1).`,
    }
  }

  /** Waits for the report of the load that followed a reload made at `since`. */
  const nextReport = async (since: number, previousDoc: string | undefined): Promise<SessionShifts | undefined> => {
    const deadline = now() + replayTimeoutMs
    let first: SessionShifts | undefined
    let firstSeenAt = 0
    while (now() < deadline) {
      const latest = session.shifts()
      const fresh = latest !== undefined && latest.at > since && latest.doc !== previousDoc
      if (fresh) {
        if (first === undefined || latest.at !== first.at) {
          // The dock may report once early and again when more entries have arrived: keep the newest.
          first = latest
          firstSeenAt = now()
        } else if (now() - firstSeenAt >= graceMs) {
          return first
        }
      }
      await sleep(100)
    }
    return first
  }

  const verifyLayoutShift = async ({ id }: { id: string }): Promise<ShiftVerification> => {
    const issue = known.get(id)
    if (issue === undefined) {
      return {
        id,
        status: 'unknown_id',
        before: null,
        replays: [],
        hint: `No layout shift with id ${id} is known. Ids come from the latest get_layout_shifts call; call it again.`,
      }
    }
    const replays: ShiftReplay[] = []
    replaying += 1
    try {
      for (let load = 1; load <= loads; load += 1) {
        const previous = session.shifts()
        const since = now()
        if (!session.reload(`layout-shift replay ${load} of ${loads}`)) {
          replays.push({ load, status: 'no_browser', cls: null, remaining: null, cached: [] })
          break
        }
        const report = await nextReport(since, previous?.doc)
        if (report === undefined) {
          replays.push({ load, status: 'no_report', cls: null, remaining: null, cached: [] })
          break
        }
        if (report.report.status !== 'ok') {
          replays.push({ load, status: report.report.status, cls: null, remaining: null, cached: report.report.cachedResources })
          break
        }
        const remaining = report.report.issues.filter((candidate) => candidate.scored && matchesKnown(candidate, issue)).reduce((sum, candidate) => sum + candidate.value, 0)
        replays.push({ load, status: 'ok', cls: report.report.cls ?? 0, remaining, cached: report.report.cachedResources })
      }
    } finally {
      replaying -= 1
    }

    const last = replays[replays.length - 1]
    const base = { id, before: issue.value, replays }
    if (last === undefined || last.status === 'no_browser') {
      return { ...base, status: 'no_browser', hint: 'No browser tab with the reglet dock is connected, so the page could not be reloaded and measured. Ask the developer to open the app through reglet.' }
    }
    if (last.status === 'tab_hidden') {
      return { ...base, status: 'tab_hidden', hint: 'The tab was not visible during a replay, and a hidden tab reports no layout shifts. Ask the developer to keep the tab in front, then verify again.' }
    }
    if (last.status !== 'ok') {
      return { ...base, status: 'not_measurable', hint: 'The page did not report its layout shifts after a reload (it may have failed to load, or navigated elsewhere). Check that the page loads, then verify again.' }
    }
    const threshold = Math.max(GONE_FLOOR, issue.value * GONE_SHARE)
    const worst = Math.max(...replays.map((replay) => replay.remaining ?? 0))
    const warm = replays.some((replay) => replay.cached.length > 0)
    const caveat = warm ? ' Some resources came from the browser cache in at least one replay, so those loads were not fully cold.' : ''
    if (worst <= threshold) {
      return {
        ...base,
        status: 'pass',
        hint: `The shift did not come back in ${replays.length} cold reloads (was ${issue.value.toFixed(3)}; page CLS now ${replays.map((replay) => (replay.cls ?? 0).toFixed(3)).join(', ')}).${caveat}`,
      }
    }
    const share = worst / issue.value
    return {
      ...base,
      status: 'fail',
      hint:
        `The shift is still there: ${worst.toFixed(3)} of the original ${issue.value.toFixed(3)} remains in the worst of ${replays.length} reloads` +
        `${share < 0.6 ? ' (smaller than before, so the fix is partial)' : ''}. Call get_layout_shifts for the current evidence, fix the cause, then verify again.${caveat}`,
    }
  }

  return { getLayoutShifts, verifyLayoutShift, cold: () => replaying > 0 }
}
