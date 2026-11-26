/**
 * The popover frame: the inspector of the selected element, or the panel opened from the
 * toolbar (Changes, Shifts, Verify, Settings). One at a time; mount.ts places the frame next to
 * the selection or the toolbar and sizes it to what is shown here.
 */

import type { Controller } from '../state/controller.ts'
import type { ThemeSetting } from '../state/store.ts'
import type { DockUi } from './bar.tsx'
import { ChangesPanel } from './changes.tsx'
import { IconClose } from './icons.tsx'
import { Inspector } from './inspector.tsx'
import { ShiftsPanel } from './shifts.tsx'
import { VerifyPanel } from './verify.tsx'

function hostOf(target: string): string {
  try {
    return new URL(target).host
  } catch {
    return target
  }
}

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

function SettingsPanel({ c, ui, onClose }: { c: Controller; ui: DockUi; onClose(): void }) {
  const info = c.store.info.value
  const connected = c.store.connected.value
  const theme = ui.theme.value
  const mod = ui.mod
  return (
    <div class="pop" role="dialog" aria-label="Settings">
      <header class="pop-head">
        <div class="title-row">
          <h2 class="grow">Settings</h2>
          <button type="button" class="iconbtn" aria-label="Close the settings" title="Close (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <p class="project">
          {connected ? (info === null ? 'Connected' : `${info.projectName} · ${hostOf(info.target)} · ${info.framework}, primp ${info.version}`) : 'Not connected: reconnecting to primp…'}
        </p>
      </header>
      <div class="pop-body" id="panel">
        <div class="setting">
          <span>Theme</span>
          <div class="seg" role="group" aria-label="Theme">
            {THEMES.map((option) => (
              <button key={option.value} type="button" aria-pressed={theme === option.value} onClick={() => ui.setTheme(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div class="setting">
          <span>Toolbar position</span>
          <button type="button" class="btn sm" aria-label="Move the dock to the next corner" onClick={() => ui.nextPosition()}>
            Next corner
          </button>
        </div>
        <dl class="keys" aria-label="Keyboard shortcuts">
          <dt>Open or close primp</dt>
          <dd>
            <kbd>{mod}</kbd> <kbd>⇧</kbd> <kbd>E</kbd>
          </dd>
          <dt>Close the popover, then primp</dt>
          <dd>
            <kbd>Esc</kbd>
          </dd>
          <dt>Copy the prompt</dt>
          <dd>
            <kbd>C</kbd>
          </dd>
          <dt>Send to your agent</dt>
          <dd>
            <kbd>S</kbd>
          </dd>
          <dt>Hide or show pins</dt>
          <dd>
            <kbd>H</kbd>
          </dd>
          <dt>Pause or resume animations</dt>
          <dd>
            <kbd>P</kbd>
          </dd>
          <dt>Parent, child, siblings</dt>
          <dd>
            <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd>
          </dd>
          <dt>Move earlier, later</dt>
          <dd>
            <kbd>Alt</kbd> <kbd>↑</kbd>, <kbd>Alt</kbd> <kbd>↓</kbd>
          </dd>
          <dt>Click through to the page</dt>
          <dd>
            <kbd>Alt</kbd> + click
          </dd>
          <dt>Undo, redo</dt>
          <dd>
            <kbd>{mod}</kbd> <kbd>Z</kbd>, <kbd>{mod}</kbd> <kbd>⇧</kbd> <kbd>Z</kbd>
          </dd>
        </dl>
      </div>
    </div>
  )
}

export function Pop({ c, ui }: { c: Controller; ui: DockUi }) {
  const { store } = c
  const panel = store.panel.value
  const selection = store.selection.value
  const close = (): void => {
    if (panel === 'inspector') c.select(null)
    store.panel.value = null
  }
  let content = null
  if (panel === 'inspector' && selection !== null) content = <Inspector c={c} selection={selection} onClose={close} />
  else if (panel === 'changes') content = <ChangesPanel c={c} onClose={close} />
  else if (panel === 'shifts') content = <ShiftsPanel c={c} onClose={close} />
  else if (panel === 'verify') content = <VerifyPanel c={c} onClose={close} />
  else if (panel === 'settings') content = <SettingsPanel c={c} ui={ui} onClose={close} />
  return <div id="root">{content}</div>
}
