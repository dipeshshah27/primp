import type { ChangeItem, StyleChange } from '@primp/protocol/change'
import { describe, expect, it } from 'vitest'
import { diffLists, reconcile, withServerTruth } from '../src/state/sync.ts'

function item(id: string, over: Partial<StyleChange> = {}): StyleChange {
  return {
    id,
    seq: 0,
    createdAt: 1,
    page: '/',
    status: 'draft',
    target: {
      uid: `u-${id}`,
      selector: '#x',
      tag: 'div',
      classes: [],
      text: '',
      label: 'div#x',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      instanceCount: 1,
      source: null,
      locator: { tag: 'div', indexPath: [0], ancestors: ['body'] },
    },
    sideEffects: [],
    expect: [],
    kind: 'style',
    property: 'padding',
    scope: 'instance',
    before: { computed: '20px' },
    after: { authored: '28px', computed: '28px' },
    condition: { viewport: { w: 1280, h: 800, dpr: 1 }, colorScheme: 'light' },
    stylingSystem: 'plain-css',
    ...over,
  }
}

const none = new Set<string>()

describe('reconcile', () => {
  it('takes every status after draft from the server and releases the preview', () => {
    const local = [item('a'), item('b', { seq: 1 })]
    const server: ChangeItem[] = [item('a', { status: 'queued', batchId: 'batch-1' }), item('b', { seq: 1 })]
    const result = reconcile(local, server, { first: false, deleted: none })
    expect(result.items.map((entry) => [entry.id, entry.status])).toEqual([
      ['a', 'queued'],
      ['b', 'draft'],
    ])
    expect(result.released).toEqual(['a'])
    expect(result.adopted).toEqual([])
    expect(result.resend).toEqual([])
    expect(result.returned).toEqual([])
  })

  it('a sent change taken back (a draft again on the server) is returned, so its preview comes back', () => {
    const local = [item('a', { status: 'queued', batchId: 'batch-1' })]
    const result = reconcile(local, [item('a')], { first: false, deleted: none, withdrawn: new Set(['a']) })
    expect(result.items.map((one) => one.status)).toEqual(['draft'])
    expect(result.returned.map((one) => one.id)).toEqual(['a'])
    expect(result.released).toEqual([])
    // Another tab, which did not take it back: it is that tab's draft now, not listed here.
    const elsewhere = reconcile(local, [item('a')], { first: false, deleted: none })
    expect([elsewhere.items, elsewhere.returned]).toEqual([[], []])
  })

  it('keeps its own copy of a draft but the server numbering', () => {
    const mine = item('a', { after: { authored: '30px', computed: '30px' }, seq: 0 })
    const result = reconcile([mine], [item('a', { seq: 7 })], { first: false, deleted: none })
    expect(result.items).toHaveLength(1)
    const kept = result.items[0] as StyleChange
    expect(kept.after.authored).toBe('30px')
    expect(kept.seq).toBe(7)
  })

  it('adopts unknown drafts only on the first state of a socket', () => {
    const server = [item('old')]
    expect(reconcile([], server, { first: false, deleted: none }).items).toEqual([])
    const first = reconcile([], server, { first: true, deleted: none })
    expect(first.items.map((entry) => entry.id)).toEqual(['old'])
    expect(first.adopted.map((entry) => entry.id)).toEqual(['old'])
  })

  it('does not bring back a draft the dock deleted', () => {
    const result = reconcile([], [item('gone')], { first: true, deleted: new Set(['gone']) })
    expect(result.items).toEqual([])
    expect(result.adopted).toEqual([])
  })

  it('keeps a local draft the server has not seen, and sends it again after a reconnect', () => {
    const local = [item('mine')]
    expect(reconcile(local, [], { first: false, deleted: none }).resend).toEqual([])
    const again = reconcile(local, [], { first: true, deleted: none })
    expect(again.items.map((entry) => entry.id)).toEqual(['mine'])
    expect(again.resend.map((entry) => entry.id)).toEqual(['mine'])
  })

  it('drops a sent item the server no longer lists', () => {
    const local = [item('a', { status: 'verified' })]
    expect(reconcile(local, [], { first: false, deleted: none }).items).toEqual([])
  })

  it('orders by seq', () => {
    const result = reconcile([item('b', { seq: 5 })], [item('a', { seq: 9, status: 'queued' }), item('b', { seq: 2 })], { first: false, deleted: none })
    expect(result.items.map((entry) => entry.id)).toEqual(['b', 'a'])
  })
})

describe('diffLists', () => {
  it('reports new, changed and removed items, comparing by value', () => {
    const a = item('a')
    const b = item('b')
    const changed = item('b', { after: { authored: '40px', computed: '40px' } })
    const diff = diffLists([a, b], [{ ...a }, changed, item('c')])
    expect(diff.upserts.map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(diff.deletes).toEqual([])
    expect(diffLists([a, b], [a])).toEqual({ upserts: [], deletes: ['b'] })
    expect(diffLists([a], [a])).toEqual({ upserts: [], deletes: [] })
  })
})

describe('withServerTruth', () => {
  it('an undo step never turns a sent item back into a draft, nor removes it', () => {
    const sent = item('a', { status: 'queued' })
    const current = [sent, item('b', { seq: 1 })]
    // History from before the send: `a` was a draft, `b` did not exist.
    const target = [item('a')]
    const result = withServerTruth(target, current)
    expect(result).toEqual([sent])
    // A step to an empty list keeps the sent item too.
    expect(withServerTruth([], current)).toEqual([sent])
  })

  it('leaves drafts to the history', () => {
    const older = item('a', { after: { authored: '24px', computed: '24px' } })
    expect(withServerTruth([older], [item('a')])).toEqual([older])
  })
})
