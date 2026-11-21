import { describe, expect, it } from 'vitest'
import type { ChangeItem } from '@reglet/protocol/change'
import { ChangeItemSchema } from '@reglet/protocol/change'
import {
  HISTORY_DEPTH,
  canRedo,
  canUndo,
  countsByStatus,
  editKey,
  emptyHistory,
  groupByFile,
  historyReducer,
  isNoop,
  knownFile,
  mergeReorder,
  mergeStyleEdit,
  upsertEdit,
} from '../src/items.ts'
import type { ItemHistory } from '../src/items.ts'
import { bystander, condition, move, ref, sibling, sideEffect, source, structure, style } from './change-fixtures.ts'

describe('editKey', () => {
  const base = style()

  it('same element, property, media and scope: same key, whatever the value', () => {
    expect(editKey(style({ id: 'other', seq: 7, after: { authored: '20px', computed: '20px' } }))).toBe(editKey(base))
    expect(editKey(style({ property: ' Padding-Left ' }))).toBe(editKey(base))
    expect(editKey(style({ condition: condition({ viewport: { w: 390, h: 844, dpr: 3 } }) }))).toBe(editKey(base))
  })

  it('a different element, property, media condition or scope: different key', () => {
    const keys = new Set([
      editKey(base),
      editKey(style({ target: ref({ uid: 'u2' }) })),
      editKey(style({ property: 'padding-right' })),
      editKey(style({ condition: condition({ media: '(min-width: 768px)' }) })),
      editKey(style({ condition: condition({ media: '(min-width: 1024px)' }) })),
      editKey(style({ scope: 'all-instances' })),
    ])
    expect(keys.size).toBe(6)
  })

  it('an interaction state is part of the key: a :hover edit and a resting edit of one property are two edits', () => {
    const hover = style({ condition: condition({ state: 'hover' }) })
    expect(editKey(hover)).not.toBe(editKey(base))
    expect(editKey(style({ id: 'again', condition: condition({ state: 'hover' }), after: { authored: '20px', computed: '20px' } }))).toBe(editKey(hover))
    const keys = new Set([base, ...(['hover', 'focus', 'focus-visible', 'active'] as const).map((state) => style({ condition: condition({ state }) }))].map(editKey))
    expect(keys.size).toBe(5)
    // State and media are separate parts.
    expect(editKey(style({ condition: condition({ state: 'hover', media: '(min-width: 768px)' }) }))).not.toBe(editKey(hover))
    expect(editKey(style({ condition: condition({ state: 'hover', media: '(min-width: 768px)' }) }))).not.toBe(editKey(style({ condition: condition({ media: '(min-width: 768px)' }) })))
  })

  it('structural: element and operation', () => {
    const moved = structure({ op: 'reorder', move: move() })
    expect(editKey(moved)).toBe(editKey(structure({ op: 'reorder', id: 'later', move: move({ toIndex: 5 }) })))
    expect(editKey(moved)).not.toBe(editKey(structure({ op: 'hide' })))
    expect(editKey(moved)).not.toBe(editKey(structure({ op: 'remove' })))
    expect(editKey(structure({ op: 'remove' }))).toBe(editKey(structure({ op: 'remove', id: 'x' })))
    expect(editKey(structure({ op: 'remove' }))).not.toBe(editKey(structure({ op: 'hide' })))
    expect(editKey(structure({ op: 'remove' }))).not.toBe(editKey(structure({ op: 'remove', target: ref({ uid: 'other' }) })))
    expect(editKey(structure())).not.toBe(editKey(style({ target: structure().target })))
  })
})

describe('mergeStyleEdit', () => {
  const origin = { via: 'rule' as const, selector: '.card', sheet: 'src/card.css' }
  const existing = style({
    id: 'it_1',
    seq: 1,
    createdAt: 100,
    before: { authored: '0.75rem', computed: '12px' },
    after: { authored: '14px', computed: '14px' },
    origin,
    note: 'first note',
    sideEffects: [sideEffect({ verdict: 'unwanted' }), sideEffect({ label: 'h3', selector: 'h3', verdict: 'expected' })],
  })
  // Measured with the first preview still on: its `before` is the first edit's `after`.
  const incoming = style({
    id: 'it_2',
    seq: 2,
    createdAt: 200,
    before: { authored: '14px', computed: '14px' },
    after: { authored: '1rem', computed: '16px' },
    origin: { via: 'inline' },
    sideEffects: [sideEffect({ after: { x: 0, y: 912, w: 1280, h: 120 } }), sideEffect({ label: 'p', selector: 'p' })],
    sideEffectsPartial: true,
  })
  const merged = mergeStyleEdit(existing, incoming)

  it('keeps identity, the original before and origin; takes the new after', () => {
    expect(merged.id).toBe('it_1')
    expect(merged.seq).toBe(1)
    expect(merged.createdAt).toBe(100)
    expect(merged.before).toEqual({ authored: '0.75rem', computed: '12px' })
    expect(merged.origin).toEqual(origin)
    expect(merged.after).toEqual({ authored: '1rem', computed: '16px' })
    expect(merged.note).toBe('first note')
    expect(merged.sideEffectsPartial).toBe(true)
    expect(ChangeItemSchema.safeParse(merged).success).toBe(true)
  })

  it('takes the new side effects and carries a verdict over to the same element', () => {
    expect(merged.sideEffects.map((e) => [e.selector, e.verdict, e.after.y])).toEqual([
      ['body > footer.site-footer', 'unwanted', 912],
      ['p', 'unreviewed', 908],
    ])
  })

  it('derives expect from the merged item', () => {
    expect(merged.expect.map((e) => e.type)).toEqual(['computed', 'no-move'])
    expect(merged.expect[0]).toMatchObject({ property: 'padding-left', value: '16px' })
  })

  it('longhands: before from existing, after from incoming', () => {
    const a = style({ property: 'padding', longhands: { 'padding-left': { before: '12px', after: '14px' }, 'padding-top': { before: '8px', after: '8px' } } })
    const b = style({ property: 'padding', longhands: { 'padding-left': { before: '14px', after: '16px' }, 'padding-top': { before: '8px', after: '10px' }, 'padding-right': { before: '4px', after: '6px' } } })
    expect(mergeStyleEdit(a, b).longhands).toEqual({
      'padding-left': { before: '12px', after: '16px' },
      'padding-top': { before: '8px', after: '10px' },
      'padding-right': { before: '4px', after: '6px' },
    })
    expect(mergeStyleEdit(a, style({ property: 'padding' })).longhands).toBeUndefined()
  })

  it('keeps the bystanders with their ORIGINAL values and the count on the origin; expect is derived from them', () => {
    const first = style({
      property: 'padding',
      scope: 'all-instances',
      before: { authored: '10px 18px', computed: '10px 18px' },
      after: { authored: '14px 18px', computed: '14px 18px' },
      longhands: { 'padding-top': { before: '10px', after: '14px' }, 'padding-left': { before: '18px', after: '18px' } },
      origin: { via: 'rule', selector: '.btn', sheet: 'css/site.css', alsoStyles: 4 },
      bystanders: [bystander()],
    })
    // The same edit typed again, on a page where the bystander reads differently and another one was picked.
    const again = style({
      ...first,
      before: { authored: '14px 18px', computed: '14px 18px' },
      after: { authored: '14px 26px', computed: '14px 26px' },
      longhands: { 'padding-top': { before: '14px', after: '14px' }, 'padding-left': { before: '18px', after: '26px' } },
      origin: { via: 'rule', selector: '.btn', alsoStyles: 1 },
      bystanders: [bystander({ label: 'a.btn "Other"', values: { 'padding-top': '99px', 'padding-left': '99px' } })],
      expect: undefined,
    })
    const both = mergeStyleEdit(first, again)
    expect(both.bystanders).toEqual([bystander()])
    expect(both.origin).toEqual({ via: 'rule', selector: '.btn', sheet: 'css/site.css', alsoStyles: 4 })
    // Both longhands differ from the original now, so both are checked on the bystander, against the original values.
    expect(both.expect.filter((e) => e.type === 'unchanged')).toEqual([
      { type: 'unchanged', label: bystander().label, selector: bystander().selector, locator: bystander().locator, property: 'padding-left', value: '18px' },
      { type: 'unchanged', label: bystander().label, selector: bystander().selector, locator: bystander().locator, property: 'padding-top', value: '10px' },
    ])
    expect(ChangeItemSchema.safeParse(both).success).toBe(true)
    // An existing draft without bystanders does not take the incoming ones: its origin is the one that counts.
    const { bystanders: _dropped, ...bare } = first
    void _dropped
    const plain = mergeStyleEdit({ ...bare, origin: { via: 'inline' } }, again)
    expect(plain.bystanders).toBeUndefined()
    expect(plain.origin).toEqual({ via: 'inline' })
    expect(plain.expect.every((e) => e.type !== 'unchanged')).toBe(true)
  })

  it('a newer note replaces the old one; no arguments are mutated', () => {
    const frozenA = JSON.stringify(existing)
    const frozenB = JSON.stringify(incoming)
    expect(mergeStyleEdit(existing, { ...incoming, note: 'second' }).note).toBe('second')
    expect(mergeStyleEdit(existing, style({ sideEffects: [] })).sideEffectsPartial).toBeUndefined()
    expect(JSON.stringify(existing)).toBe(frozenA)
    expect(JSON.stringify(incoming)).toBe(frozenB)
  })
})

describe('isNoop', () => {
  it('true when authored and computed are back where they started', () => {
    expect(isNoop(style({ before: { authored: '12px', computed: '12px' }, after: { authored: '12px', computed: '12px' } }))).toBe(true)
    expect(isNoop(style({ before: { authored: '12px', computed: '12px' }, after: { authored: ' 12px ', computed: '12px' } }))).toBe(true)
    expect(isNoop(style({ before: { computed: '12px' }, after: { authored: '0.75rem', computed: '12px' } }))).toBe(true)
  })

  it('false when either differs, or a longhand does', () => {
    expect(isNoop(style())).toBe(false)
    expect(isNoop(style({ before: { authored: '12px', computed: '12px' }, after: { authored: '0.75rem', computed: '12px' } }))).toBe(false)
    expect(
      isNoop(
        style({
          property: 'padding',
          before: { authored: '12px', computed: '12px' },
          after: { authored: '12px', computed: '12px' },
          longhands: { 'padding-left': { before: '12px', after: '13px' } },
        }),
      ),
    ).toBe(false)
  })

  it('removing and hiding are never no-ops', () => {
    expect(isNoop(structure())).toBe(false)
    expect(isNoop(structure({ op: 'hide' }))).toBe(false)
  })

  it('a reorder is a no-op when the element is back at the index it started from', () => {
    expect(isNoop(structure({ op: 'reorder', move: move() }))).toBe(false)
    expect(isNoop(structure({ op: 'reorder', move: move({ fromIndex: 3, toIndex: 3 }) }))).toBe(true)
    expect(isNoop(structure({ op: 'reorder', move: move({ fromIndex: 0, toIndex: 0 }) }))).toBe(true)
    // Without `move` nothing says it went nowhere.
    expect(isNoop(structure({ op: 'reorder' }))).toBe(false)
  })
})

describe('mergeReorder', () => {
  // Kiamabara, Yirgacheffe, Huila, [Gesha], Sidamo, Antigua: Gesha is moved to second place, then on to last.
  const gesha = (index: number) => ref({ uid: 'u_gesha', label: 'li "Gesha"', selector: `ul.bean-grid > li:nth-of-type(${index + 1})`, locator: sibling('li "Gesha"', index).locator })
  const first = structure({
    id: 'it_a',
    seq: 3,
    createdAt: 100,
    status: 'draft',
    op: 'reorder',
    target: gesha(1),
    move: move(),
    note: 'featured bean first',
    sideEffects: [sideEffect({ verdict: 'unwanted' }), sideEffect({ label: 'h2', selector: 'h2', verdict: 'expected' })],
  })
  // Made from where the first move left it: second place.
  const second = structure({
    id: 'it_b',
    seq: 4,
    createdAt: 200,
    status: 'draft',
    op: 'reorder',
    target: gesha(5),
    move: move({ fromIndex: 1, toIndex: 5, was: { prev: sibling('li "Kiamabara"', 0), next: sibling('li "Yirgacheffe"', 1) }, now: { prev: sibling('li "Antigua"', 4) } }),
    sideEffects: [sideEffect({ after: { x: 0, y: 912, w: 1280, h: 120 } }), sideEffect({ label: 'p', selector: 'p' })],
  })
  const merged = mergeReorder(first, second)

  it('keeps identity and where the element ORIGINALLY stood; takes where it stands now', () => {
    expect([merged.id, merged.seq, merged.createdAt]).toEqual(['it_a', 3, 100])
    expect(merged.move).toEqual({ ...second.move, fromIndex: 3, was: first.move?.was })
    expect(merged.move?.toIndex).toBe(5)
    expect(merged.move?.now).toEqual({ prev: sibling('li "Antigua"', 4) })
    // The target as recorded after the latest move: that locator is the one that finds it again.
    expect(merged.target).toEqual(second.target)
    expect(merged.note).toBe('featured bean first')
    expect(mergeReorder(first, { ...second, note: 'last after all' }).note).toBe('last after all')
    expect(ChangeItemSchema.safeParse(merged).success).toBe(true)
  })

  it('takes the new side effects, carries a verdict over to the same element, and derives expect again', () => {
    expect(merged.sideEffects.map((e) => [e.selector, e.verdict, e.after.y])).toEqual([
      ['body > footer.site-footer', 'unwanted', 912],
      ['p', 'unreviewed', 908],
    ])
    expect(merged.expect).toEqual([
      { type: 'order', siblings: [sibling('li "Antigua"', 4), { label: 'li "Gesha"', locator: second.target.locator, self: true }] },
      { type: 'no-move', label: 'footer.site-footer', locator: sideEffect().locator, rect: sideEffect().before, tolerancePx: 1 },
    ])
  })

  it('does not mutate its arguments; without `move` only the identity is kept', () => {
    const frozenA = JSON.stringify(first)
    const frozenB = JSON.stringify(second)
    mergeReorder(first, second)
    expect(JSON.stringify(first)).toBe(frozenA)
    expect(JSON.stringify(second)).toBe(frozenB)
    const { move: _dropped, ...bare } = second
    void _dropped
    expect(mergeReorder(first, bare)).toEqual({ ...bare, id: 'it_a', seq: 3, createdAt: 100 })
  })
})

describe('upsertEdit', () => {
  const first = style({ id: 'it_1', status: 'draft', before: { authored: '12px', computed: '12px' }, after: { authored: '14px', computed: '14px' } })

  it('appends a new edit, merges a repeated one, deletes one that returns to the start', () => {
    const one = upsertEdit([], first)
    expect(one).toEqual([first])

    const two = upsertEdit(one, style({ id: 'it_2', status: 'draft', before: { authored: '14px', computed: '14px' }, after: { authored: '16px', computed: '16px' } }))
    expect(two).toHaveLength(1)
    expect(two[0]).toMatchObject({ id: 'it_1', before: { computed: '12px' }, after: { computed: '16px' } })

    const three = upsertEdit(two, style({ id: 'it_3', status: 'draft', before: { authored: '16px', computed: '16px' }, after: { authored: '12px', computed: '12px' } }))
    expect(three).toEqual([])
    expect(one).toEqual([first])
  })

  it('does not merge into an item that was already sent, and ignores a no-op', () => {
    const sent = { ...first, status: 'queued' as const }
    const next = style({ id: 'it_2', status: 'draft', after: { authored: '20px', computed: '20px' } })
    expect(upsertEdit([sent], next)).toEqual([sent, next])
    expect(upsertEdit([sent], style({ status: 'draft', before: { authored: '12px', computed: '12px' }, after: { authored: '12px', computed: '12px' } }))).toEqual([sent])
  })

  it('a repeated structural edit keeps the first identity', () => {
    const a = structure({ id: 'it_a', seq: 3, status: 'draft' })
    const b = structure({ id: 'it_b', seq: 4, status: 'draft', note: 'again' })
    expect(upsertEdit([a], b)).toEqual([{ ...b, id: 'it_a', seq: 3 }])
    expect(upsertEdit([a], structure({ id: 'it_c', op: 'hide', status: 'draft' }))).toHaveLength(2)
  })

  it('a :hover edit does not merge into the resting edit of the same property', () => {
    const hover = style({ id: 'it_h', status: 'draft', condition: condition({ state: 'hover' }), before: { computed: '12px' }, after: { authored: '20px', computed: '20px' } })
    const both = upsertEdit([first], hover)
    expect(both.map((item) => item.id)).toEqual(['it_1', 'it_h'])
    // Each merges with its own kind afterwards.
    const again = upsertEdit(both, style({ id: 'it_h2', status: 'draft', condition: condition({ state: 'hover' }), before: { computed: '20px' }, after: { authored: '24px', computed: '24px' } }))
    expect(again.map((item) => [item.id, item.kind === 'style' ? item.after.computed : ''])).toEqual([
      ['it_1', '14px'],
      ['it_h', '24px'],
    ])
    expect(again[1]).toMatchObject({ before: { computed: '12px' }, condition: { state: 'hover' } })
    expect(again[1]?.expect[0]).toMatchObject({ type: 'computed', value: '24px', condition: { state: 'hover' } })
  })

  it('a second move of the same element replaces the first and keeps where it started; moving it back deletes the draft', () => {
    const target = ref({ uid: 'u_gesha', label: 'li "Gesha"' })
    const a = structure({ id: 'it_a', seq: 3, status: 'draft', op: 'reorder', target, move: move() })
    const b = structure({ id: 'it_b', seq: 4, status: 'draft', op: 'reorder', target, move: move({ fromIndex: 1, toIndex: 4, was: { prev: sibling('li "Kiamabara"', 0), next: sibling('li "Yirgacheffe"', 1) }, now: { prev: sibling('li "Sidamo"', 3), next: sibling('li "Antigua"', 5) } }) })
    const moved = upsertEdit([a], b)
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ id: 'it_a', seq: 3, move: { fromIndex: 3, toIndex: 4, was: a.move?.was, now: b.move?.now } })
    expect(moved[0]?.expect[0]).toMatchObject({ type: 'order', siblings: [{ label: 'li "Sidamo"' }, { label: 'li "Gesha"', self: true }, { label: 'li "Antigua"' }] })

    // From fifth place back to fourth, where it started: nothing is left to do.
    const back = structure({ id: 'it_c', seq: 5, status: 'draft', op: 'reorder', target, move: move({ fromIndex: 4, toIndex: 3, was: b.move?.now, now: a.move?.was }) })
    expect(upsertEdit(moved, back)).toEqual([])
    // A first move that goes nowhere is not recorded at all.
    expect(upsertEdit([], structure({ status: 'draft', op: 'reorder', target, move: move({ toIndex: 3 }) }))).toEqual([])
    // A reorder does not merge with hiding the same element, nor into a reorder that was already sent.
    expect(upsertEdit([a], structure({ id: 'it_h', status: 'draft', op: 'hide', target }))).toHaveLength(2)
    expect(upsertEdit([{ ...a, status: 'queued' }], b)).toHaveLength(2)
  })
})

describe('historyReducer', () => {
  const list = (n: number): ChangeItem[] => [style({ id: `it_${n}` })]

  it('commit, undo, redo', () => {
    const a = list(1)
    const b = list(2)
    const c = list(3)
    let state = emptyHistory()
    expect(canUndo(state)).toBe(false)
    state = historyReducer(state, { type: 'commit', items: a })
    state = historyReducer(state, { type: 'commit', items: b })
    expect(state).toEqual<ItemHistory>({ past: [[], a], present: b, future: [] })

    state = historyReducer(state, { type: 'undo' })
    expect(state).toEqual<ItemHistory>({ past: [[]], present: a, future: [b] })
    expect(canUndo(state)).toBe(true)
    expect(canRedo(state)).toBe(true)

    state = historyReducer(state, { type: 'redo' })
    expect(state.present).toBe(b)
    expect(canRedo(state)).toBe(false)

    // A new edit after an undo drops the redo branch.
    state = historyReducer(historyReducer(state, { type: 'undo' }), { type: 'commit', items: c })
    expect(state).toEqual<ItemHistory>({ past: [[], a], present: c, future: [] })
  })

  it('undo and redo at the ends, and a commit of the same list, return the same state', () => {
    const state = historyReducer(emptyHistory(), { type: 'commit', items: list(1) })
    expect(historyReducer(emptyHistory(), { type: 'undo' })).toEqual(emptyHistory())
    expect(historyReducer(state, { type: 'redo' })).toBe(state)
    expect(historyReducer(state, { type: 'commit', items: state.present })).toBe(state)
    expect(historyReducer(state, { type: 'replace', items: state.present })).toBe(state)
  })

  it('replace swaps the present and keeps both stacks; reset forgets them', () => {
    const a = list(1)
    const b = list(2)
    const fresh = list(9)
    let state = historyReducer(historyReducer(emptyHistory(), { type: 'commit', items: a }), { type: 'commit', items: b })
    state = historyReducer(state, { type: 'undo' })
    const replaced = historyReducer(state, { type: 'replace', items: fresh })
    expect(replaced).toEqual<ItemHistory>({ past: [[]], present: fresh, future: [b] })
    expect(historyReducer(replaced, { type: 'reset', items: a })).toEqual<ItemHistory>({ past: [], present: a, future: [] })
  })

  it('keeps at most 100 undo steps', () => {
    expect(HISTORY_DEPTH).toBe(100)
    let state = emptyHistory()
    const lists = Array.from({ length: 150 }, (_, i) => list(i))
    for (const items of lists) state = historyReducer(state, { type: 'commit', items })
    expect(state.past).toHaveLength(100)
    expect(state.present).toBe(lists[149])
    expect(state.past[99]).toBe(lists[148])
    expect(state.past[0]).toBe(lists[49])

    for (let i = 0; i < 150; i++) state = historyReducer(state, { type: 'undo' })
    expect(state.present).toBe(lists[49])
    expect(state.past).toHaveLength(0)
    expect(state.future).toHaveLength(100)
    for (let i = 0; i < 150; i++) state = historyReducer(state, { type: 'redo' })
    expect(state.present).toBe(lists[149])
    expect(state.past).toHaveLength(100)
  })

  it('a custom depth', () => {
    let state = emptyHistory()
    for (let i = 0; i < 5; i++) state = historyReducer(state, { type: 'commit', items: list(i) }, 2)
    expect(state.past).toHaveLength(2)
  })
})

describe('groupByFile', () => {
  const at = (id: string, seq: number, file: string | null, line?: number, col?: number, level: 'exact' | 'file' | 'candidates' = 'exact'): ChangeItem =>
    style({ id, seq, target: ref({ uid: id, source: file === null ? null : source({ file, line, col, level }) }) })

  it('groups by file in path order, items by line then column then seq; unknown last', () => {
    const items = [
      at('f', 6, null),
      at('a', 1, 'src/b/Header.tsx', 40),
      at('b', 2, 'src/a/Card.tsx', 18, 9),
      at('c', 3, 'src/a/Card.tsx', 18, 5),
      at('d', 4, 'src/a/Card.tsx', 7),
      at('e', 5, 'src/a/Card.tsx', undefined),
      at('g', 0, 'src/a/Card.tsx', 12, undefined, 'candidates'),
      at('h', 8, 'src/a/Card.tsx', 18, 5),
    ]
    const groups = groupByFile(items)
    expect(groups.map((group) => [group.file, group.items.map((item) => item.id)])).toEqual([
      ['src/a/Card.tsx', ['d', 'c', 'h', 'b', 'e']],
      ['src/b/Header.tsx', ['a']],
      [null, ['g', 'f']],
    ])
    expect(groupByFile([...items].reverse())).toEqual(groups)
  })

  it('no final group when every item has a file; empty input gives no groups', () => {
    expect(groupByFile([at('a', 1, 'x.tsx', 1)]).map((group) => group.file)).toEqual(['x.tsx'])
    expect(groupByFile([])).toEqual([])
  })

  it('knownFile: null without a source, with candidates only, or without a file', () => {
    expect(knownFile(at('a', 1, 'x.tsx', 1))).toBe('x.tsx')
    expect(knownFile(at('a', 1, 'x.tsx', 1, 1, 'file'))).toBe('x.tsx')
    expect(knownFile(at('a', 1, 'x.tsx', 1, 1, 'candidates'))).toBeNull()
    expect(knownFile(at('a', 1, null))).toBeNull()
    expect(knownFile(style({ target: ref({ source: source({ file: undefined, level: 'file' }) }) }))).toBeNull()
  })
})

describe('countsByStatus', () => {
  it('every status, in lifecycle order', () => {
    const counts = countsByStatus([style({ status: 'draft' }), style({ status: 'queued' }), style({ status: 'queued' }), structure({ status: 'failed' })])
    expect(counts).toEqual({ draft: 1, queued: 2, claimed: 0, verified: 0, failed: 1, dismissed: 0 })
    expect(Object.keys(counts)).toEqual(['draft', 'queued', 'claimed', 'verified', 'failed', 'dismissed'])
    expect(countsByStatus([])).toEqual({ draft: 0, queued: 0, claimed: 0, verified: 0, failed: 0, dismissed: 0 })
  })
})
