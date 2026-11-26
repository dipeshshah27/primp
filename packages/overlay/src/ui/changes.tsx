/**
 * The recorded changes: one item with what else it moved (side effects, with "unwanted" to make
 * a must-not-move constraint of one) and the rule it shares with other elements; and the Changes
 * panel, every draft of this page numbered like its pin, with Copy and Send.
 */

import type { ChangeItem, SideEffect } from '@primp/protocol/change'
import { useState } from 'preact/hooks'
import { describeEffect, sameEffects, summarizeRecorded } from '../probe/effects.ts'
import { summaryKey, type Controller } from '../state/controller.ts'
import { pinGroups } from '../state/pins.ts'
import { IconClose, IconCopy, IconRedo, IconSend, IconUndo } from './icons.tsx'
import { NoteBox } from './inspector.tsx'
import { ChangeLine, ScopeChips, SourceBadge } from './parts.tsx'

function Effects({ c, item }: { c: Controller; item: ChangeItem }) {
  const show = (effect: SideEffect | null): void => {
    c.store.outlines.value =
      effect === null
        ? []
        : [
            { kind: 'previous', space: 'document', rect: { x: effect.before.x, y: effect.before.y, width: effect.before.w, height: effect.before.h } },
            { kind: 'current', space: 'document', rect: { x: effect.after.x, y: effect.after.y, width: effect.after.w, height: effect.after.h }, label: effect.label.split(' "')[0] ?? '' },
          ]
  }
  return (
    <ul class="effects" aria-label="Side effects of this change">
      {item.sideEffects.map((effect, index) => (
        <li key={`${effect.selector}|${effect.type}`} class="effect" onMouseEnter={() => show(effect)} onMouseLeave={() => show(null)}>
          <span class="what" title={`${effect.label}\n${effect.selector}`}>
            <span class="who">
              <b>{effect.label.split(' "')[0]}</b>
              {effect.label.includes(' "') ? ` "${effect.label.slice(effect.label.indexOf(' "') + 2)}` : ''}
            </span>
            <span class="how">
              {describeEffect(effect)}
              {effect.subtreeCount > 0 ? `, with ${effect.subtreeCount} inside` : ''}
            </span>
          </span>
          <label class="check" title="Tell the agent this element must stay where it was">
            <input
              type="checkbox"
              checked={effect.verdict === 'unwanted'}
              onChange={(event) => c.setVerdict(item.id, index, (event.currentTarget as HTMLInputElement).checked ? 'unwanted' : 'unreviewed')}
            />
            unwanted
          </label>
        </li>
      ))}
    </ul>
  )
}

/** One recorded change. `withTarget`: also name the element (in lists of several elements). */
export function TrayItem({ c, item, withTarget = false, effectsAbove = false }: { c: Controller; item: ChangeItem; withTarget?: boolean; effectsAbove?: boolean }) {
  const [open, setOpen] = useState(false)
  const detached = c.store.detached.value.has(item.id)
  const summary = c.store.summaries.value.get(summaryKey(item)) ?? summarizeRecorded(item.sideEffects)
  const unwanted = item.sideEffects.filter((effect) => effect.verdict === 'unwanted').length
  const has = item.sideEffects.length > 0
  // How many elements outside this change the rule behind the old value styles too; the agent is told to leave them alone.
  const origin = item.kind === 'style' ? item.origin : undefined
  const shared = origin?.alsoStyles ?? 0
  const bystanders = item.kind === 'style' ? (item.bystanders ?? []) : []
  const what = item.kind === 'note' ? 'note' : 'change'
  return (
    <li class={`item${detached ? ' detached' : ''}`} data-item={item.id}>
      {withTarget ? (
        <div class="item-head">
          <span class="label" title={item.target.selector}>
            {item.target.label}
          </span>
          <SourceBadge loc={item.target.source} />
        </div>
      ) : null}
      <div class="item-head">
        <ChangeLine item={item} />
        <button type="button" class="iconbtn" aria-label={`Delete the ${what} to ${item.target.label}`} title={`Delete this ${what}`} onClick={() => c.deleteItem(item.id)}>
          <IconClose size={14} />
        </button>
      </div>
      {shared > 0 ? (
        <div
          class="shared"
          title={`Not part of this change: the agent is told to leave them as they are. Measured again after the source is edited:\n${bystanders.map((bystander) => bystander.label).join('\n')}${shared > bystanders.length ? `\nand ${shared - bystanders.length} more, which are not measured` : ''}`}
        >
          rule {origin?.selector ?? ''} also styles {shared} other {shared === 1 ? 'element' : 'elements'}
        </div>
      ) : null}
      {item.kind === 'note' ? null : (
        <div class="chips">
          <ScopeChips item={item} />
          {detached ? (
            <span class="chip warn" title="The page re-rendered and this element could not be found again. The change is kept and will be sent; its preview is off.">
              element not found on the page
            </span>
          ) : null}
          {has && effectsAbove ? (
            <span class="chip" title="This change is part of one gesture with the change above (a corner resize sets the width and the height): its side effects are the same, and so is what you marked unwanted.">
              same side effects as above
            </span>
          ) : has ? (
            <button type="button" class={`chip${unwanted > 0 ? ' bad' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} title="What else changed on the page because of this edit">
              <span>
                {summary}
                {unwanted > 0 ? ` (${unwanted} unwanted)` : ''}
                {item.sideEffectsPartial === true ? ' (large page: partly checked)' : ''}
              </span>
              <span class="caret" aria-hidden="true" />
            </button>
          ) : (
            <span class="chip">{item.sideEffectsPartial === true ? `${summary} (large page: partly checked)` : summary}</span>
          )}
        </div>
      )}
      {open && has && !effectsAbove ? <Effects c={c} item={item} /> : null}
      {item.kind === 'note' ? null : (
        <input
          class="input note"
          type="text"
          aria-label={`Note for the agent about the change to ${item.target.label}`}
          placeholder="Comment for the agent (optional)"
          value={item.note ?? ''}
          onChange={(event) => c.setNote(item.id, (event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur()
          }}
        />
      )}
    </li>
  )
}

function SentNotice({ c }: { c: Controller }) {
  const sent = c.store.sent.value
  const [copied, setCopied] = useState(false)
  if (sent === null) return null
  const dismiss = (
    <button type="button" class="btn sm quiet" onClick={() => (c.store.sent.value = null)}>
      Dismiss
    </button>
  )
  if (sent.toAgent === true && sent.note === undefined) {
    return (
      <div class="notice" role="status">
        <div class="row">
          <span>
            Your agent was waiting and has {sent.count === 1 ? 'the change' : `the ${sent.count} changes`} now. The results show in Verification once it has edited the source.
          </span>
          {dismiss}
        </div>
      </div>
    )
  }
  if (sent.copied) {
    return (
      <div class="notice" role="status">
        <div class="row">
          <span>{sent.note ?? 'Copied. Paste into your agent, or it will pick the batch up over MCP. Your previews left the page, so your agent\'s edit shows as your source makes it; Verification can show what you asked.'}</span>
          {dismiss}
        </div>
      </div>
    )
  }
  return (
    <div class="notice plain" role="status">
      <span>
        {sent.note ?? `${sent.count} ${sent.count === 1 ? 'change is' : 'changes are'} queued for your agent over MCP.`} The browser did not allow copying; copy the prompt from here to paste it instead.
      </span>
      <textarea class="prompt" readOnly aria-label="Prompt for your agent" value={sent.prompt} onFocus={(event) => (event.currentTarget as HTMLTextAreaElement).select()} />
      <div class="row">
        <button
          type="button"
          class="btn sm"
          onClick={async () => {
            setCopied(await c.copy(sent.prompt))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {dismiss}
      </div>
    </div>
  )
}

export function ChangesPanel({ c, onClose }: { c: Controller; onClose(): void }) {
  const { store } = c
  const page = c.store.route.value
  const drafts = store.drafts.value
  const all = store.allDrafts.value
  const elsewhere = all.length - drafts.length
  const sending = store.sending.value
  const groups = pinGroups(store.items.value, page)
    .map((group) => ({ ...group, items: group.items.filter((item) => item.status === 'draft') }))
    .filter((group) => group.items.length > 0)
  const count = all.length
  return (
    <div class="pop" role="dialog" aria-label="Changes">
      <header class="pop-head">
        <div class="title-row">
          <h2 class="grow">
            Changes <span class="count">{drafts.length}</span>
          </h2>
          <button type="button" class="iconbtn" aria-label="Close the changes" title="Close (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>
      <div class="pop-body" id="panel">
        <SentNotice c={c} />
        {groups.length === 0 && drafts.length === 0 ? (
          <p class="empty">Nothing recorded on this page yet. Click any element to edit it; every change gets a numbered pin and is listed here with what else it moved.</p>
        ) : null}
        <div class="tray">
          {groups.map((group) => (
            <section key={group.uid} class="target-group" data-pin={group.number} aria-label={`${group.number}: ${group.target.label}`}>
              <div class="tg-head">
                <span class="num" data-pin-status={group.status}>
                  {group.number}
                </span>
                <button
                  type="button"
                  class="label"
                  title={`Select ${group.target.label}`}
                  onClick={() => {
                    const first = group.items[0]
                    const element = first === undefined ? null : c.elementOf(first)
                    if (element !== null) {
                      c.select(element)
                      store.panel.value = 'inspector'
                    }
                  }}
                >
                  {group.target.label}
                </button>
                <SourceBadge loc={group.target.source} />
              </div>
              <ul class="tray">
                {group.items.map((item, index) => (
                  <TrayItem key={item.id} c={c} item={item} effectsAbove={index > 0 && sameEffects(group.items[index - 1]!.sideEffects, item.sideEffects)} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        {elsewhere > 0 ? <p class="hint">{elsewhere} more on other pages; Send sends them too.</p> : null}
        <NoteBox c={c} on="page" label="Note on the whole page" />
      </div>
      <footer class="pop-foot foot">
        <button type="button" class="iconbtn" disabled={!store.canUndo.value} onClick={() => c.undo()} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)">
          <IconUndo />
        </button>
        <button type="button" class="iconbtn" disabled={!store.canRedo.value} onClick={() => c.redo()} aria-label="Redo" title="Redo (Shift+Ctrl/Cmd+Z)">
          <IconRedo />
        </button>
        <span class="grow" />
        <button type="button" class="btn sm" disabled={count === 0} onClick={() => void c.copyPrompt()} title="Copy the prompt without sending (C)">
          <IconCopy size={14} />
          Copy
        </button>
        <button type="button" class="btn sm primary" disabled={count === 0 || sending} onClick={() => void c.send().catch(() => undefined)} title="Queue these changes for your agent and copy the prompt (S)">
          <IconSend size={14} />
          {sending ? 'Sending…' : `Send ${count} ${count === 1 ? 'change' : 'changes'}`}
        </button>
      </footer>
    </div>
  )
}
