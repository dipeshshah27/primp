/**
 * The inspector: the popover next to the selected element. Header (ancestors, name, source),
 * one compact scope row (state, media query, apply to), design-tool groups (layout, spacing,
 * size, typography, fill and border, visibility, order), every declared rule under "All CSS",
 * this element's recorded changes with their side effects, and a note for the agent.
 *
 * Every control edits through the controller (`setStyle`, `structural`, `move`, `addNote`...),
 * the same code the test handle calls. A refusal is shown at the control that caused it and is
 * gone with the next edit; nothing is shown as a banner.
 */

import type { ChangeItem, ElementState } from '@primp/protocol/change'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { computedValue, suggestProperties, supportedProperties } from '../probe/properties.ts'
import { ELEMENT_STATES } from '../probe/specificity.ts'
import { customPropertiesOf, declaredIn, draftShowsIn, mediaOf, type DeclaredProperty } from '../probe/styles.ts'
import type { Controller } from '../state/controller.ts'
import type { Selection } from '../state/store.ts'
import { TrayItem } from './changes.tsx'
import { BoxModel, ColorField, Field, IconSeg, SelectField, useValueEdit, type ValueOf } from './fields.tsx'
import {
  IconAlignCenter,
  IconAlignJustify,
  IconAlignLeft,
  IconAlignRight,
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconChevron,
  IconClose,
  IconHide,
  IconRedo,
  IconRemove,
  IconUndo,
} from './icons.tsx'
import { SourceBadge } from './parts.tsx'

/** Computed properties listed under "All CSS" for every element, whether a rule declares them or not. */
const COMMON = ['display', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'gap']

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
  title: string
  detail: string
  rows: Row[]
}

// ---------------------------------------------------------------------------
// Values: the recorded edit for the current state, media and scope, else what the element has
// ---------------------------------------------------------------------------

function editFinder(selection: Selection, drafts: readonly ChangeItem[], media: string | null, scope: string, state: ElementState | null) {
  const mine = drafts.filter((item) => item.kind === 'style' && item.target.uid === selection.ref.uid)
  return (property: string, ruleStates: readonly ElementState[] = []): string | undefined => {
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
}

function valuesOf(selection: Selection, drafts: readonly ChangeItem[], media: string | null, scope: string, state: ElementState | null): ValueOf {
  const editOf = editFinder(selection, drafts, media, scope, state)
  const style = getComputedStyle(selection.element)
  return (property) => {
    const edit = editOf(property)
    return edit !== undefined ? { value: edit, edited: true } : { value: computedValue(selection.element, property, style), edited: false }
  }
}

// ---------------------------------------------------------------------------
// "All CSS": every declared property, raw
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

function buildRows(selection: Selection, drafts: readonly ChangeItem[], media: string | null, scope: string, state: ElementState | null): { declared: RuleGroup[]; base: Row[]; computed: Row[] } {
  const editOf = editFinder(selection, drafts, media, scope, state)
  const mine = drafts.filter((item) => item.kind === 'style' && item.target.uid === selection.ref.uid)
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

function PropertyRow({ c, row }: { c: Controller; row: Row }) {
  const edit = useValueEdit(c, row.property, row.value)
  const id = `v-${row.property}`
  return (
    <div class={`prop${row.edited ? ' edited' : ''}`}>
      <label class="name" for={id} title={`${row.property}\n${row.from}`}>
        {row.property}
      </label>
      <input
        ref={edit.input}
        id={id}
        type="text"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        value={edit.text}
        placeholder={row.value === '' ? 'not set' : undefined}
        aria-invalid={edit.error !== null}
        aria-describedby={edit.error !== null ? `${id}-msg` : undefined}
        data-dirty={edit.dirty ? '1' : undefined}
        onInput={edit.onInput}
        onKeyDown={edit.onKeyDown}
        onBlur={edit.onBlur}
      />
      {edit.error !== null ? (
        <div class="msg" id={`${id}-msg`} role="alert">
          {edit.error}
        </div>
      ) : null}
    </div>
  )
}

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
        <button type="button" class="btn sm" onClick={() => void add()}>
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
        <div class="msg" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

/** Remembered for the session of the tab: once opened, "All CSS" stays open for the next element. */
let allCssOpen = false

function AllCss({ c, selection }: { c: Controller; selection: Selection }) {
  const { store } = c
  const [open, setOpen] = useState(allCssOpen)
  const rows = buildRows(selection, store.drafts.value, store.media.value, store.scope.value, store.state.value)
  const custom = customPropertiesOf(selection.styles)
  const count = rows.declared.reduce((sum, group) => sum + group.rows.length, 0)
  return (
    <details
      class="all"
      open={open}
      onToggle={(event) => {
        const now = (event.currentTarget as HTMLDetailsElement).open
        allCssOpen = now
        setOpen(now)
      }}
    >
      <summary>
        <IconChevron />
        All CSS
        <span class="count">{count}</span>
      </summary>
      {open ? (
        <div>
          <div class="props" role="group" aria-label="Declared properties">
            {rows.declared.length === 0 ? <p class="hint">No rule of the page sets a property on this element by class or id.</p> : null}
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
          <div class="section-title">Computed</div>
          <div class="props" role="group" aria-label="Computed properties">
            {rows.computed.map((row) => (
              <PropertyRow key={row.property} c={c} row={row} />
            ))}
          </div>
          {rows.base.length > 0 ? (
            <details class="sub">
              <summary>Base styles ({rows.base.length})</summary>
              <div class="props" role="group" aria-label="Properties from base styles">
                {rows.base.map((row) => (
                  <PropertyRow key={row.property} c={c} row={row} />
                ))}
              </div>
            </details>
          ) : null}
          <AddProperty c={c} custom={custom} />
          {selection.styles.system === 'unknown' ? null : <p class="hint" style="margin-top:6px">Styled with {selection.styles.system}</p>}
        </div>
      ) : null}
    </details>
  )
}

// ---------------------------------------------------------------------------
// Scope row
// ---------------------------------------------------------------------------

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
    <div class="seg states" role="group" aria-label="State">
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
  )
}

function Scope({ c, selection }: { c: Controller; selection: Selection }) {
  const { store } = c
  const media = store.media.value
  const scope = store.scope.value
  const state = store.state.value
  const options = selection.styles.media
  return (
    <div class="scope">
      <StateControl c={c} selection={selection} state={state} />
      <div class="scope-row">
        <select aria-label="Media query" title="Record new edits inside this @media query" value={media ?? ''} onChange={(event) => (store.media.value = (event.currentTarget as HTMLSelectElement).value || null)}>
          <option value="">No media query</option>
          {options.map((option) => (
            <option key={option.query} value={option.query} disabled={!option.matches}>
              @media {option.query}
              {option.matches ? '' : ' (not at this size)'}
            </option>
          ))}
        </select>
        {selection.instances > 1 ? (
          <div class="seg" role="group" aria-label="Apply to">
            <button type="button" aria-pressed={scope === 'instance'} title="Only the element you clicked" onClick={() => (store.scope.value = 'instance')}>
              This element
            </button>
            <button type="button" aria-pressed={scope === 'all-instances'} title={`All ${selection.instances} elements rendered from the same place in the source`} onClick={() => (store.scope.value = 'all-instances')}>
              All {selection.instances}
            </button>
          </div>
        ) : null}
      </div>
      {state === null ? null : (
        <div class="showing-line" role="status" title={`The element is shown ${STATE_HELP[state]}, without the pointer or the focus being there. Edits made now are recorded for :${state} only. Choose Rest to go back.`}>
          <span class="chip info showing">
            showing <b>:{state}</b>
          </span>
          <span>new edits apply to :{state} only</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const DISPLAY = ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'none']
const ALIGN = ['normal', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline']
const JUSTIFY = ['normal', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']
const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900']
const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double']

function Group({ title, aside, children }: { title: string; aside?: string; children: ComponentChildren }) {
  return (
    <section class="group" aria-label={title}>
      <h3 class="gtitle">
        {title}
        {aside === undefined ? null : <span class="aside">{aside}</span>}
      </h3>
      {children}
    </section>
  )
}

/** Move earlier / Move later: the keyboard path to reordering (the grip on the page is the pointer's). */
function MoveButtons({ c, selection }: { c: Controller; selection: Selection }) {
  const [error, setError] = useState<string | null>(null)
  const move = async (delta: number): Promise<void> => {
    const result = await c.move(delta)
    setError(result.ok ? null : result.error)
  }
  const refusal = c.reorderRefusal()
  const position = selection.position
  const first = position === null || position.index === 0
  const last = position === null || position.index === position.count - 1
  const where = position === null ? '' : `Position ${position.index + 1} of ${position.count} among its siblings.`
  return (
    <>
      <div class="row" role="group" aria-label="Move among siblings">
        <button type="button" class="btn sm" disabled={refusal !== null || first} title={refusal ?? (first ? `${where} Already the first.` : `${where} Move it one place earlier.`)} onClick={() => void move(-1)}>
          <IconArrowUp />
          Move earlier
        </button>
        <button type="button" class="btn sm" disabled={refusal !== null || last} title={refusal ?? (last ? `${where} Already the last.` : `${where} Move it one place later.`)} onClick={() => void move(1)}>
          <IconArrowDown />
          Move later
        </button>
        <span class="hint grow" style="text-align:right">
          {position === null ? '' : `${position.index + 1} of ${position.count}`}
        </span>
      </div>
      {error === null ? null : (
        <div class="msg" role="alert">
          {error}
        </div>
      )}
    </>
  )
}

function Groups({ c, selection }: { c: Controller; selection: Selection }) {
  const { store } = c
  const valueOf = valuesOf(selection, store.drafts.value, store.media.value, store.scope.value, store.state.value)
  const field = (property: string, k: string, unit = true) => {
    const { value, edited } = valueOf(property)
    return <Field key={property} c={c} property={property} value={value} edited={edited} k={k} unit={unit} />
  }
  const select = (property: string, k: string, options: string[]) => {
    const { value, edited } = valueOf(property)
    return <SelectField key={property} c={c} property={property} value={value} edited={edited} k={k} options={options} />
  }
  const color = (property: string, k: string | null) => {
    const { value, edited } = valueOf(property)
    return <ColorField key={property} c={c} property={property} value={value} edited={edited} k={k} />
  }
  const display = valueOf('display').value
  const flex = display.includes('flex')
  const grid = display.includes('grid')
  const rect = selection.element.getBoundingClientRect()
  const resizeNote = store.resizeNote.value
  const [structureError, setStructureError] = useState<string | null>(null)
  const structural = async (op: 'hide' | 'remove'): Promise<void> => {
    const result = await c.structural(op)
    setStructureError(result.ok ? null : result.error)
  }
  return (
    <>
      <Group title="Layout" aside={flex ? 'flex' : grid ? 'grid' : undefined}>
        <div class="grid2">
          {select('display', 'Display', DISPLAY)}
          {flex || grid ? field('gap', 'Gap') : null}
        </div>
        {flex ? (
          <>
            <div class="grid2">
              <IconSeg
                c={c}
                property="flex-direction"
                label="Direction"
                value={valueOf('flex-direction').value}
                choices={[
                  { value: 'row', title: 'Row', icon: <IconArrowRight /> },
                  { value: 'column', title: 'Column', icon: <IconArrowDown /> },
                ]}
              />
              {select('flex-wrap', 'Wrap', ['nowrap', 'wrap'])}
            </div>
            <div class="grid2">
              {select('align-items', 'Align', ALIGN)}
              {select('justify-content', 'Justify', JUSTIFY)}
            </div>
          </>
        ) : null}
        {grid ? (
          <>
            {field('grid-template-columns', 'Cols', false)}
            <div class="grid2">
              {select('align-items', 'Align', ALIGN)}
              {select('justify-items', 'Justify', ['normal', 'stretch', 'start', 'center', 'end'])}
            </div>
          </>
        ) : null}
      </Group>
      <Group title="Spacing">
        <BoxModel c={c} valueOf={valueOf} size={`${Math.round(rect.width)} × ${Math.round(rect.height)}`} />
      </Group>
      <Group title="Size">
        <div class="grid2">
          {field('width', 'W')}
          {field('height', 'H')}
        </div>
        {resizeNote === null ? null : (
          <div class="msg warn" role="alert" data-resize-note="">
            {resizeNote}
          </div>
        )}
      </Group>
      <Group title="Typography">
        <div class="grid2">
          {field('font-size', 'Size')}
          {select('font-weight', 'Weight', WEIGHTS)}
          {field('line-height', 'Line', false)}
          {field('letter-spacing', 'Track')}
        </div>
        <div class="grid2">
          {color('color', null)}
          <IconSeg
            c={c}
            property="text-align"
            label="Text align"
            value={valueOf('text-align').value}
            choices={[
              { value: 'left', title: 'Align left', icon: <IconAlignLeft /> },
              { value: 'center', title: 'Align center', icon: <IconAlignCenter /> },
              { value: 'right', title: 'Align right', icon: <IconAlignRight /> },
              { value: 'justify', title: 'Justify', icon: <IconAlignJustify /> },
            ]}
          />
        </div>
      </Group>
      <Group title="Fill and border">
        {color('background-color', null)}
        <div class="grid3">
          {field('border-width', 'B')}
          {select('border-style', '', BORDER_STYLES)}
          {field('border-radius', 'R')}
        </div>
        {color('border-color', null)}
        {field('box-shadow', 'Shadow', false)}
        {field('opacity', 'Opacity', false)}
      </Group>
      <Group title="Visibility and order">
        <div class="row wrap">
          <button type="button" class="btn sm danger" onClick={() => void structural('hide')} title="Keep the element in the DOM but do not display it">
            <IconHide />
            Hide
          </button>
          <button type="button" class="btn sm danger" onClick={() => void structural('remove')} title="Ask the agent to delete the element from the source">
            <IconRemove />
            Remove
          </button>
        </div>
        {structureError === null ? null : (
          <div class="msg" role="alert">
            {structureError}
          </div>
        )}
        <MoveButtons c={c} selection={selection} />
      </Group>
    </>
  )
}

// ---------------------------------------------------------------------------
// Note
// ---------------------------------------------------------------------------

export function NoteBox({ c, on, label }: { c: Controller; on: 'element' | 'page'; label: string }) {
  const existing = c.noteOf(on)
  const saved = existing?.text ?? ''
  const [text, setText] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const dirty = useRef(false)
  const uid = on === 'page' ? 'page' : (c.store.selection.value?.ref.uid ?? '')
  useEffect(() => {
    dirty.current = false
    setText(saved)
  }, [saved, uid])
  const save = async (): Promise<void> => {
    if (!dirty.current) return
    const result = await c.addNote(text, on)
    if (result.ok) {
      dirty.current = false
      setError(null)
    } else setError(result.error)
  }
  const id = `note-${on}`
  return (
    <div class="notebox">
      <label class="gtitle" for={id}>
        {label}
        {existing !== null && !dirty.current ? <span class="aside">saved as a note</span> : null}
      </label>
      <textarea
        id={id}
        class="notes"
        rows={2}
        placeholder={on === 'page' ? 'A note about the whole page, for what CSS cannot say' : 'Copy changes, behaviour, anything CSS cannot say'}
        value={text}
        onInput={(event) => {
          dirty.current = true
          setText((event.currentTarget as HTMLTextAreaElement).value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void save()
          } else if (event.key === 'Escape' && dirty.current) {
            event.preventDefault()
            dirty.current = false
            setText(saved)
          }
        }}
        onBlur={() => void save()}
      />
      {dirty.current ? (
        <div class="row">
          <span class="hint grow">Saved when you leave the box, or with Ctrl/Cmd+Enter.</span>
          <button type="button" class="btn sm primary" onMouseDown={(event) => event.preventDefault()} onClick={() => void save()}>
            {existing === null ? 'Add note' : 'Update note'}
          </button>
        </div>
      ) : null}
      {error === null ? null : (
        <div class="msg" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

export function Inspector({ c, selection, onClose }: { c: Controller; selection: Selection; onClose(): void }) {
  const { store } = c
  const source = store.source.value
  // Building the list of every supported property takes a few milliseconds; do it before it is typed into.
  useEffect(() => void supportedProperties(), [])
  const mine = store.drafts.value.filter((item) => item.target.uid === selection.ref.uid && item.kind !== 'note')
  const name = selection.ref.label.split(' "')[0] ?? selection.ref.label
  const busy = store.busy.value
  return (
    <div class="pop inspector" role="dialog" aria-label={`Edit ${name}`}>
      <header class="pop-head">
        <nav class="crumbs" aria-label="Ancestors of the selected element">
          {selection.crumbs.map((crumb, index) => {
            const current = index === selection.crumbs.length - 1
            // The nearest three ancestors; the rest are one click away on the nearest.
            if (index < selection.crumbs.length - 4) return null
            return (
              <>
                {index > selection.crumbs.length - 4 ? (
                  <span class="chev" aria-hidden="true">
                    {'›'}
                  </span>
                ) : null}
                <button type="button" class="crumb" aria-current={current ? 'true' : undefined} title={current ? 'Selected' : 'Select this ancestor'} onClick={() => c.select(crumb.element)}>
                  {crumb.label}
                </button>
              </>
            )
          })}
          {selection.hasChild ? (
            <>
              <span class="chev" aria-hidden="true">
                {'›'}
              </span>
              <button type="button" class="crumb" title="Select the first child" onClick={() => c.navigate('ArrowDown')}>
                child
              </button>
            </>
          ) : null}
        </nav>
        <div class="title-row target">
          <span class="label" title={`${selection.ref.label}\n${selection.ref.selector}`}>
            {name}
          </span>
          <SourceBadge loc={source?.loc ?? null} state={source?.state} />
          <button type="button" class="iconbtn" aria-label="Close the inspector" title="Close (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>
      <Scope c={c} selection={selection} />
      <div class="pop-body" id="panel">
        <Groups c={c} selection={selection} />
        <AllCss c={c} selection={selection} />
        {mine.length > 0 ? (
          <section class="group" aria-label="Changes to this element">
            <h3 class="gtitle">
              Changes to this element <span class="aside">{mine.length}</span>
            </h3>
            <ul class="tray">
              {mine.map((item) => (
                <TrayItem key={item.id} c={c} item={item} />
              ))}
            </ul>
          </section>
        ) : null}
        <NoteBox c={c} on="element" label="Anything else for your agent?" />
      </div>
      <footer class="pop-foot">
        <button type="button" class="iconbtn" disabled={!store.canUndo.value} onClick={() => c.undo()} aria-label="Undo" title="Undo (Ctrl/Cmd+Z)">
          <IconUndo />
        </button>
        <button type="button" class="iconbtn" disabled={!store.canRedo.value} onClick={() => c.redo()} aria-label="Redo" title="Redo (Shift+Ctrl/Cmd+Z)">
          <IconRedo />
        </button>
        <span class="hint grow" role="status">
          {busy ? 'Measuring side effects…' : ''}
        </span>
        <button type="button" class="btn sm primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </div>
  )
}
