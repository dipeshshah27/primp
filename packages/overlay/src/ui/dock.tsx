/**
 * The dock: header (connection, project, move, collapse), the three tabs, and a footer with
 * the actions of the open tab. Rendered into the dock's own document (see mount.ts).
 */

import type { Signal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import type { Controller } from '../state/controller.ts'
import type { TabName } from '../state/store.ts'
import { EditsTab } from './edits.tsx'
import { ShiftsTab } from './shifts.tsx'
import { VerifyTab } from './verify.tsx'

export interface DockUi {
  collapsed: Signal<boolean>
  setCollapsed(collapsed: boolean): void
  /** Moves the dock to the next of its resting places (for keyboards; a pointer drags the header). */
  nextPosition(): void
  startDrag(event: PointerEvent): void
}

const TABS: { name: TabName; label: string }[] = [
  { name: 'edits', label: 'Edits' },
  { name: 'shifts', label: 'Shifts' },
  { name: 'verify', label: 'Verify' },
]

function hostOf(target: string): string {
  try {
    return new URL(target).host
  } catch {
    return target
  }
}

function TabBadge({ c, tab }: { c: Controller; tab: TabName }) {
  const { store } = c
  if (tab === 'edits') {
    const count = store.allDrafts.value.length
    return count === 0 ? null : <span class="pill">{count}</span>
  }
  if (tab === 'shifts') {
    const state = store.shifts.value
    if (state === null) return null
    if (state.report.status !== 'ok') return <span class="pill warn">!</span>
    const scored = state.report.issues.filter((issue) => issue.scored).length
    return scored === 0 ? null : <span class={`pill${(state.report.cls ?? 0) >= 0.1 ? ' bad' : ' warn'}`}>{scored}</span>
  }
  const sent = store.items.value.filter((item) => item.status !== 'draft')
  if (sent.length === 0) return null
  const failed = sent.filter((item) => item.status === 'failed').length
  return <span class={`pill${failed > 0 ? ' bad' : ''}`}>{failed > 0 ? failed : sent.length}</span>
}

function Footer({ c }: { c: Controller }) {
  const { store } = c
  const tab = store.tab.value
  if (tab === 'edits') {
    const count = store.allDrafts.value.length
    const sending = store.sending.value
    return (
      <div class="foot">
        <button type="button" class="btn" disabled={!store.canUndo.value} onClick={() => c.undo()} title="Undo (Ctrl/Cmd+Z)">
          Undo
        </button>
        <button type="button" class="btn" disabled={!store.canRedo.value} onClick={() => c.redo()} title="Redo (Shift+Ctrl/Cmd+Z)">
          Redo
        </button>
        <span class="grow" />
        <button
          type="button"
          class="btn primary"
          disabled={count === 0 || sending}
          onClick={() => void c.send().catch(() => undefined)}
          title="Queue these changes for your agent and copy the prompt"
        >
          {sending ? 'Sending...' : `Send ${count} ${count === 1 ? 'change' : 'changes'}`}
        </button>
      </div>
    )
  }
  if (tab === 'shifts') {
    return (
      <div class="foot">
        <span class="hint grow">Shifts of this page load.</span>
        <button type="button" class="btn" disabled={store.shiftsPending.value} onClick={() => void c.requestShifts().catch(() => undefined)}>
          Measure again
        </button>
      </div>
    )
  }
  const sent = store.items.value.filter((item) => item.status !== 'draft' && item.status !== 'dismissed')
  return (
    <div class="foot">
      <span class="hint grow">Results appear after your agent edits the source.</span>
      <button type="button" class="btn" disabled={sent.length === 0} onClick={() => c.reverify(sent.map((item) => item.id))}>
        Check all again
      </button>
    </div>
  )
}

export function Dock({ c, ui }: { c: Controller; ui: DockUi }) {
  const { store } = c
  const collapsed = ui.collapsed.value
  const info = store.info.value
  const connected = store.connected.value
  const tab = store.tab.value
  const first = useRef(true)
  const launcher = useRef<HTMLButtonElement>(null)
  const collapse = useRef<HTMLButtonElement>(null)

  // Keep the keyboard where the user was after the dock changed shape; never take focus on load.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    ;(collapsed ? launcher.current : collapse.current)?.focus()
  }, [collapsed])

  if (collapsed) {
    const count = store.allDrafts.value.length
    return (
      <button
        ref={launcher}
        type="button"
        class="launcher"
        aria-label={`Open primp${count > 0 ? `, ${count} unsent ${count === 1 ? 'change' : 'changes'}` : ''}${connected ? '' : ', reconnecting'}`}
        title="Open primp"
        onClick={() => ui.setCollapsed(false)}
      >
        <span aria-hidden="true">r</span>
        {count > 0 ? (
          <span class="badge" aria-hidden="true">
            {count}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <div class="dock" role="region" aria-label="primp">
      <header
        class="head"
        onPointerDown={(event) => {
          if ((event.target as Element).closest('button') === null) ui.startDrag(event)
        }}
      >
        <span class={`conn${connected ? '' : ' off'}`} role="img" aria-label={connected ? 'Connected' : 'Reconnecting'} title={connected ? 'Connected to primp' : 'Reconnecting to primp...'} />
        <span class="brand">primp</span>
        <span class="project" title={info === null ? undefined : `${info.projectName}\n${info.target}\n${info.framework}, primp ${info.version}`}>
          {connected ? (info === null ? '' : `${info.projectName} · ${hostOf(info.target)}`) : 'reconnecting...'}
        </span>
        <button type="button" class="iconbtn" aria-label="Move the dock to the next corner" title="Move (or drag the header)" onClick={() => ui.nextPosition()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 1.5v11M1.5 7h11M7 1.5 5.2 3.3M7 1.5l1.8 1.8M7 12.5l-1.8-1.8M7 12.5l1.8-1.8M1.5 7l1.8-1.8M1.5 7l1.8 1.8M12.5 7l-1.8-1.8M12.5 7l-1.8 1.8" />
          </svg>
        </button>
        <button ref={collapse} type="button" class="iconbtn" aria-label="Collapse primp" title="Collapse" onClick={() => ui.setCollapsed(true)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M3 10.5h8" />
          </svg>
        </button>
      </header>
      <div class="tabs" role="tablist" aria-label="primp">
        {TABS.map(({ name, label }) => (
          <button key={name} type="button" class="tab" role="tab" id={`tab-${name}`} aria-selected={tab === name} aria-controls="panel" onClick={() => (store.tab.value = name)}>
            {label}
            <TabBadge c={c} tab={name} />
          </button>
        ))}
      </div>
      <div class="body" id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'edits' ? <EditsTab c={c} /> : tab === 'shifts' ? <ShiftsTab c={c} /> : <VerifyTab c={c} />}
      </div>
      <Footer c={c} />
    </div>
  )
}
