/**
 * The inspector's controls: a compact value field (label inside, Enter or leaving applies,
 * Escape restores, ArrowUp / ArrowDown nudge the number under the caret, Shift by 10), a colour
 * field with a swatch and the browser's picker, a select, icon segments and the box-model
 * editor. Every one of them edits through `controller.setStyle`, and shows its own refusal
 * under itself until the next edit.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Controller } from '../state/controller.ts'
import { nudge } from './nudge.ts'

/** A plain number typed into a length field means px. */
const BARE_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/
const stripPx = (value: string): string => (/^-?(?:\d+\.?\d*|\.\d+)px$/.test(value) ? value.slice(0, -2) : value)

export interface EditOptions {
  /** A bare number is px. */
  unit?: boolean
  /** How the value is shown in the field (the box model drops `px`). */
  compact?: boolean
}

export interface ValueEdit {
  text: string
  error: string | null
  dirty: boolean
  input: { current: HTMLInputElement | null }
  onInput(event: Event): void
  onKeyDown(event: KeyboardEvent): void
  onBlur(): void
  apply(next: string): Promise<void>
}

/** The editing behaviour every value field shares. `value` is what the element has now (or the recorded edit). */
export function useValueEdit(c: Controller, property: string, value: string, options: EditOptions = {}): ValueEdit {
  const shown = (raw: string): string => (options.compact === true ? stripPx(raw) : raw)
  const [text, setText] = useState(shown(value))
  const [error, setError] = useState<string | null>(null)
  const dirty = useRef(false)
  const input = useRef<HTMLInputElement>(null)

  // The recorded value changed (an edit, an undo, another element): show it, unless the user is typing.
  useEffect(() => {
    if (!dirty.current) setText(shown(value))
  }, [value])

  const reset = (): void => {
    dirty.current = false
    setText(shown(value))
    setError(null)
  }

  const apply = async (next: string, keep?: { start: number; end: number }): Promise<void> => {
    let wanted = next.trim()
    if (wanted === '' || wanted === shown(value).trim()) {
      reset()
      return
    }
    if (options.unit === true && BARE_NUMBER.test(wanted) && Number(wanted) !== 0) wanted = `${wanted}px`
    if (wanted === value) {
      reset()
      return
    }
    const result = await c.setStyle(property, wanted)
    if (result.ok) {
      dirty.current = false
      setError(null)
      if (keep !== undefined) input.current?.setSelectionRange(keep.start, keep.end)
    } else {
      // Shown here, at the field that caused it; not anywhere else.
      setError(result.error)
      c.store.error.value = null
    }
  }

  return {
    text,
    error,
    dirty: dirty.current,
    input,
    apply,
    onInput(event) {
      dirty.current = true
      setText((event.currentTarget as HTMLInputElement).value)
    },
    onKeyDown(event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        void apply(text)
      } else if (event.key === 'Escape') {
        // Restores the value. Only an Escape that changed something is used up; otherwise it closes the popover.
        if (!dirty.current && error === null) return
        event.preventDefault()
        reset()
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
    },
    onBlur() {
      if (dirty.current) void apply(text)
    },
  }
}

export interface FieldProps {
  c: Controller
  property: string
  value: string
  /** Short label inside the field (`W`, `Size`). */
  k: ComponentChildren
  edited?: boolean
  unit?: boolean
  title?: string
  placeholder?: string
}

export function Field({ c, property, value, k, edited, unit, title, placeholder }: FieldProps) {
  const edit = useValueEdit(c, property, value, { unit: unit === true })
  const id = `f-${property}`
  return (
    <div class="fw">
      <label class={`f${edited === true ? ' edited' : ''}${edit.error !== null ? ' invalid' : ''}`} title={title ?? `${property}: ${value || 'not set'}`} for={id}>
        <span class="k" aria-hidden="true">
          {k}
        </span>
        <input
          ref={edit.input}
          id={id}
          type="text"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          aria-label={property}
          aria-invalid={edit.error !== null}
          data-dirty={edit.dirty ? '1' : undefined}
          value={edit.text}
          placeholder={placeholder ?? (value === '' ? 'not set' : undefined)}
          onInput={edit.onInput}
          onKeyDown={edit.onKeyDown}
          onBlur={edit.onBlur}
        />
      </label>
      {edit.error !== null ? (
        <div class="msg" role="alert">
          {edit.error}
        </div>
      ) : null}
    </div>
  )
}

/** `rgb(…)`, `rgba(…)` or `#rgb[a]` / `#rrggbb[aa]` as `#rrggbb` for the colour input; null when it is something else. */
export function toHex(color: string): string | null {
  const value = color.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex !== null) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) return `#${[...digits.slice(0, 3)].map((d) => d + d).join('')}`
    if (digits.length === 6 || digits.length === 8) return `#${digits.slice(0, 6)}`
    return null
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value)
  if (rgb === null) return null
  return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, '0')).join('')}`
}

export function ColorField({ c, property, value, k, edited }: FieldProps) {
  const edit = useValueEdit(c, property, value)
  const hex = toHex(edit.text) ?? toHex(value) ?? '#000000'
  const id = `f-${property}`
  return (
    <div class="fw">
      <label class={`f${edited === true ? ' edited' : ''}${edit.error !== null ? ' invalid' : ''}`} title={`${property}: ${value || 'not set'}`} for={id}>
        <span class="sw" title="Pick a colour">
          <i style={{ background: edit.text || value }} />
          <input
            type="color"
            tabIndex={-1}
            aria-label={`Pick ${property}`}
            value={hex}
            onChange={(event) => void edit.apply((event.currentTarget as HTMLInputElement).value)}
          />
        </span>
        {k === null ? null : (
          <span class="k" aria-hidden="true">
            {k}
          </span>
        )}
        <input
          ref={edit.input}
          id={id}
          type="text"
          spellcheck={false}
          autocomplete="off"
          aria-label={property}
          aria-invalid={edit.error !== null}
          data-dirty={edit.dirty ? '1' : undefined}
          value={edit.text}
          onInput={edit.onInput}
          onKeyDown={edit.onKeyDown}
          onBlur={edit.onBlur}
        />
      </label>
      {edit.error !== null ? (
        <div class="msg" role="alert">
          {edit.error}
        </div>
      ) : null}
    </div>
  )
}

/** A select of common values; the element's own value is listed too when it is not one of them. */
export function SelectField({ c, property, value, k, options, edited }: FieldProps & { options: string[] }) {
  const [error, setError] = useState<string | null>(null)
  const list = options.includes(value) || value === '' ? options : [value, ...options]
  return (
    <div class="fw">
      <label class={`f${edited === true ? ' edited' : ''}${error !== null ? ' invalid' : ''}`} title={`${property}: ${value || 'not set'}`}>
        <span class="k" aria-hidden="true">
          {k}
        </span>
        <select
          aria-label={property}
          value={value}
          onChange={async (event) => {
            const next = (event.currentTarget as HTMLSelectElement).value
            const result = await c.setStyle(property, next)
            setError(result.ok ? null : result.error)
            if (!result.ok) c.store.error.value = null
          }}
        >
          {list.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      {error !== null ? (
        <div class="msg" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

/** A row of icon buttons that set one property (text-align, flex-direction). */
export function IconSeg({ c, property, value, choices, label }: { c: Controller; property: string; value: string; label: string; choices: { value: string; title: string; icon: ComponentChildren }[] }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div class="fw">
      <div class="seg icons" role="group" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={value === choice.value}
            aria-label={choice.title}
            title={choice.title}
            onClick={async () => {
              const result = await c.setStyle(property, choice.value)
              setError(result.ok ? null : result.error)
              if (!result.ok) c.store.error.value = null
            }}
          >
            {choice.icon}
          </button>
        ))}
      </div>
      {error !== null ? (
        <div class="msg" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function BoxInput({ c, property, value, edited, side, onError }: { c: Controller; property: string; value: string; edited: boolean; side: 't' | 'r' | 'b' | 'l'; onError(property: string, error: string | null): void }) {
  const edit = useValueEdit(c, property, value, { unit: true, compact: true })
  useEffect(() => onError(property, edit.error), [edit.error])
  return (
    <input
      ref={edit.input}
      class={`bi ${side}${edited ? ' edited' : ''}${edit.error !== null ? ' invalid' : ''}`}
      type="text"
      spellcheck={false}
      autocomplete="off"
      aria-label={property}
      title={`${property}: ${value}`}
      aria-invalid={edit.error !== null}
      data-dirty={edit.dirty ? '1' : undefined}
      value={edit.text}
      onInput={edit.onInput}
      onKeyDown={edit.onKeyDown}
      onBlur={edit.onBlur}
    />
  )
}

export type ValueOf = (property: string) => { value: string; edited: boolean }

/** Margin around padding around the content box, each side editable where it is drawn. */
export function BoxModel({ c, valueOf, size }: { c: Controller; valueOf: ValueOf; size: string }) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const onError = (property: string, error: string | null): void =>
    setErrors((now) => {
      if ((now[property] ?? null) === error) return now
      const next = { ...now }
      if (error === null) delete next[property]
      else next[property] = error
      return next
    })
  const sides = [
    ['top', 't'],
    ['right', 'r'],
    ['bottom', 'b'],
    ['left', 'l'],
  ] as const
  const input = (box: 'margin' | 'padding', side: (typeof sides)[number]) => {
    const property = `${box}-${side[0]}`
    const { value, edited } = valueOf(property)
    return <BoxInput key={property} c={c} property={property} value={value} edited={edited} side={side[1]} onError={onError} />
  }
  const messages = Object.entries(errors)
  return (
    <div class="fw">
      <div class="boxm" role="group" aria-label="Margin and padding">
        <span class="tag">margin</span>
        {sides.map((side) => input('margin', side))}
        <div class="pad">
          <span class="tag">padding</span>
          {sides.map((side) => input('padding', side))}
          <div class="core" title="Content box">
            {size}
          </div>
        </div>
      </div>
      {messages.map(([property, error]) => (
        <div key={property} class="msg" role="alert">
          {property}: {error}
        </div>
      ))}
    </div>
  )
}
