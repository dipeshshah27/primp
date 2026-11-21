import {
  beforeValueFor,
  judgeCheck,
  judgeItem,
  renderFixup,
  type JudgeExtras,
  type Measured,
  type SettleInfo,
} from '@reglet/engine'
import type { ChangeItem, CheckResult, Expectation, ItemStatus, Rect, VerificationResult, VerificationStatus } from '@reglet/protocol/change'
import type { MeasuredItem, Session } from './session.ts'
import type { JournalPosition, SettleDetector, SettleResult } from './settle.ts'

/**
 * Closed-loop verification: after an agent (or a person) edited the source,
 * wait until the page has settled, have the dock measure every expectation of
 * the changes with all previews off, judge the measurements, and store one
 * VerificationResult per change.
 *
 * The browser only measures. Judging (tolerances, drift, the roll-up and the
 * hint) is the engine's, so it is the same for MCP and for the dock.
 *
 * A result is never `pass` unless the page was measured: no browser, a hidden
 * tab, a build error, or an unanswered measurement each have their own status.
 */

export interface VerifyParams {
  /** Changes to verify. Default: every change that is claimed, queued or failed. */
  ids?: readonly string[]
  /** How long to wait for the page to settle. Default 5000. */
  waitMs?: number
}

export interface VerifyOutcome {
  results: VerificationResult[]
  /** Counts of `results` by verification status. */
  counts: Partial<Record<VerificationStatus, number>>
  /** Prompt listing what did not pass, for the agent's next pass; empty when everything passed. */
  fixup: string
  /** One sentence for a person or an agent reading only this. */
  summary: string
}

export interface VerifierOptions {
  session: Session
  detector: Pick<SettleDetector, 'waitForSettle' | 'journal'>
  now?: () => number
  /** Time given to the watcher to report a write made just before the call. Default 150. */
  graceMs?: number
  /** How long the browser may take to answer a measurement. Default 5000. */
  measureTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface Verifier {
  verify(params?: VerifyParams): Promise<VerifyOutcome>
}

/** Which item status a verification status leads to; undefined keeps the item as it is (nothing was learned). */
export function itemStatusAfter(status: VerificationStatus): ItemStatus | undefined {
  switch (status) {
    case 'pass':
    case 'drift':
      return 'verified'
    case 'fail':
    case 'unresolved':
    case 'no_update_observed':
    case 'build_error':
      return 'failed'
    case 'not_measurable':
    case 'tab_hidden':
    case 'no_browser':
      return undefined
  }
}

const VERIFIABLE: ReadonlySet<ItemStatus> = new Set<ItemStatus>(['queued', 'claimed', 'failed', 'verified'])

const parseRect = (text: string): Rect | undefined => {
  try {
    const value = JSON.parse(text) as Partial<Rect> | null
    if (value !== null && [value.x, value.y, value.w, value.h].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return { x: value.x as number, y: value.y as number, w: value.w as number, h: value.h as number }
    }
  } catch {
    // Not a rect.
  }
  return undefined
}

/**
 * Turns one raw check from the dock into what the judge takes.
 *
 * Wire convention (packages/overlay/src/probe/measure.ts):
 *   computed  expected = the target as a computed string, actual = the computed value now;
 *             status `not_measurable` when the media condition does not match
 *   no-move   expected / actual = the recorded / current rect as JSON
 *   absent, hidden   actual = `absent` | `hidden` | `rendered`
 * `unresolved` on any check means the element was not found.
 */
export function toMeasured(raw: CheckResult, item: MeasuredItem): Measured {
  const expectation: Expectation = raw.expectation
  const base = { found: item.found && raw.status !== 'unresolved', locatorConfidence: item.locatorConfidence }
  switch (expectation.type) {
    case 'computed':
      return {
        ...base,
        mediaMatches: raw.status !== 'not_measurable',
        ...(base.found ? { actual: raw.actual, expectedComputed: raw.expected } : {}),
      }
    case 'no-move': {
      // The constrained element is located on its own; `unresolved` there is about it, not about the item's target.
      const rect = raw.status === 'unresolved' ? undefined : parseRect(raw.actual)
      return { found: rect !== undefined, locatorConfidence: item.locatorConfidence, ...(rect === undefined ? {} : { rectNow: rect }) }
    }
    case 'absent':
    case 'hidden': {
      const present = raw.actual !== 'absent' && item.found
      return { found: present, locatorConfidence: item.locatorConfidence, present, rendered: present && raw.actual === 'rendered' }
    }
  }
}

const toSettleInfo = (settle: SettleResult): SettleInfo => ({
  status: settle.status,
  signal: settle.signal,
  ms: settle.ms,
  filesChanged: settle.filesChanged,
  reason: settle.reason,
  ...(settle.error === undefined ? {} : { error: settle.error }),
})

export function createVerifier(options: VerifierOptions): Verifier {
  const { session, detector } = options
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const graceMs = options.graceMs ?? 150
  const measureTimeoutMs = options.measureTimeoutMs ?? 5000

  /** Start of the settle window of an item: when its batch was claimed, else when it was sent. */
  const windowStart = (item: ChangeItem): number | JournalPosition => {
    const batch = item.batchId === undefined ? undefined : session.batch(item.batchId)
    return batch?.claimMark ?? item.claimedAt ?? batch?.claimedAt ?? batch?.sentAt ?? item.createdAt
  }
  const startTime = (start: number | JournalPosition): number => (typeof start === 'number' ? start : start.at)

  const verify = async (params: VerifyParams = {}): Promise<VerifyOutcome> => {
    const wanted =
      params.ids === undefined
        ? session.items().filter((item) => item.status === 'claimed' || item.status === 'queued' || item.status === 'failed')
        : params.ids.map((id) => session.item(id)).filter((item): item is ChangeItem => item !== undefined)
    const items = wanted.filter((item) => VERIFIABLE.has(item.status))
    if (items.length === 0) {
      const unknown = params.ids?.filter((id) => session.item(id) === undefined) ?? []
      return {
        results: [],
        counts: {},
        fixup: '',
        summary:
          unknown.length > 0
            ? `No such change: ${unknown.join(', ')}. Ids come from get_pending_changes.`
            : 'Nothing to verify: no change is queued, claimed or failed.',
      }
    }

    // A write made right before this call may not have reached the watcher yet.
    await sleep(graceMs)
    // The earliest window start: everything any of these items could have caused is inside it.
    const since = items.map(windowStart).reduce((a, b) => (startTime(b) < startTime(a) ? b : a))
    const settle = await detector.waitForSettle({ since, timeoutMs: params.waitMs ?? 5000 })
    const settleInfo = toSettleInfo(settle)

    // A broken build renders an error overlay or a stale page: nothing measured there says anything about the edit.
    const measured = settle.status === 'build_error' ? undefined : await session.measure(items, measureTimeoutMs)
    const at = now()
    const results: VerificationResult[] = []
    for (const item of items) {
      const attempt = (item.verification?.attempt ?? 0) + 1
      const extras: JudgeExtras = { settle: settleInfo, visible: true, browser: true, attempt, now: at }
      let checks: CheckResult[] = []
      if (measured === undefined) {
        // build_error: judgeItem reports it from `settle`.
      } else if (measured.status === 'no_browser' || measured.status === 'disconnected') {
        extras.browser = false
      } else if (measured.status === 'timeout') {
        // A hidden tab runs its timers late or not at all; a visible one that does not answer is as good as gone.
        if (measured.visible) extras.browser = false
        else extras.visible = false
      } else {
        extras.visible = measured.visible
        const answer = measured.results.find((result) => result.itemId === item.id)
        if (answer === undefined) {
          extras.browser = false
        } else {
          extras.locatorConfidence = answer.locatorConfidence
          checks = answer.checks.map((raw) => {
            // The judge knows one reason a value cannot be measured (a media query that does not match).
            // Any other reason the probe gives (the colour scheme, for one) is passed through as it is.
            if (raw.status === 'not_measurable' && !(raw.expectation.type === 'computed' && raw.expectation.condition.media !== undefined)) {
              return { ...raw, note: raw.note ?? "could not be measured in the page's current state" }
            }
            const before = beforeValueFor(item, raw.expectation)
            return judgeCheck(raw.expectation, toMeasured(raw, answer), before === undefined ? {} : { before })
          })
        }
      }
      const result = judgeItem(item, checks, extras)
      results.push(result)
      const status = itemStatusAfter(result.status)
      session.patchItem(item.id, status === undefined ? { verification: result } : { status, verification: result })
    }

    const counts: Partial<Record<VerificationStatus, number>> = {}
    for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
    const passed = counts.pass ?? 0
    const after = items.map((item) => session.item(item.id)).filter((item): item is ChangeItem => item !== undefined)
    const fixup = passed === results.length ? '' : renderFixup(after, { channel: 'mcp' })
    const parts = Object.entries(counts).map(([status, count]) => `${count} ${status.replaceAll('_', ' ')}`)
    return {
      results,
      counts,
      fixup,
      summary: `Verified ${results.length} change${results.length === 1 ? '' : 's'}: ${parts.join(', ')}.`,
    }
  }

  // One at a time: two overlapping runs would measure the same page twice and count two attempts.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    verify(params) {
      const run = queue.then(() => verify(params))
      queue = run.catch(() => {})
      return run
    },
  }
}

export interface AutoVerifyOptions {
  session: Session
  detector: Pick<SettleDetector, 'journal'>
  verifier: Verifier
  /** How often to look for source changes. Default 500. */
  intervalMs?: number
  /** Source files must have been untouched for this long first (an agent edits several files in a row). Default 1500. */
  quietMs?: number
  now?: () => number
  log?: (message: string, error?: unknown) => void
}

/**
 * Verifies without being asked, for the person who pasted the prompt instead
 * of using MCP: once source files have changed and then stayed untouched for
 * `quietMs`, the changes that are out but that no agent has claimed over MCP
 * are verified. This is what makes the dock's Verify tab fill in by itself.
 *
 * Changes claimed over MCP are left alone: that agent calls `verify_changes`
 * when it is done, and a check in the middle of its edits would only report
 * failures that are about to disappear.
 *
 * Returns the function that stops it.
 */
export function startAutoVerify(options: AutoVerifyOptions): () => void {
  const { session, detector, verifier } = options
  const now = options.now ?? Date.now
  const quietMs = options.quietMs ?? 1500
  const newestSeq = (from: number): number => detector.journal().reduce((max, entry) => Math.max(max, entry.seq), from)
  let seenSeq = newestSeq(-1)
  let changedAt: number | undefined
  let running = false
  let stopped = false

  /** Out with someone, and nobody will ask for verification over MCP. */
  const unattended = (item: ChangeItem): boolean => {
    if (item.status === 'queued') return true
    if (item.status !== 'failed') return false
    const batch = item.batchId === undefined ? undefined : session.batch(item.batchId)
    return batch?.claimedAt === undefined && item.claimedAt === undefined
  }

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    const entries = detector.journal({ seq: seenSeq, at: 0 })
    seenSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), seenSeq)
    if (entries.some((entry) => entry.source === 'fs')) changedAt = now()
    if (changedAt === undefined || now() - changedAt < quietMs) return
    changedAt = undefined
    const open = session.items().filter(unattended)
    if (open.length === 0) return
    running = true
    try {
      await verifier.verify({ ids: open.map((item) => item.id) })
    } catch (error) {
      options.log?.('automatic verification failed', error)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), options.intervalMs ?? 500)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
