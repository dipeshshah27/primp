import { describe, expect, it } from 'vitest'
import { createActivityPrinter } from '../src/activity.ts'

/** A printer with a hand-driven clock: timers fire only when `advance` passes them. */
function rig() {
  const printed: string[] = []
  let now = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 0
  const printer = createActivityPrinter((line) => printed.push(line), {
    url: 'http://localhost:5174',
    settleMs: 3000,
    setTimer: (fn, ms) => {
      timers.set(++next, { at: now + ms, fn })
      return next
    },
    clearTimer: (timer) => void timers.delete(timer as number),
  })
  const advance = (ms: number): void => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.fn()
      }
    }
  }
  return { printed, printer, advance }
}

describe('activity lines in the terminal', () => {
  it('a tab attaching is said once; a reload (gone and back at once) is not said at all', () => {
    const { printed, printer, advance } = rig()
    printer({ type: 'tabs', tabs: 1, url: 'http://localhost:5174/pricing' })
    printer({ type: 'tabs', tabs: 0 })
    advance(200)
    printer({ type: 'tabs', tabs: 1, url: 'http://localhost:5174/pricing' })
    advance(5000)
    expect(printed).toEqual(['primp: a tab with the dock is open (/pricing)'])
  })

  it('a tab that stays gone is said, with the page to open', () => {
    const { printed, printer, advance } = rig()
    printer({ type: 'tabs', tabs: 1, url: 'http://localhost:5174/' })
    printer({ type: 'tabs', tabs: 0 })
    advance(3000)
    expect(printed.at(-1)).toBe('primp: no tab with the dock is open, so nothing can be measured; open http://localhost:5174')
  })

  it('a watching agent is said once, through its re-calls at every timeout', () => {
    const { printed, printer, advance } = rig()
    printer({ type: 'waiting', waiting: true })
    printer({ type: 'waiting', waiting: false })
    advance(100)
    printer({ type: 'waiting', waiting: true })
    advance(10_000)
    printer({ type: 'waiting', waiting: false })
    advance(3000)
    expect(printed).toEqual(['primp: your agent is watching: what you send from the dock goes straight to it', 'primp: your agent stopped watching'])
  })

  it('sends, claims, dismissals and results, with what did not pass', () => {
    const { printed, printer } = rig()
    printer({ type: 'sent', count: 2, batchId: 'b1', toAgent: true })
    printer({ type: 'claimed', count: 2 })
    printer({ type: 'verified', counts: { pass: 1, fail: 1 }, lines: ['a.btn: fail, padding-right is 12px, expected 24px'] })
    printer({ type: 'dismissed', id: 'c3', label: 'div.logo "Acme"', reason: 'It is an SVG from a package.' })
    expect(printed).toEqual([
      'primp: 2 changes sent from the dock to your agent',
      'primp: your agent took 2 changes',
      'primp: checked 2 changes: 1 pass, 1 fail',
      '  - a.btn: fail, padding-right is 12px, expected 24px',
      'primp: your agent dismissed div.logo: It is an SVG from a package.',
    ])
  })
})
