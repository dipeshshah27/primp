/**
 * The Shifts tab: the layout shifts of this page load as the server attributed them.
 * Read-only in this milestone. A report that could not measure says so; it never reads as
 * "no shifts".
 */

import type { NodeDescriptor, ShiftIssue } from '@reglet/protocol/shift'
import { useState } from 'preact/hooks'
import type { Controller } from '../state/controller.ts'
import type { Outline, ShiftState } from '../state/store.ts'
import { SourceBadge } from './parts.tsx'

const CAUSE: Record<ShiftIssue['cause'], string> = {
  'unsized-media': 'unsized media',
  'font-swap': 'font swap',
  'injected-content': 'injected content',
  'dev-artifact': 'dev artifact',
  unknown: 'cause unknown',
}

/** `tag#id`, `tag.class`, or the tag. */
export function nodeName(node: NodeDescriptor | null): string {
  if (node === null) return 'an element that is gone'
  if (node.id !== undefined && node.id !== '') return `${node.tag}#${node.id}`
  const first = node.classes?.[0]
  return first === undefined ? node.tag : `${node.tag}.${first}`
}

const score = (value: number): string => (value >= 0.0995 ? value.toFixed(2) : value.toFixed(3))
const px = (n: number): string => `${Math.round(Math.abs(n))}px`

type Victim = ShiftIssue['victims'][number]

/**
 * A victim that left the viewport (or came into it) has an empty rectangle on one side: its
 * distance is the measured one, a least distance, or not on record. Never read off the empty rectangle.
 */
export function movement(victim: Pick<Victim, 'dx' | 'dy' | 'viewport' | 'distance'>): string {
  const { dx, dy } = victim
  const least = victim.distance === 'at-least' ? 'at least ' : ''
  const parts: string[] = []
  if (Math.abs(dy) >= 0.5) parts.push(`${dy < 0 ? 'up' : 'down'} ${least}${px(dy)}`)
  if (Math.abs(dx) >= 0.5) parts.push(`${dx < 0 ? 'left' : 'right'} ${least}${px(dx)}`)
  const where = victim.viewport === 'out' ? 'out of view' : victim.viewport === 'in' ? 'into view' : ''
  if (victim.distance === 'unknown' || (victim.distance === 'at-least' && parts.length === 0)) return where === '' ? 'moved' : `moved ${where}`
  if (parts.length === 0) return 'resized'
  return where === '' ? parts.join(', ') : `${parts.join(', ')}, ${where}`
}

const visible = (rect: { width: number; height: number }): boolean => rect.width > 0 && rect.height > 0

function findElement(node: NodeDescriptor | null | undefined): Element | undefined {
  if (node === null || node === undefined || node.selector === '') return undefined
  try {
    return document.querySelector(node.selector) ?? undefined
  } catch {
    return undefined
  }
}

/** What to draw on the page for an issue: where each victim was and is, and the culprit. */
export function outlinesOf(issue: ShiftIssue): Outline[] {
  const out: Outline[] = []
  for (const victim of issue.victims.slice(0, 6)) {
    // An empty rectangle is "outside the viewport", not a box at the top-left corner.
    if (visible(victim.previousRect)) out.push({ kind: 'previous', rect: victim.previousRect })
    if (visible(victim.currentRect)) out.push({ kind: 'current', rect: victim.currentRect, label: nodeName(victim.node) })
  }
  if (issue.culprit !== undefined) {
    const element = findElement(issue.culprit.node)
    const label = `culprit: ${nodeName(issue.culprit.node)}`
    if (element !== undefined) out.push({ kind: 'culprit', element, label })
    else if (issue.culprit.rect !== undefined) out.push({ kind: 'culprit', rect: issue.culprit.rect, label })
  }
  return out
}

function IssueRow({ c, issue, state }: { c: Controller; issue: ShiftIssue; state: ShiftState }) {
  const [pinned, setPinned] = useState(false)
  const show = (on: boolean): void => {
    c.store.outlines.value = on ? outlinesOf(issue) : []
  }
  const culprit = issue.culprit
  const source = state.culpritSources[issue.id] ?? null
  const victims = issue.victims.slice(0, 3)
  return (
    <li class="issue" data-issue={issue.id} onMouseEnter={() => show(true)} onMouseLeave={() => show(pinned)}>
      <div class="issue-head">
        <span class="score" title="Layout shift score of this issue">
          {score(issue.value)}
        </span>
        <span class={`chip${issue.cause === 'unknown' ? '' : ' warn'}`}>{CAUSE[issue.cause]}</span>
        <span class="conf" title="How sure the attribution is">
          {Math.round(issue.confidence * 100)}% confident
        </span>
      </div>
      <div class="issue-who">
        <span class="who" title={culprit?.node.selector}>
          {culprit === undefined ? 'no culprit named' : nodeName(culprit.node)}
        </span>
        {culprit === undefined ? null : <SourceBadge loc={source} />}
      </div>
      {issue.evidence.length > 0 ? (
        <ul class="evidence">
          {issue.evidence.slice(0, 4).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {victims.length > 0 ? (
        <div class="victims">
          Moved:{' '}
          {victims.map((victim, index) => (
            <span key={index}>
              {index > 0 ? ', ' : ''}
              <b>{nodeName(victim.node)}</b> {movement(victim)}
            </span>
          ))}
          {issue.victims.length > victims.length ? ` and ${issue.victims.length - victims.length} more` : ''}
        </div>
      ) : null}
      <div class="row">
        <button
          type="button"
          class={`btn${pinned ? ' on' : ''}`}
          aria-pressed={pinned}
          onClick={() => {
            setPinned(!pinned)
            show(!pinned)
          }}
          style="height:22px;margin-left:auto"
        >
          {pinned ? 'Shown on page' : 'Show on page'}
        </button>
      </div>
    </li>
  )
}

function Group({ c, title, issues, state }: { c: Controller; title: string; issues: ShiftIssue[]; state: ShiftState }) {
  if (issues.length === 0) return null
  return (
    <details>
      <summary>
        {title} ({issues.length})
      </summary>
      <ul class="stack">
        {issues.map((issue) => (
          <IssueRow key={issue.id} c={c} issue={issue} state={state} />
        ))}
      </ul>
    </details>
  )
}

export function ShiftsTab({ c }: { c: Controller }) {
  const state = c.store.shifts.value
  const pending = c.store.shiftsPending.value
  if (state === null) {
    return (
      <p class="empty" role="status">
        {window.__reglet === undefined
          ? 'The layout-shift recorder is not on this page.'
          : pending
            ? 'Attributing the layout shifts of this load...'
            : 'Watching this page load. The report appears about 3 seconds after the page has gone quiet.'}
      </p>
    )
  }
  const { report } = state
  if (report.status !== 'ok') {
    return (
      <div class="alert" role="status" data-shift-status={report.status}>
        <b>{report.status === 'tab_hidden' ? 'Not measured: the tab was in the background.' : 'Layout shifts cannot be measured here.'}</b>{' '}
        {report.status === 'tab_hidden'
          ? 'A hidden tab renders no frames, so the browser reports no shifts whatever the page does. Reload with this tab in front to measure.'
          : 'This browser does not report layout shifts, or the recording is unusable. Shifts are measured in Chromium-based browsers.'}
        {report.reason === undefined ? null : <div class="mono" style="margin-top:4px">{report.reason}</div>}
      </div>
    )
  }
  const scored = report.issues.filter((issue) => issue.scored)
  const artifacts = report.issues.filter((issue) => !issue.scored && (issue.excluded === 'dev-artifact' || issue.excluded === 'self-induced' || issue.cause === 'dev-artifact'))
  const afterInput = report.issues.filter((issue) => !issue.scored && !artifacts.includes(issue))
  const cls = report.cls ?? 0
  const rating = cls < 0.1 ? 'good' : cls < 0.25 ? 'mid' : 'poor'
  return (
    <>
      <div class="cls" data-shift-status="ok">
        <span class={`value ${rating}`} title="Cumulative Layout Shift of this load so far (largest session window)">
          {score(cls)}
        </span>
        <span class="muted">
          CLS of this load{scored.length === 0 ? ': no layout shifts.' : `, ${scored.length} ${scored.length === 1 ? 'issue' : 'issues'}`}
        </span>
      </div>
      {report.cachedResources.length > 0 ? (
        <p class="muted" title={report.cachedResources.slice(0, 12).join('\n')}>
          Not a cold load: {report.cachedResources.length} {report.cachedResources.length === 1 ? 'resource' : 'resources'} came from the cache, which can hide shifts.
        </p>
      ) : null}
      {scored.length > 0 ? (
        <ul class="stack" aria-label="Layout shift issues">
          {scored.map((issue) => (
            <IssueRow key={issue.id} c={c} issue={issue} state={state} />
          ))}
        </ul>
      ) : null}
      <Group c={c} title="Dev server artifacts" issues={artifacts} state={state} />
      <Group c={c} title="After user input, not counted" issues={afterInput} state={state} />
      {report.notes.length > 0 ? (
        <ul class="evidence">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
