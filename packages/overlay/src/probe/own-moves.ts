/**
 * Nodes primp moved itself (a reorder preview, probe/preview.ts), so that primp's own mutation
 * observers (the settle client in the head script, the preview's) can tell those records from
 * the page's.
 *
 * The head script and the dock are two bundles, so the registry lives on the window: a WeakMap
 * from node to the time of the move. A record counts as primp's when every node it adds or
 * removes was moved by primp in the last second; a framework that replaces nodes in the same
 * burst still has its own records counted.
 */

const KEY = '__primp_own_moves'
const WINDOW_MS = 1000

let local: WeakMap<Node, number> | undefined

function registry(): WeakMap<Node, number> {
  const shared = (globalThis as unknown as Record<string, WeakMap<Node, number> | undefined>)[KEY]
  if (shared !== undefined) return shared
  local ??= new WeakMap()
  try {
    Object.defineProperty(globalThis, KEY, { value: local, configurable: true })
  } catch {
    // A frozen global: the registry then lives in this bundle only.
  }
  return local
}

/** Call right before primp moves `node` within its parent. */
export function noteOwnMove(node: Node): void {
  registry().set(node, Date.now())
}

/** Whether `node` was moved by primp a moment ago. */
export function isOwnMove(node: Node): boolean {
  const at = registry().get(node)
  return at !== undefined && Date.now() - at < WINDOW_MS
}

/** A childList record that only moved nodes primp moved. */
export function isOwnMoveRecord(record: MutationRecord): boolean {
  if (record.type !== 'childList' || record.addedNodes.length + record.removedNodes.length === 0) return false
  for (const node of record.addedNodes) if (!isOwnMove(node)) return false
  for (const node of record.removedNodes) if (!isOwnMove(node)) return false
  return true
}
