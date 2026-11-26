/**
 * The toolbar frame: closed, a round launcher in the corner; open, a pill of icon buttons
 * (Changes, Shifts, Verify | pause animations, hide pins, copy, send | settings, close). Every
 * button has an aria-label and a tooltip, which is drawn outside the frame (mount.ts) so the
 * frame stays the size of the pill.
 */

import type { Signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { Controller } from '../state/controller.ts'
import type { PanelName, ThemeSetting } from '../state/store.ts'
import { IconChanges, IconClose, IconCopy, IconEye, IconEyeOff, IconPause, IconPlay, IconPrimp, IconSend, IconSettings, IconShifts, IconVerify } from './icons.tsx'

export interface DockUi {
  /** Shows a tooltip for a control of one of the frames (its rect in that frame), or hides it. */
  tip(text: string | null, anchor?: { frame: 'bar' | 'pop'; rect: DOMRect }, keys?: string): void
  /** Drag the toolbar (pointer down on its grip, or on the launcher); it stays where it is dropped. */
  startDrag(event: PointerEvent): void
  /** Moves the toolbar to the next of its resting places (for keyboards). */
  nextPosition(): void
  theme: Signal<ThemeSetting>
  setTheme(theme: ThemeSetting): void
  /** Opens a panel from the toolbar, or closes it when it is the one open. */
  toggle(panel: PanelName): void
  /** ⌘ on a Mac, Ctrl elsewhere: for the shortcut hints. */
  mod: string
}

function hostOf(target: string): string {
  try {
    return new URL(target).host
  } catch {
    return target
  }
}

function useTip(ui: DockUi, text: string, keys?: string) {
  const show = (event: Event): void => ui.tip(text, { frame: 'bar', rect: (event.currentTarget as HTMLElement).getBoundingClientRect() }, keys)
  return { onPointerEnter: show, onFocus: show, onPointerLeave: () => ui.tip(null), onBlur: () => ui.tip(null) }
}

function shiftBadge(c: Controller): { text: string; tone: string } | null {
  const state = c.store.shifts.value
  if (state === null) return null
  if (state.report.status !== 'ok') return { text: '!', tone: 'warn' }
  const scored = state.report.issues.filter((issue) => issue.scored).length
  if (scored === 0) return null
  const cls = state.report.cls ?? 0
  // A score that shows as 0.000 is not worth a warning on the toolbar; the panel still lists it.
  if (cls < 0.0005) return null
  return { text: cls >= 0.0995 ? cls.toFixed(2) : cls.toFixed(3), tone: cls >= 0.1 ? 'bad' : 'warn' }
}

function verifyDot(c: Controller): 'pending' | 'pass' | 'drift' | 'fail' | null {
  const sent = c.store.items.value.filter((item) => item.status !== 'draft' && item.status !== 'dismissed')
  if (sent.length === 0) return null
  const statuses = sent.map((item) => item.verification?.status)
  if (statuses.some((status) => status === 'fail' || status === 'build_error') || sent.some((item) => item.status === 'failed')) return 'fail'
  if (statuses.some((status) => status === 'drift')) return 'drift'
  if (statuses.every((status) => status === 'pass')) return 'pass'
  return 'pending'
}

function Launcher({ c, ui }: { c: Controller; ui: DockUi }) {
  const { store } = c
  const count = store.allDrafts.value.length
  const connected = store.connected.value
  const unseen = store.unseen.value
  const said = { fail: 'something failed', drift: 'one landed close', unmeasured: 'some could not be measured', pass: 'passed' } as const
  const tip = useTip(ui, `${unseen === null ? 'Open primp' : `Open primp: new results (${said[unseen]})`}. Drag to move`, `${ui.mod}⇧E`)
  return (
    <button
      type="button"
      class="launcher"
      aria-label={`Open primp${count > 0 ? `, ${count} unsent ${count === 1 ? 'change' : 'changes'}` : ''}${unseen === null ? '' : `, new results: ${unseen}`}${connected ? '' : ', reconnecting'}`}
      aria-keyshortcuts="Control+Shift+E Meta+Shift+E"
      onPointerDown={(event) => ui.startDrag(event)}
      onClick={() => {
        ui.tip(null)
        c.setOpen(true)
      }}
      {...tip}
    >
      <IconPrimp size={20} />
      {unseen === null ? null : <span class={`dot launcher-dot ${unseen === 'unmeasured' ? 'pending' : unseen}`} aria-hidden="true" />}
      {count > 0 ? (
        <span class="badge" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </button>
  )
}

function Tb({ ui, label, keys, children, ...rest }: { ui: DockUi; label: string; keys?: string; children: ComponentChildren } & Record<string, unknown>) {
  const tip = useTip(ui, label, keys)
  return (
    <button type="button" class="tb" aria-label={label} {...tip} {...rest}>
      {children}
    </button>
  )
}

function Toolbar({ c, ui }: { c: Controller; ui: DockUi }) {
  const { store } = c
  const panel = store.panel.value
  const count = store.allDrafts.value.length
  const info = store.info.value
  const connected = store.connected.value
  const shifts = shiftBadge(c)
  const dot = verifyDot(c)
  const paused = store.paused.value
  const hidden = store.pinsHidden.value
  const sending = store.sending.value
  // An agent called wait_for_changes: a Send goes straight to it.
  const waiting = info?.agentWaiting === true
  const project = info === null ? 'primp' : `primp · ${info.projectName} · ${hostOf(info.target)}`
  const grip = useTip(ui, connected ? `${project}. Drag to move` : 'Reconnecting to primp…')
  return (
    <div class="bar" role="toolbar" aria-label="primp" aria-orientation="horizontal">
      <div class="drag" onPointerDown={(event) => ui.startDrag(event)} {...grip}>
        <IconPrimp size={16} />
        <span class={`conn${connected ? '' : ' off'}`} role="img" aria-label={connected ? 'Connected' : 'Reconnecting'} />
      </div>
      <Tb ui={ui} label="Changes" id="tab-edits" aria-expanded={panel === 'changes'} onClick={() => ui.toggle('changes')}>
        <IconChanges />
        {count > 0 ? (
          <span class="badge pill" aria-hidden="true">
            {count}
          </span>
        ) : null}
        {count > 0 ? <span class="sr">, {count} unsent</span> : null}
      </Tb>
      <Tb ui={ui} label="Layout shifts" id="tab-shifts" aria-expanded={panel === 'shifts'} onClick={() => ui.toggle('shifts')}>
        <IconShifts />
        {shifts === null ? null : <span class={`badge pill ${shifts.tone}`}>{shifts.text}</span>}
      </Tb>
      <Tb ui={ui} label="Verification" id="tab-verify" aria-expanded={panel === 'verify'} onClick={() => ui.toggle('verify')}>
        <IconVerify />
        {dot === null ? null : <span class={`dot ${dot}`} aria-hidden="true" />}
        {dot === null ? null : <span class="sr">, {dot}</span>}
      </Tb>
      <span class="sep" aria-hidden="true" />
      <Tb ui={ui} label={paused ? 'Resume animations' : 'Pause animations'} keys="P" aria-pressed={paused} onClick={() => c.setPaused(!paused)}>
        {paused ? <IconPlay /> : <IconPause />}
      </Tb>
      <Tb ui={ui} label={hidden ? 'Show pins' : 'Hide pins'} keys="H" aria-pressed={hidden} onClick={() => (store.pinsHidden.value = !hidden)}>
        {hidden ? <IconEyeOff /> : <IconEye />}
      </Tb>
      <Tb ui={ui} label="Copy prompt" keys="C" disabled={count === 0} onClick={() => void c.copyPrompt()}>
        <IconCopy />
      </Tb>
      <Tb
        ui={ui}
        label={`${count === 0 ? 'Send to your agent' : `Send ${count} ${count === 1 ? 'change' : 'changes'} to your agent`}${waiting ? ' (it is waiting for them)' : ''}`}
        keys="S"
        class={`tb send${count > 0 ? ' ready' : ''}`}
        disabled={count === 0 || sending}
        onClick={() => void c.send().catch(() => undefined)}
      >
        <IconSend />
        {waiting ? <span class="waiting" aria-hidden="true" /> : null}
        {waiting ? <span class="sr">, your agent is waiting</span> : null}
      </Tb>
      <span class="sep" aria-hidden="true" />
      <Tb ui={ui} label="Settings" aria-expanded={panel === 'settings'} onClick={() => ui.toggle('settings')}>
        <IconSettings />
      </Tb>
      <Tb ui={ui} label="Close primp" keys="Esc" onClick={() => c.setOpen(false)}>
        <IconClose />
      </Tb>
    </div>
  )
}

export function Bar({ c, ui }: { c: Controller; ui: DockUi }) {
  const open = c.store.open.value
  const first = useRef(true)
  const root = useRef<HTMLDivElement>(null)
  // Keep the keyboard where the user was after the toolbar changed shape; never take focus on load.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (root.current?.ownerDocument.hasFocus() !== true) return
    root.current.querySelector<HTMLElement>(open ? '.tb' : '.launcher')?.focus()
  }, [open])
  return (
    <div id="root" ref={root} style="width:max-content">
      {open ? <Toolbar c={c} ui={ui} /> : <Launcher c={c} ui={ui} />}
    </div>
  )
}
