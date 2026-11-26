/**
 * What the head part of the stand-in (head.ts) and its session (session.ts) share: the fake
 * sockets the dock talks through, and the queue of messages that arrived before the session
 * script had loaded.
 */

export interface StandinSocket {
  /** The document id from `session:hello`. */
  doc: string | undefined
  /** Server -> browser, one task later, as a real socket would. */
  deliver(message: object): void
}

export interface StandinHost {
  /** Open sockets. */
  sockets: Set<StandinSocket>
  /** Set by session.ts once it has loaded; until then, messages wait in `pending`. */
  receive: ((socket: StandinSocket, text: string) => void) | undefined
  pending: [StandinSocket, string][]
  /** Whether this load is the layout-shift replay, and whether the delay worker controls it. */
  shift: { replay: boolean; held: boolean }
}

/** What the website's own UI reads (components/live-dock.tsx) and spikes/site-check.ts checks. */
export interface SiteEvents {
  lastPrompt: string | null
  lastReport: unknown
  lastSimulation?: SimulationResult
}

export const SENT_EVENT = 'primp-site:sent'
export const REPORT_EVENT = 'primp-site:report'
/** The site asks the stand-in to play an agent on the last batch: detail `{ mode: 'careful' | 'sloppy' }`. */
export const SIMULATE_EVENT = 'primp-site:simulate'
/** The simulated agent is done and its changes are verified: detail `SimulationResult`. */
export const VERIFIED_EVENT = 'primp-site:verified'

export interface SimulationResult {
  mode: 'careful' | 'sloppy'
  /** How many changes ended with each verification status. */
  counts: Record<string, number>
  /** What the simulated agent did, one line per change. */
  did: string[]
}

declare global {
  interface Window {
    __primp_site_host?: StandinHost
    __primp_site?: SiteEvents
  }
}
