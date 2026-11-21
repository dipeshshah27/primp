import {
  STATE_NOT_EMULATED,
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
import type { JournalEntry, JournalPosition, SettleDetector, SettleResult } from './settle.ts'

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
  detector: Pick<SettleDetector, 'waitForSettle' | 'journal' | 'mark'>
  now?: () => number
  /** Whether the dev server pushes updates into the page (an open HMR socket). Default: assumed true. */
  hotReload?: () => boolean
  /** How long a reloaded page may take to load, for sites without hot reload. Default 8000. */
  reloadTimeoutMs?: number
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

/**
 * The reason the dock gives when it could not emulate the interaction state of a `computed`
 * check (the text after `the state could not be emulated: `; may be empty). Undefined for every
 * other check, among them one whose media query does not match: the dock checks that first and
 * says so in another note.
 */
export function stateBlockedReason(raw: CheckResult): string | undefined {
  const expectation = raw.expectation
  if (raw.status !== 'not_measurable' || expectation.type !== 'computed' || expectation.condition.state === undefined) return undefined
  if (raw.note?.startsWith(STATE_NOT_EMULATED) !== true) return undefined
  return raw.note.slice(STATE_NOT_EMULATED.length).replace(/^\s*:\s*/, '').trim()
}

const parseLabels = (text: string): string[] | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[]
  } catch {
    // Not a list of labels.
  }
  return undefined
}

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
 *             status `not_measurable` when the media condition does not match.
 *             Under `condition.state` the value is read with the state emulated; when that
 *             cannot be done the status is `not_measurable` with a note that starts with
 *             `the state could not be emulated`. The media condition is checked first.
 *   order     expected = the labels of `expectation.siblings` in the wanted order, actual = the
 *             labels of those found again, in document order as it is now; both as JSON arrays.
 *             `unresolved`: the moved element was not found, or fewer than two of the list were.
 *             `fail`: the found ones do not stand in the wanted order under one parent.
 *   no-move   expected / actual = the recorded / current rect as JSON
 *   unchanged expected = the bystander's recorded computed value, actual = its computed value now
 *   absent, hidden   actual = `absent` | `hidden` | `rendered`
 * `unresolved` on any check means the element was not found: the item's target, or for no-move
 * and unchanged the element the check itself names.
 */
export function toMeasured(raw: CheckResult, item: MeasuredItem): Measured {
  const expectation: Expectation = raw.expectation
  const base = { found: item.found && raw.status !== 'unresolved', locatorConfidence: item.locatorConfidence }
  switch (expectation.type) {
    case 'computed': {
      // A state that could not be emulated is not a viewport that does not match: the media condition was checked before it.
      const stateBlocked = stateBlockedReason(raw)
      if (stateBlocked !== undefined) return { ...base, mediaMatches: true, stateBlocked }
      return {
        ...base,
        mediaMatches: raw.status !== 'not_measurable',
        ...(base.found ? { actual: raw.actual, expectedComputed: raw.expected } : {}),
      }
    }
    case 'no-move': {
      // The constrained element is located on its own; `unresolved` there is about it, not about the item's target.
      const rect = raw.status === 'unresolved' ? undefined : parseRect(raw.actual)
      return { found: rect !== undefined, locatorConfidence: item.locatorConfidence, ...(rect === undefined ? {} : { rectNow: rect }) }
    }
    case 'unchanged':
      // A bystander is located on its own too: whether the item's target was found says nothing about it.
      return raw.status === 'unresolved'
        ? { found: false, locatorConfidence: item.locatorConfidence }
        : { found: true, locatorConfidence: item.locatorConfidence, actual: raw.actual, expectedComputed: raw.expected }
    case 'absent':
    case 'hidden': {
      const present = raw.actual !== 'absent' && item.found
      return { found: present, locatorConfidence: item.locatorConfidence, present, rendered: present && raw.actual === 'rendered' }
    }
    case 'order': {
      // The moved element and its neighbours are located by the check itself, each with its own locator.
      const lost: Measured = { found: false, locatorConfidence: item.locatorConfidence }
      const wanted = expectation.siblings.map((sibling) => sibling.label)
      const expected = parseLabels(raw.expected)
      const actual = parseLabels(raw.actual)
      // Anything but two lists of the recorded labels is not an answer about this order.
      if (expected === undefined || actual === undefined || JSON.stringify(expected) !== JSON.stringify(wanted) || actual.some((label) => !wanted.includes(label))) return lost
      const self = expectation.siblings.find((sibling) => sibling.self === true)
      const selfFound = self === undefined ? actual.length > 0 : actual.includes(self.label)
      // `unresolved` with the moved element and a neighbour in the list contradicts itself: the dock was not sure, so neither are we.
      if (!selfFound || (raw.status === 'unresolved' && actual.length >= 2)) return lost
      return { found: true, locatorConfidence: item.locatorConfidence, order: { actual, ...(raw.status === 'pass' ? { inOrder: true } : raw.status === 'fail' ? { inOrder: false } : {}) } }
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
  const reloadTimeoutMs = options.reloadTimeoutMs ?? 8000

  /** Start of the settle window of an item: when its batch was claimed, else when it was sent. */
  const windowStart = (item: ChangeItem): number | JournalPosition => {
    const batch = item.batchId === undefined ? undefined : session.batch(item.batchId)
    return batch?.claimMark ?? item.claimedAt ?? batch?.claimedAt ?? batch?.sentAt ?? item.createdAt
  }
  const startTime = (start: number | JournalPosition): number => (typeof start === 'number' ? start : start.at)

  /**
   * Another change that is out and sets `property` on the element `selector` names, in the same
   * interaction state as `item` (a bystander is measured in the state its change is made for,
   * which is the resting one unless the change says otherwise): the one case in which a
   * bystander is meant to change. A `:hover` edit of the property does not explain a resting value that moved.
   */
  const changedElsewhere = (item: ChangeItem, selector: string, property: string): ChangeItem | undefined => {
    const state = item.kind === 'style' ? item.condition.state : undefined
    return session.items().find(
      (other) =>
        other.id !== item.id &&
        other.kind === 'style' &&
        other.status !== 'draft' &&
        other.status !== 'dismissed' &&
        other.condition.state === state &&
        other.target.selector === selector &&
        (other.property === property || Object.hasOwn(other.longhands ?? {}, property)),
    )
  }

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
    /** Reloads the tab and waits for the new document. False when no tab could be reloaded or none came back. */
    const reloadPage = async (reason: string): Promise<{ ok: boolean; quiet?: SettleResult }> => {
      const before = new Set(session.documents().map((document) => document.doc))
      const mark = detector.mark()
      if (!session.reload(reason)) return { ok: false }
      const deadline = now() + reloadTimeoutMs
      const isBack = (): boolean => session.documents().some((document) => !before.has(document.doc))
      while (now() < deadline && !isBack()) await sleep(50)
      if (!isBack()) return { ok: false }
      // Gives the new page time to finish loading; only a build error in it changes the verdict.
      return { ok: true, quiet: await detector.waitForSettle({ since: mark, timeoutMs: 1500 }) }
    }
    const afterReload = (base: Pick<SettleResult, 'ms' | 'filesChanged'>, quiet: SettleResult): SettleResult =>
      quiet.status === 'build_error'
        ? { ...quiet, filesChanged: base.filesChanged }
        : { ...quiet, status: 'settled', signal: 'fs', domChanged: true, ms: base.ms + quiet.ms, filesChanged: base.filesChanged, reason: 'no hot reload here: reglet reloaded the page after the source changed' }

    let reloaded = false
    let settle: SettleResult | undefined
    // A site without hot reload (plain HTML, templates rendered by a server) never updates by itself:
    // when a source file is newer than the page in the tab, reload it, as the developer would.
    if (options.hotReload?.() === false) {
      const changes = detector.journal(since).filter((entry): entry is Extract<JournalEntry, { source: 'fs' }> => entry.source === 'fs')
      const lastChange = Math.max(...changes.map((entry) => entry.mtimeMs ?? entry.at))
      const pageFrom = Math.max(...session.documents().map((document) => document.connectedAt))
      if (changes.length > 0 && lastChange > pageFrom) {
        const started = now()
        const result = await reloadPage('source files changed and this dev server has no hot reload')
        if (result.ok && result.quiet !== undefined) {
          reloaded = true
          settle = afterReload({ ms: now() - started - result.quiet.ms, filesChanged: [...new Set(changes.map((entry) => entry.path))] }, result.quiet)
        }
      }
    }
    settle ??= await detector.waitForSettle({ since, timeoutMs: params.waitMs ?? 5000 })
    // The same for a dev server whose hot reload did not reach this page: the source changed, the page did not.
    if (!reloaded && settle.status === 'no_update_observed' && settle.filesChanged.length > 0 && !settle.domChanged) {
      const result = await reloadPage('source files changed and the dev server did not update the page')
      if (result.ok && result.quiet !== undefined) {
        reloaded = true
        settle = afterReload(settle, result.quiet)
      }
    }
    const settleInfo = toSettleInfo(settle)

    // A broken build renders an error overlay or a stale page: nothing measured there says anything about the edit.
    let measured = settle.status === 'build_error' ? undefined : await session.measure(items, measureTimeoutMs)
    // A page that was just reloaded may not have its dock up yet: ask once more.
    if (reloaded && measured !== undefined && measured.status !== 'measured') {
      await sleep(1000)
      measured = await session.measure(items, measureTimeoutMs)
    }
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
            // The judge knows two reasons a value cannot be measured: a media query that does not match, and an
            // interaction state that could not be emulated. Any other reason the probe gives (the colour scheme,
            // for one) is passed through as it is.
            if (raw.status === 'not_measurable' && stateBlockedReason(raw) === undefined && !(raw.expectation.type === 'computed' && raw.expectation.condition.media !== undefined)) {
              return { ...raw, note: raw.note ?? "could not be measured in the page's current state" }
            }
            // More than one element could be the recorded one: "is it gone?" has no answer. Never read that as gone.
            if (raw.status === 'unresolved' && (raw.expectation.type === 'absent' || raw.expectation.type === 'hidden')) {
              return { ...raw, note: raw.note ?? 'the element could not be told apart from another, so its absence could not be checked' }
            }
            const before = beforeValueFor(item, raw.expectation)
            const judged = judgeCheck(raw.expectation, toMeasured(raw, answer), before === undefined ? {} : { before })
            // A bystander of this change that the developer then edited on purpose: its value was meant to change.
            if (judged.status === 'fail' && raw.expectation.type === 'unchanged') {
              const other = changedElsewhere(item, raw.expectation.selector, raw.expectation.property)
              if (other !== undefined) return { ...judged, status: 'pass', note: `not checked: \`${raw.expectation.property}\` of this element is changed by another change (${other.id})` }
            }
            return judged
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
