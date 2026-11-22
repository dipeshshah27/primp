import type { ChangeItem, NoteChange, StyleChange, VerificationStatus } from '@primp/protocol/change'
import { describe, expect, it } from 'vitest'
import { itemPinStatus, pinGroups } from '../src/state/pins.ts'
import { toHex } from '../src/ui/fields.tsx'

const target = (uid: string): StyleChange['target'] => ({
  uid,
  selector: `#${uid}`,
  tag: 'div',
  classes: [],
  text: '',
  label: `div#${uid}`,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  instanceCount: 1,
  source: null,
  locator: { tag: 'div', indexPath: [0], ancestors: ['body'] },
})

function style(id: string, uid: string, seq: number, over: Partial<StyleChange> = {}): StyleChange {
  return {
    id,
    seq,
    createdAt: 1,
    page: '/',
    status: 'draft',
    target: target(uid),
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

function note(id: string, uid: string, seq: number, on: NoteChange['on'], over: Partial<NoteChange> = {}): NoteChange {
  return { id, seq, createdAt: 1, page: '/', status: 'draft', target: target(uid), sideEffects: [], expect: [], kind: 'note', text: 'Say hello', on, ...over }
}

const verified = (status: VerificationStatus): Partial<StyleChange> => ({
  status: status === 'pass' || status === 'drift' ? 'verified' : 'claimed',
  verification: { itemId: 'x', attempt: 1, at: 1, status, checks: [], hint: '' },
})

describe('pins', () => {
  it('numbers changed elements in the order they were first changed, one pin per element', () => {
    const items: ChangeItem[] = [style('c', 'b', 3), style('a', 'a', 1), style('b', 'b', 2), style('d', 'a', 4, { property: 'gap' })]
    const groups = pinGroups(items, '/')
    expect(groups.map((group) => [group.number, group.uid, group.items.map((item) => item.id)])).toEqual([
      [1, 'a', ['a', 'd']],
      [2, 'b', ['b', 'c']],
    ])
  })

  it('leaves out other pages, dismissed items and page notes; an element note has a pin', () => {
    const items: ChangeItem[] = [style('a', 'a', 1, { page: '/other' }), style('b', 'b', 2, { status: 'dismissed' }), note('n', 'body', 3, 'page'), note('m', 'm', 4, 'element')]
    expect(pinGroups(items, '/').map((group) => group.uid)).toEqual(['m'])
  })

  it('colours a pin by the worst status of its element: fail, drift, draft, pending, then pass', () => {
    expect(pinGroups([style('a', 'a', 1, verified('pass')), style('b', 'a', 2, verified('pass'))], '/')[0]!.status).toBe('pass')
    expect(pinGroups([style('a', 'a', 1, verified('pass')), style('b', 'a', 2)], '/')[0]!.status).toBe('draft')
    expect(pinGroups([style('a', 'a', 1, verified('drift')), style('b', 'a', 2)], '/')[0]!.status).toBe('drift')
    expect(pinGroups([style('a', 'a', 1, verified('drift')), style('b', 'a', 2, verified('fail'))], '/')[0]!.status).toBe('fail')
    expect(pinGroups([style('a', 'a', 1, { status: 'queued' })], '/')[0]!.status).toBe('pending')
  })

  it('never shows an unmeasured result as a pass', () => {
    for (const status of ['not_measurable', 'tab_hidden', 'no_browser', 'unresolved', 'no_update_observed', 'not_checkable'] as const) {
      expect(itemPinStatus(style('a', 'a', 1, verified(status)))).toBe('pending')
    }
    expect(itemPinStatus(note('n', 'a', 1, 'element', { status: 'claimed', verification: { itemId: 'n', attempt: 1, at: 1, status: 'not_checkable', checks: [], hint: '' } }))).toBe('pending')
    expect(itemPinStatus(style('a', 'a', 1, verified('build_error')))).toBe('fail')
  })
})

describe('toHex', () => {
  it('reads rgb(), rgba() and hex colours for the colour picker', () => {
    expect(toHex('rgb(37, 99, 235)')).toBe('#2563eb')
    expect(toHex('rgba(37, 99, 235, 0.5)')).toBe('#2563eb')
    expect(toHex('#abc')).toBe('#aabbcc')
    expect(toHex('#2563EB80')).toBe('#2563eb')
    expect(toHex('oklch(0.6 0.2 260)')).toBeNull()
  })
})
