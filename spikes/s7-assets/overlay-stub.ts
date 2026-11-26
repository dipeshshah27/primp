/**
 * A stand-in for the primp overlay, for spike S3: the second head script.
 *
 * It does what the real dock does to a page and nothing more: after
 * DOMContentLoaded it adds one custom element with a shadow root that holds a
 * small dock, marked `data-primp-root`, and shows it either in the top layer
 * (`popover="manual"`) or as a `position: fixed` box. All its styling goes
 * through a constructable stylesheet, the only way that works under every
 * Content-Security-Policy.
 *
 * It also carries the "edit" the spike uses to test self-tagging:
 * `window.__primpStub.edit(...)` calls `window.__primp.markSelf()` and then
 * changes a style, exactly in that order and in the same task.
 */

declare const __PRIMP_STUB_MODE__: 'popover' | 'fixed'

export interface PrimpStub {
  mode: 'popover' | 'fixed'
  mountedAt: number | undefined
  /** Changes one inline style property of the first element matching `selector`; with `mark` it announces the change to the hook first. */
  edit(selector: string, property: string, value: string, mark?: string): void
  /** Sets `handler` as what the dock's "Apply" button does when clicked. */
  onApply(handler: () => void): void
}

declare global {
  interface Window {
    __primpStub?: PrimpStub
  }
}

const DOCK_CSS = `
:host {
  position: fixed; inset: auto 16px 16px auto; margin: 0; padding: 0; border: 0;
  width: 320px; height: auto; overflow: visible; background: transparent; color: #111;
  font: 13px/1.4 system-ui, sans-serif; z-index: 2147483647;
}
.dock { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: #fff; box-shadow: 0 6px 24px rgb(0 0 0 / 0.25); }
.tabs { display: flex; gap: 6px; }
button { font: inherit; padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #f9fafb; }
input { font: inherit; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; }
`

let apply: () => void = () => {}

function mount(): void {
  if (customElements.get('primp-root') === undefined) customElements.define('primp-root', class extends HTMLElement {})
  const host = document.createElement('primp-root')
  host.setAttribute('data-primp-root', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(DOCK_CSS)
  shadow.adoptedStyleSheets = [sheet]

  const dock = document.createElement('div')
  dock.className = 'dock'
  const tabs = document.createElement('div')
  tabs.className = 'tabs'
  for (const name of ['Edits', 'Shifts', 'Verify']) {
    const tab = document.createElement('button')
    tab.textContent = name
    tabs.append(tab)
  }
  const input = document.createElement('input')
  input.id = 'value'
  input.placeholder = 'margin-top'
  const button = document.createElement('button')
  button.id = 'apply'
  button.textContent = 'Apply'
  button.addEventListener('click', () => apply())
  dock.append(tabs, input, button)
  shadow.append(dock)

  if (__PRIMP_STUB_MODE__ === 'popover') host.setAttribute('popover', 'manual')
  // Outside <body>: the page's own `body > *` rules and child lists never see the host.
  document.documentElement.append(host)
  if (__PRIMP_STUB_MODE__ === 'popover') host.showPopover()
  stub.mountedAt = performance.now()
}

const stub: PrimpStub = {
  mode: __PRIMP_STUB_MODE__,
  mountedAt: undefined,
  edit(selector, property, value, mark) {
    const element = document.querySelector<HTMLElement>(selector)
    if (element === null) throw new Error(`no element matches ${selector}`)
    if (mark !== undefined) window.__primp?.markSelf(mark)
    element.style.setProperty(property, value)
  },
  onApply(handler) {
    apply = handler
  },
}
window.__primpStub = stub

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
else mount()
