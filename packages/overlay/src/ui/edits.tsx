/**
 * The Edits tab: pick an element, change its styles, hide, remove or move it, and review the
 * tray of recorded changes with their side effects. (Resizing and dragging to another position
 * are done on the page, with the handles on the selection: handles.ts.)
 */

import type { ChangeItem, ElementState, SideEffect } from '@primp/protocol/change'
import { useEffect, useRef, useState } from 'preact/hooks'
import { describeEffect, summarizeRecorded } from '../probe/effects.ts'
import { computedValue, suggestProperties, supportedProperties } from '../probe/properties.ts'
import { ELEMENT_STATES } from '../probe/specificity.ts'
import { customPropertiesOf, declaredIn, draftShowsIn, mediaOf, type DeclaredProperty } from '../probe/styles.ts'
import { summaryKey, type Controller } from '../state/controller.ts'
import type { Selection } from '../state/store.ts'
import { nudge } from './nudge.ts'
import { ChangeLine, ScopeChips, SourceBadge } from './parts.tsx'

/** Computed properties shown for every element, whether a rule declares them or not. */
const COMMON = [
  'display',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'line-height',
  'border',
  'border-radius',
  'gap',
]

interface Row {
  property: string
  value: string
  /** Where the value comes from, for the tooltip. */
  from: string
  edited: boolean
}

/** The rows one rule (or the style attribute) contributes, under the rule's selector. */
interface RuleGroup {
  key: string
  /** Selector of the rule, as secondary text above its properties. */
  title: string
  /** `@media` query and stylesheet, when known. */
  detail: string
  rows: Row[]
}

// ---------------------------------------------------------------------------
// One editable value
// ---------------------------------------------------------------------------

function PropertyRow({ c, row }: { c: Controller; row: Row }) {
  const [text, setText] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  const dirty = useRef(false)
  const input = useRef<HTMLInputElement>(null)

  // The recorded value changed (an edit, an undo, another element): show it, unless the user is typing.
  useEffect(() => {
    if (!dirty.current) setText(row.value)
  }, [row.value])

  const apply = async (next: string, keep?: { start: number; end: number }): Promise<void> => {
    const value = next.trim()
    if (value === '' || value === row.value) {
      dirty.current = false
      setText(row.value)
      setError(null)
      return
    }
    const result = await c.setStyle(row.property, value)
    if (result.ok) {
      dirty.current = false
      setError(null)
      if (keep !== undefined) input.current?.setSelectionRange(keep.start, keep.end)
    } else {
      setError(result.error)
      c.store.error.value = null
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void apply(text)
    } else if (event.key === 'Escape') {
      // Cancels the edit; the Escape is used up and does not also leave pick mode.
      event.preventDefault()
      dirty.current = false
      setText(row.value)
      setError(null)
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const field = event.currentTarget as HTMLInputElement
      const step = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1)
      const nudged = nudge(field.value, field.selectionStart ?? field.value.length, step)
      if (nudged === null) return
      event.preventDefault()
      dirty.current = true
      setText(nudged.text)
      void apply(nudged.text, nudged)
    }
  }

  const id = `v-${row.property}`
  return (
    <div class={`prop${row.edited ? ' edited' : ''}`}>
      <label class="name" for={id} title={`${row.property}\n${row.from}`}>
        {row.property}
      </label>
      <input
        ref={input}
        id={id}
        type="text"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        value={text}
        placeholder={row.value === '' ? 'not set' : undefined}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? `${id}-msg` : undefined}
        data-dirty={dirty.current ? '1' : undefined}
        onInput={(event) => {
          dirty.current = true
          setText((event.currentTarget as HTMLInputElement).value)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (dirty.current) void apply(text)
        }}
      />
      {error !== null ? (
        <div class="msg" id={`${id}-msg`} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add any property
// ---------------------------------------------------------------------------

function AddProperty({ c, custom }: { c: Controller; custom: string[] }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const valueInput = useRef<HTMLInputElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const options = open ? suggestProperties(name, custom, 10) : []
  const shown = options.length > 0 && !(options.length === 1 && options[0] === name.trim())

  const choose = (property: string): void => {
    setName(property)
    setOpen(false)
    valueInput.current?.focus()
  }

  const add = async (): Promise<void> => {
    if (name.trim() === '') {
      nameInput.current?.focus()
      return
    }
    const result = await c.setStyle(name, value)
    if (result.ok) {
      setName('')
      setValue('')
      setError(null)
      nameInput.current?.focus()
    } else {
      setError(result.error)
      c.store.error.value = null
    }
  }

  const onNameKey = (event: KeyboardEvent): void => {
    if (shown && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setActive((active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
    } else if (event.key === 'Enter' || (event.key === 'Tab' && shown && !event.shiftKey)) {
      const picked = shown ? options[Math.min(active, options.length - 1)] : undefined
      if (picked !== undefined) {
        event.preventDefault()
        choose(picked)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        valueInput.current?.focus()
      }
    } else if (event.key === 'Escape' && shown) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div>
      <div class="add">
        <input
          ref={nameInput}
          class="input"
          type="text"
          role="combobox"
          aria-label="Property to add"
          aria-expanded={shown}
          aria-controls="add-suggest"
          aria-autocomplete="list"
          aria-activedescendant={shown ? `add-opt-${Math.min(active, options.length - 1)}` : undefined}
          placeholder="Add property"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          value={name}
          onInput={(event) => {
            setName((event.currentTarget as HTMLInputElement).value)
            setOpen(true)
            setActive(0)
            setError(null)
          }}
          onKeyDown={onNameKey}
          onBlur={() => setOpen(false)}
        />
        <input
          ref={valueInput}
          class="input"
          type="text"
          aria-label="Value of the property to add"
          placeholder="value"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          value={value}
          aria-invalid={error !== null}
          onInput={(event) => {
            setValue((event.currentTarget as HTMLInputElement).value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void add()
            }
          }}
        />
        <button type="button" class="btn" onClick={() => void add()}>
          Add
        </button>
        {shown ? (
          <ul class="suggest" id="add-suggest" role="listbox" aria-label="Matching properties">
            {options.map((option, index) => (
              <li
                key={option}
                id={`add-opt-${index}`}
                role="option"
                aria-selected={index === Math.min(active, options.length - 1)}
                // Before the input's blur closes the list.
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(option)
                }}
              >
                {option}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {error !== null ? (
        <div class="prop">
          <div class="msg" role="alert">
            {error}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The selected element
// ---------------------------------------------------------------------------

const describeOrigin = (entry: DeclaredProperty): string => {
  if (entry.from === 'inline' || entry.rule === undefined) return `style attribute${entry.important ? ' !important' : ''}`
  const media = mediaOf(entry.rule)
  return `${entry.rule.matched}${media === undefined ? '' : ` @media ${media}`}${entry.important ? ' !important' : ''}`
}

/** A rule that names a class, an id or an attribute is the author's; type and universal selectors are base styles. */
const isBase = (entry: DeclaredProperty): boolean => entry.rule !== undefined && entry.rule.specificity[0] === 0 && entry.rule.specificity[1] === 0

const sheetName = (sheet: string | undefined): string => {
  if (sheet === undefined) return ''
  const path = sheet.split(/[?#]/, 1)[0] ?? sheet
  return path.slice(path.lastIndexOf('/') + 1)
}

function buildRows(
  selection: Selection,
  drafts: readonly ChangeItem[],
  media: string | null,
  scope: string,
  state: ElementState | null,
): { declared: RuleGroup[]; base: Row[]; computed: Row[] } {
  const mine = drafts.filter((item) => item.kind === 'style' && item.target.uid === selection.ref.uid)
  const editOf = (property: string, ruleStates: readonly ElementState[] = []): string | undefined => {
    let found: string | undefined
    let through: string | undefined
    for (const item of mine) {
      if (item.kind !== 'style' || item.property !== property) continue
      const shows = draftShowsIn(item.condition.state ?? null, state, ruleStates)
      if (shows === 'exact') {
        // The draft for the state, scope and media the controls are set to is the one a new edit would update.
        if ((item.condition.media ?? null) === media && item.scope === scope) return item.after.authored
        found ??= item.after.authored
      } else if (shows === 'through') through ??= item.after.authored
    }
    return found ?? through
  }
  const seen = new Set<string>()
  const declared: RuleGroup[] = []
  const base: Row[] = []
  for (const entry of declaredIn(selection.styles, state)) {
    seen.add(entry.property)
    const edit = editOf(entry.property, entry.rule?.states)
    const row: Row = { property: entry.property, value: edit ?? entry.value, from: describeOrigin(entry), edited: edit !== undefined }
    if (isBase(entry) && edit === undefined) {
      base.push(row)
      continue
    }
    const rule = entry.rule
    // A rule that is listed once per state it is reached through (`.a:hover, .a:focus`) has one `order`.
    const key = rule === undefined ? 'inline' : `rule-${rule.order}-${rule.states.join('+')}`
    let group = declared.find((known) => known.key === key)
    if (group === undefined) {
      const query = rule === undefined ? undefined : mediaOf(rule)
      group = {
        key,
        title: rule === undefined ? 'style attribute' : rule.matched,
        detail: [query === undefined ? '' : `@media ${query}`, sheetName(rule?.sheet)].filter((part) => part !== '').join('  '),
        rows: [],
      }
      declared.push(group)
    }
    group.rows.push(row)
  }
  // Properties added in the dock that no rule declares.
  const added: Row[] = []
  for (const item of mine) {
    if (item.kind !== 'style' || seen.has(item.property) || COMMON.includes(item.property)) continue
    const value = editOf(item.property)
    if (value === undefined) continue
    seen.add(item.property)
    added.push({ property: item.property, value, from: 'added here', edited: true })
  }
  if (added.length > 0) declared.unshift({ key: 'added', title: 'added here', detail: '', rows: added })
  const style = getComputedStyle(selection.element)
  const computed: Row[] = []
  for (const property of COMMON) {
    if (seen.has(property)) continue
    const edit = editOf(property)
    computed.push({ property, value: edit ?? computedValue(selection.element, property, style), from: edit === undefined ? 'computed' : 'edited here', edited: edit !== undefined })
  }
  return { declared, base, computed }
}

const STATE_HELP: Record<ElementState, string> = {
  hover: 'as while the pointer is over it',
  focus: 'as while it has the focus',
  'focus-visible': 'as while it has the focus and the browser shows a focus ring (keyboard focus)',
  active: 'as while it is being pressed',
}

/** Rest / :hover / :focus / :focus-visible / :active. A dot marks the states the page has rules for on this element. */
function StateControl({ c, selection, state }: { c: Controller; selection: Selection; state: ElementState | null }) {
  const withRules = selection.styles.states
  return (
    <div class="field">
      <span id="state-label">State</span>
      <div class="seg states" role="group" aria-labelledby="state-label">
        <button type="button" aria-pressed={state === null} title="The element as it is at rest" onClick={() => c.setState(null)}>
          Rest
        </button>
        {ELEMENT_STATES.map((name) => {
          const has = withRules.includes(name)
          return (
            <button
              key={name}
              type="button"
              class={`pseudo${has ? ' has' : ''}`}
              aria-pressed={state === name}
              data-state={name}
              title={`Show and edit the element ${STATE_HELP[name]}.${has ? '\nThe page has rules for this element in this state.' : '\nNo rule of the page styles this element in this state yet.'}`}
              onClick={() => c.setState(state === name ? null : name)}
            >
              :{name}
              {has ? <span class="sr">, has rules</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Move earlier / Move later: the keyboard path to reordering (the grip on the page is the pointer's). */
function MoveButtons({ c, selection }: { c: Controller; selection: Selection }) {
  const refusal = c.reorderRefusal()
  const position = selection.position
  const first = position === null || position.index === 0
  const last = position === null || position.index === position.count - 1
  const where = position === null ? '' : `Position ${position.index + 1} of ${position.count} among its siblings.`
  return (
    <div class="seg" role="group" aria-label="Move among siblings">
      <button
        type="button"
        disabled={refusal !== null || first}
        title={refusal ?? (first ? `${where} Already the first.` : `${where} Move it one place earlier.`)}
        onClick={() => void c.move(-1)}
      >
        Move earlier
      </button>
      <button
        type="button"
        disabled={refusal !== null || last}
        title={refusal ?? (last ? `${where} Already the last.` : `${where} Move it one place later.`)}
        onClick={() => void c.move(1)}
      >
        Move later
      </button>
    </div>
  )
}

function SelectionPanel({ c, selection }: { c: Controller; selection: Selection }) {
  const { store } = c
  const source = store.source.value
  const media = store.media.value
  const scope = store.scope.value
  const state = store.state.value
  const rows = buildRows(selection, store.drafts.value, media, scope, state)
  const custom = customPropertiesOf(selection.styles)
  const options = selection.styles.media

  return (
    <section class="panel" aria-label="Selected element">
      <div>
        <nav class="crumbs" aria-label="Ancestors of the selected element">
          {selection.crumbs.map((crumb, index) => {
            const current = index === selection.crumbs.length - 1
            return (
              <>
                {index > 0 ? <span aria-hidden="true">{'\u203a'}</span> : null}
                <button type="button" class="crumb" aria-current={current ? 'true' : undefined} title={current ? 'Selected' : 'Select this ancestor'} onClick={() => c.select(crumb.element)}>
                  {crumb.label}
                </button>
              </>
            )
          })}
          {selection.hasChild ? (
            <>
              <span aria-hidden="true">{'\u203a'}</span>
              <button type="button" class="crumb" title="Select the first child" onClick={() => c.navigate('ArrowDown')}>
                child
              </button>
            </>
          ) : null}
        </nav>
        <div class="target" style="margin-top:6px">
          <span class="label" title={selection.ref.selector}>
            {selection.ref.label}
          </span>
          <SourceBadge loc={source?.loc ?? null} state={source?.state} />
        </div>
        {state === null ? null : (
          // Its own line, so the label keeps its width: this is what the page shows and what new edits are for.
          <div class="showing-line" role="status" title={`The element is shown ${STATE_HELP[state]}, without the pointer or the focus being there. Edits made now are recorded for :${state} only. Choose Rest to go back.`}>
            <span class="chip info showing">
              showing <b>:{state}</b>
            </span>
            <span class="hint">new edits apply to :{state} only</span>
          </div>
        )}
      </div>

      <div class="controls">
        <div class="row" style="align-items:flex-end">
          {selection.instances > 1 ? (
            <div class="field" style="flex:none">
              <span id="scope-label">Apply to</span>
              <div class="seg" role="group" aria-labelledby="scope-label">
                <button type="button" aria-pressed={scope === 'instance'} onClick={() => (store.scope.value = 'instance')}>
                  This element
                </button>
                <button type="button" aria-pressed={scope === 'all-instances'} onClick={() => (store.scope.value = 'all-instances')}>
                  All {selection.instances}
                </button>
              </div>
            </div>
          ) : null}
          <label class="field">
            <span>Media query</span>
            <select value={media ?? ''} onChange={(event) => (store.media.value = (event.currentTarget as HTMLSelectElement).value || null)}>
              <option value="">No media query</option>
              {options.map((option) => (
                <option key={option.query} value={option.query} disabled={!option.matches}>
                  @media {option.query}
                  {option.matches ? '' : ' (not at this size)'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <StateControl c={c} selection={selection} state={state} />
      </div>

      <div>
        <div class="props" role="group" aria-label="Declared properties">
          {rows.declared.length === 0 ? <p class="muted">No rule of the page sets a property on this element by class or id.</p> : null}
          {rows.declared.map((group) => (
            <div key={group.key} class="rule" role="group" aria-label={`Properties from ${group.title}`}>
              <div class="rule-head">
                <span class="sel" title={group.title}>
                  {group.title}
                </span>
                {group.detail === '' ? null : (
                  <span class="where" title={group.detail}>
                    {group.detail}
                  </span>
                )}
              </div>
              {group.rows.map((row) => (
                <PropertyRow key={row.property} c={c} row={row} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div>
        <div class="section-title" style="margin-bottom:4px">
          Computed
        </div>
        <div class="props" role="group" aria-label="Computed properties">
          {rows.computed.map((row) => (
            <PropertyRow key={row.property} c={c} row={row} />
          ))}
        </div>
        {rows.base.length > 0 ? (
          <details style="margin-top:6px">
            <summary>Base styles ({rows.base.length})</summary>
            <div class="props" role="group" aria-label="Properties from base styles">
              {rows.base.map((row) => (
                <PropertyRow key={row.property} c={c} row={row} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <AddProperty c={c} custom={custom} />
      <div class="row wrap">
        <MoveButtons c={c} selection={selection} />
        <button type="button" class="btn danger" onClick={() => void c.structural('hide')} title="Keep the element in the DOM but do not display it">
          Hide
        </button>
        <button type="button" class="btn danger" onClick={() => void c.structural('remove')} title="Ask the agent to delete the element from the source">
          Remove
        </button>
        <span class="hint" style="margin-left:auto">
          {selection.styles.system === 'unknown' ? '' : selection.styles.system}
        </span>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The tray
// ---------------------------------------------------------------------------

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

function TrayItem({ c, item }: { c: Controller; item: ChangeItem }) {
  const [open, setOpen] = useState(false)
  const detached = c.store.detached.value.has(item.id)
  const summary = c.store.summaries.value.get(summaryKey(item)) ?? summarizeRecorded(item.sideEffects)
  const unwanted = item.sideEffects.filter((effect) => effect.verdict === 'unwanted').length
  const has = item.sideEffects.length > 0
  // How many elements outside this change the rule behind the old value styles too; the agent is told to leave them alone.
  const origin = item.kind === 'style' ? item.origin : undefined
  const shared = origin?.alsoStyles ?? 0
  const bystanders = item.kind === 'style' ? (item.bystanders ?? []) : []
  return (
    <li class={`item${detached ? ' detached' : ''}`} data-item={item.id}>
      <div class="item-head">
        <span class="label" title={item.target.selector}>
          {item.target.label}
        </span>
        <SourceBadge loc={item.target.source} />
        <button type="button" class="iconbtn" aria-label={`Delete the change to ${item.target.label}`} title="Delete this change" onClick={() => c.deleteItem(item.id)}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
      <ChangeLine item={item} />
      {shared > 0 ? (
        <div
          class="shared"
          title={`Not part of this change: the agent is told to leave them as they are. Measured again after the source is edited:\n${bystanders.map((bystander) => bystander.label).join('\n')}${shared > bystanders.length ? `\nand ${shared - bystanders.length} more, which are not measured` : ''}`}
        >
          rule {origin?.selector ?? ''} also styles {shared} other {shared === 1 ? 'element' : 'elements'}
        </div>
      ) : null}
      <div class="chips">
        <ScopeChips item={item} />
        {detached ? (
          <span class="chip warn" title="The page re-rendered and this element could not be found again. The change is kept and will be sent; its preview is off.">
            element not found on the page
          </span>
        ) : null}
        {has ? (
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
      {open && has ? <Effects c={c} item={item} /> : null}
      <input
        class="input note"
        type="text"
        aria-label={`Note for the agent about the change to ${item.target.label}`}
        placeholder="Note for the agent (optional)"
        value={item.note ?? ''}
        onChange={(event) => c.setNote(item.id, (event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur()
        }}
      />
    </li>
  )
}

function SentNotice({ c }: { c: Controller }) {
  const sent = c.store.sent.value
  const [copied, setCopied] = useState(false)
  if (sent === null) return null
  const dismiss = (
    <button type="button" class="btn quiet" onClick={() => (c.store.sent.value = null)}>
      Dismiss
    </button>
  )
  if (sent.copied) {
    return (
      <div class="notice" role="status">
        <div class="row">
          <span>Copied. Paste into your agent, or it will pick the batch up over MCP.</span>
          {dismiss}
        </div>
      </div>
    )
  }
  return (
    <div class="notice plain" role="status">
      <span>
        {sent.count} {sent.count === 1 ? 'change is' : 'changes are'} queued for your agent over MCP. The browser did not allow copying; copy the prompt from here to paste it instead.
      </span>
      <textarea class="prompt" readOnly aria-label="Prompt for your agent" value={sent.prompt} onFocus={(event) => (event.currentTarget as HTMLTextAreaElement).select()} />
      <div class="row">
        <button
          type="button"
          class="btn"
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

export function EditsTab({ c }: { c: Controller }) {
  const { store } = c
  const pick = store.pickMode.value
  const selection = store.selection.value
  const drafts = store.drafts.value
  const elsewhere = store.allDrafts.value.length - drafts.length
  const error = store.error.value
  // Building the list of every supported property takes a few milliseconds; do it before it is typed into.
  useEffect(() => void supportedProperties(), [])

  return (
    <>
      <SentNotice c={c} />
      <div class="row">
        <button type="button" class={`btn${pick ? ' on' : ''}`} aria-pressed={pick} onClick={() => c.setPickMode(!pick)}>
          {pick ? 'Picking...' : 'Pick element'}
        </button>
        <span class="hint">{pick ? 'Click an element on the page. Esc stops.' : selection === null ? 'Then edit its styles here.' : ''}</span>
      </div>
      {error !== null ? (
        <div class="alert" role="alert">
          {error}
        </div>
      ) : null}
      {selection !== null ? <SelectionPanel c={c} selection={selection} /> : null}
      <section class="tray" aria-label="Changes on this page">
        <div class="section-title">
          Changes on this page ({drafts.length}){elsewhere > 0 ? `, ${elsewhere} on other pages` : ''}
        </div>
        {drafts.length === 0 ? (
          <p class="empty">Nothing recorded yet. Every edit you make appears here with what else it moved.</p>
        ) : (
          <ul class="tray">
            {drafts.map((item) => (
              <TrayItem key={item.id} c={c} item={item} />
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
