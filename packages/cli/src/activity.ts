import type { Activity } from '../../server/src/session.ts'

/**
 * The lines the terminal prints while primp runs, so the person at the terminal (or in the agent's
 * window next to it) sees the loop move: a tab attached, changes sent, an agent taking them,
 * results. Off with `--quiet`.
 *
 * Two things come and go on their own and would be noise said every time: a full page reload drops
 * the tab and connects a new one, and a watching agent stops waiting at each timeout and calls
 * again at once. Both are said only when they last (`settleMs`).
 */

export interface ActivityPrinterOptions {
  /** The page to open, named when no tab is left. */
  url: string
  /** How long a lost tab, or an agent that stopped waiting, has to stay so before it is said. Default 3000. */
  settleMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

export function createActivityPrinter(print: (line: string) => void, options: ActivityPrinterOptions): (activity: Activity) => void {
  const settleMs = options.settleMs ?? 3000
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref())
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout))
  let attached = false
  let lost: unknown
  let watching = false
  let stopped: unknown

  return (activity) => {
    switch (activity.type) {
      case 'tabs':
        if (activity.tabs > 0) {
          if (lost !== undefined) clearTimer(lost)
          lost = undefined
          if (!attached) {
            let path = ''
            try {
              path = activity.url === undefined ? '' : ` (${new URL(activity.url).pathname})`
            } catch {
              // No path to show.
            }
            print(`primp: a tab with the dock is open${path}`)
          }
          attached = true
        } else if (attached && lost === undefined) {
          lost = setTimer(() => {
            lost = undefined
            attached = false
            print(`primp: no tab with the dock is open, so nothing can be measured; open ${options.url}`)
          }, settleMs)
        }
        return
      case 'waiting':
        if (activity.waiting) {
          if (stopped !== undefined) clearTimer(stopped)
          stopped = undefined
          if (!watching) print('primp: your agent is watching: what you send from the dock goes straight to it')
          watching = true
        } else if (watching && stopped === undefined) {
          stopped = setTimer(() => {
            stopped = undefined
            watching = false
            print('primp: your agent stopped watching')
          }, settleMs)
        }
        return
      case 'sent':
        print(`primp: ${plural(activity.count, 'change')} sent from the dock${activity.toAgent ? ' to your agent' : ''}`)
        return
      case 'claimed':
        print(`primp: your agent took ${plural(activity.count, 'change')}`)
        return
      case 'dismissed':
        print(`primp: your agent dismissed ${activity.label.split(' "')[0]}: ${activity.reason}`)
        return
      case 'verified': {
        const total = Object.values(activity.counts).reduce((sum, count) => sum + count, 0)
        const parts = Object.entries(activity.counts).map(([status, count]) => `${count} ${status.replaceAll('_', ' ')}`)
        print(`primp: checked ${plural(total, 'change')}: ${parts.join(', ')}`)
        for (const line of activity.lines.slice(0, 5)) print(`  - ${line}`)
        if (activity.lines.length > 5) print(`  - and ${activity.lines.length - 5} more (the dock's Verification panel lists them)`)
        return
      }
    }
  }
}
