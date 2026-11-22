/**
 * The Verify tab: every item that has left the dock (sent, claimed by an agent, checked),
 * with whatever verification result the server holds for it. Verification itself runs on the
 * server; this tab only shows it.
 */

import type { ChangeItem, CheckResult, ItemStatus, VerificationStatus } from '@primp/protocol/change'
import type { Controller } from '../state/controller.ts'
import { itemPinStatus, pinGroups } from '../state/pins.ts'
import { IconClose, IconRefresh } from './icons.tsx'
import { ChangeLine, ScopeChips, SourceBadge } from './parts.tsx'

const STATUS: Record<Exclude<ItemStatus, 'draft'>, { text: string; tone: string }> = {
  queued: { text: 'queued', tone: 'info' },
  claimed: { text: 'agent working', tone: 'info' },
  verified: { text: 'verified', tone: 'ok' },
  failed: { text: 'failed', tone: 'bad' },
  dismissed: { text: 'dismissed', tone: '' },
}

const RESULT: Record<VerificationStatus, { text: string; tone: string }> = {
  pass: { text: 'pass', tone: 'ok' },
  drift: { text: 'drift', tone: 'warn' },
  fail: { text: 'fail', tone: 'bad' },
  unresolved: { text: 'element not found', tone: 'warn' },
  no_update_observed: { text: 'no update seen', tone: 'warn' },
  build_error: { text: 'build error', tone: 'bad' },
  not_measurable: { text: 'not measurable', tone: 'warn' },
  tab_hidden: { text: 'tab hidden', tone: 'warn' },
  no_browser: { text: 'no browser', tone: 'warn' },
  not_checkable: { text: 'note: check by eye', tone: '' },
}

function what(check: CheckResult): string {
  const expectation = check.expectation
  switch (expectation.type) {
    case 'computed':
      return expectation.condition.state === undefined ? expectation.property : `${expectation.property} on :${expectation.condition.state}`
    case 'absent':
      return 'removed'
    case 'hidden':
      return 'hidden'
    case 'no-move':
      return `${expectation.label.split(' "')[0]} stays put`
    case 'unchanged':
      return `${expectation.label.split(' "')[0]} keeps its ${expectation.property}`
    case 'order':
      return 'order among its siblings'
  }
}

function Check({ check }: { check: CheckResult }) {
  const tone = RESULT[check.status]
  return (
    <li class="checkrow">
      <span class={`chip ${tone.tone}`}>{tone.text}</span>
      <span>
        {what(check)}
        <div class="detail">
          expected {check.expected === '' ? '(nothing)' : check.expected}
          {check.status === 'pass' ? '' : `, got ${check.actual === '' ? '(nothing)' : check.actual}`}
          {check.delta === undefined || check.status === 'pass' ? '' : ` (off by ${Math.round(check.delta * 100) / 100})`}
        </div>
        {check.note === undefined ? null : <div class="muted">{check.note}</div>}
      </span>
    </li>
  )
}

function VerifyItem({ c, item, number }: { c: Controller; item: ChangeItem; number: number | undefined }) {
  const status = STATUS[item.status as Exclude<ItemStatus, 'draft'>]
  const result = item.verification
  return (
    <li class="item" data-item={item.id}>
      <div class="item-head">
        {number === undefined ? null : (
          <span class="num" data-pin-status={itemPinStatus(item)}>
            {number}
          </span>
        )}
        <span class="label" title={item.target.selector}>
          {item.target.label}
        </span>
        <SourceBadge loc={item.target.source} />
        <span class={`chip ${status.tone}`} data-status={item.status}>
          {status.text}
        </span>
      </div>
      <ChangeLine item={item} />
      <div class="chips">
        <ScopeChips item={item} />
        {item.page === location.pathname + location.search ? null : <span class="chip">on {item.page}</span>}
      </div>
      {item.status === 'dismissed' && item.dismissReason !== undefined ? <div class="muted">Dismissed: {item.dismissReason}</div> : null}
      {result === undefined ? null : (
        <>
          <div class="row wrap">
            <span class={`chip ${RESULT[result.status].tone}`}>{RESULT[result.status].text}</span>
            <span class="muted">
              attempt {result.attempt}
              {result.settle === undefined ? '' : `, page settled by ${result.settle.signal} in ${Math.round(result.settle.ms)} ms`}
            </span>
          </div>
          {result.hint === '' ? null : <div>{result.hint}</div>}
          {result.checks.length > 0 ? (
            <ul class="checks" aria-label="Checks">
              {result.checks.map((check, index) => (
                <Check key={index} check={check} />
              ))}
            </ul>
          ) : null}
        </>
      )}
      {item.status === 'dismissed' ? null : (
        <div class="row">
          <button type="button" class="btn sm quiet" style="margin-left:auto" onClick={() => c.reverify([item.id])}>
            Check again
          </button>
        </div>
      )}
    </li>
  )
}

export function VerifyTab({ c }: { c: Controller }) {
  const items = c.store.items.value.filter((item) => item.status !== 'draft')
  if (items.length === 0) {
    return <p class="empty">Nothing sent yet. After you send changes, each one is listed here; once your agent has edited the source, primp re-measures the page and shows the result per change.</p>
  }
  const numbers = new Map(pinGroups(c.store.items.value, location.pathname + location.search).map((group) => [group.uid, group.number]))
  return (
    <ul class="stack" aria-label="Sent changes">
      {[...items].reverse().map((item) => (
        <VerifyItem key={item.id} c={c} item={item} number={item.page === location.pathname + location.search ? numbers.get(item.target.uid) : undefined} />
      ))}
    </ul>
  )
}

export function VerifyPanel({ c, onClose }: { c: Controller; onClose(): void }) {
  const sent = c.store.items.value.filter((item) => item.status !== 'draft' && item.status !== 'dismissed')
  return (
    <div class="pop" role="dialog" aria-label="Verification">
      <header class="pop-head">
        <div class="title-row">
          <h2 class="grow">
            Verification <span class="count">{sent.length}</span>
          </h2>
          <button type="button" class="iconbtn" aria-label="Close the verification" title="Close (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>
      <div class="pop-body" id="panel">
        <VerifyTab c={c} />
      </div>
      <footer class="pop-foot foot">
        <span class="hint grow">Results appear after your agent edits the source.</span>
        <button type="button" class="btn sm" disabled={sent.length === 0} onClick={() => c.reverify(sent.map((item) => item.id))}>
          <IconRefresh size={14} />
          Check all again
        </button>
      </footer>
    </div>
  )
}
