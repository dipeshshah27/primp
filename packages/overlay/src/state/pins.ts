/**
 * The numbered pins: one per changed element of this page, numbered in the order the elements
 * were first changed, coloured by what is known about their changes. The Changes and Verify
 * panels use the same numbers, so a number on the page and in a list is the same element.
 */

import type { ChangeItem, Ref } from '@primp/protocol/change'

/** `draft`: not sent yet. `pending`: sent, no verdict that counts (or one that cannot be measured). */
export type PinStatus = 'draft' | 'pending' | 'pass' | 'drift' | 'fail'

export interface PinGroup {
  uid: string
  number: number
  target: Ref
  items: ChangeItem[]
  status: PinStatus
}

export function itemPinStatus(item: ChangeItem): PinStatus {
  if (item.status === 'draft') return 'draft'
  const verdict = item.verification?.status
  if (verdict === 'pass') return 'pass'
  if (verdict === 'drift') return 'drift'
  if (verdict === 'fail' || verdict === 'build_error' || (verdict === undefined && item.status === 'failed')) return 'fail'
  // Unmeasured (not_measurable, tab_hidden, a note's not_checkable...) is never shown as a pass.
  return 'pending'
}

const RANK: Record<PinStatus, number> = { fail: 4, drift: 3, draft: 2, pending: 1, pass: 0 }

/** Pins of `page`: page notes and dismissed items have none. */
export function pinGroups(items: readonly ChangeItem[], page: string): PinGroup[] {
  const groups = new Map<string, PinGroup>()
  const ordered = [...items].sort((a, b) => a.seq - b.seq)
  for (const item of ordered) {
    if (item.page !== page || item.status === 'dismissed' || (item.kind === 'note' && item.on === 'page')) continue
    let group = groups.get(item.target.uid)
    if (group === undefined) {
      group = { uid: item.target.uid, number: groups.size + 1, target: item.target, items: [], status: 'pass' }
      groups.set(item.target.uid, group)
    }
    group.items.push(item)
    const status = itemPinStatus(item)
    if (group.items.length === 1 || RANK[status] > RANK[group.status]) group.status = status
  }
  return [...groups.values()]
}
