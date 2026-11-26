/**
 * Pure rules for keeping the dock's item list in step with the server.
 *
 * Who owns what: the dock is the only writer of drafts (`session:upsert`, `session:delete`);
 * every later status (`queued`, `claimed`, `verified`, `failed`, `dismissed`) is the server's,
 * and `session:state` is the truth for it.
 */

import type { ChangeItem } from '@primp/protocol/change'

export interface ReconcileOptions {
  /**
   * This is the first `session:state` on this socket (page load, or the server came back).
   * Only then does the dock take over drafts it does not have (a reload: its own earlier drafts)
   * and hand the server the drafts it is missing (a restart: the server forgot them).
   */
  first: boolean
  /** Ids the dock deleted; a state message that still lists one of them must not bring it back. */
  deleted: ReadonlySet<string>
}

export interface Reconciled {
  items: ChangeItem[]
  /** Drafts taken over from the server; the caller applies their previews. */
  adopted: ChangeItem[]
  /** Local drafts the server does not know; the caller sends them again. */
  resend: ChangeItem[]
  /** Ids that were drafts here and have another status on the server now; their previews must go. */
  released: string[]
  /** Items that were sent and are drafts again (taken back); their previews come back. */
  returned: ChangeItem[]
}

export const bySeq = (a: ChangeItem, b: ChangeItem): number => a.seq - b.seq || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function reconcile(local: readonly ChangeItem[], server: readonly ChangeItem[], options: ReconcileOptions): Reconciled {
  const mine = new Map(local.map((item) => [item.id, item]))
  const theirs = new Set<string>()
  const items: ChangeItem[] = []
  const adopted: ChangeItem[] = []
  const resend: ChangeItem[] = []
  const released: string[] = []
  const returned: ChangeItem[] = []

  for (const remote of server) {
    theirs.add(remote.id)
    const own = mine.get(remote.id)
    if (remote.status !== 'draft') {
      if (own !== undefined && own.status === 'draft') released.push(remote.id)
      items.push(remote)
    } else if (own !== undefined && own.status === 'draft') {
      // The dock's copy is the newer one; the server numbers the items.
      items.push(own.seq === remote.seq ? own : { ...own, seq: remote.seq })
    } else if (own !== undefined) {
      // Sent, and taken back to be edited (session:withdraw): a draft again, whose preview comes back.
      returned.push(remote)
      items.push(remote)
    } else if (options.first && !options.deleted.has(remote.id)) {
      items.push(remote)
      adopted.push(remote)
    }
  }
  for (const own of local) {
    if (theirs.has(own.id) || own.status !== 'draft') continue
    items.push(own)
    if (options.first) resend.push(own)
  }
  return { items: items.sort(bySeq), adopted, resend, released, returned }
}

export interface ListDiff {
  /** Items that are new or differ from the earlier list. */
  upserts: ChangeItem[]
  /** Ids that are gone. */
  deletes: string[]
}

/** What changed between two item lists. Items are compared by value, so a rebuilt but equal item is no change. */
export function diffLists(before: readonly ChangeItem[], after: readonly ChangeItem[]): ListDiff {
  const earlier = new Map(before.map((item) => [item.id, item]))
  const upserts: ChangeItem[] = []
  const kept = new Set<string>()
  for (const item of after) {
    kept.add(item.id)
    const old = earlier.get(item.id)
    if (old === undefined || (old !== item && JSON.stringify(old) !== JSON.stringify(item))) upserts.push(item)
  }
  const deletes = before.filter((item) => !kept.has(item.id)).map((item) => item.id)
  return { upserts, deletes }
}

/**
 * The list an undo or redo step leads to, with the server's word respected: an item that has
 * left the draft state keeps its current version whatever the history says, and is never
 * removed by stepping through history.
 */
export function withServerTruth(target: readonly ChangeItem[], current: readonly ChangeItem[]): ChangeItem[] {
  const settled = new Map(current.filter((item) => item.status !== 'draft').map((item) => [item.id, item]))
  const out: ChangeItem[] = []
  const seen = new Set<string>()
  for (const item of target) {
    seen.add(item.id)
    out.push(settled.get(item.id) ?? item)
  }
  for (const item of settled.values()) if (!seen.has(item.id)) out.push(item)
  return out.sort(bySeq)
}
