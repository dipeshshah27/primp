import type { Bystander, Condition, Locator, NoteChange, Rect, Ref, SiblingAnchor, SideEffect, SourceLoc, StructuralChange, StyleChange } from '@primp/protocol/change'
import { deriveExpectations } from '../src/expect.ts'

/** Builders for change items used by several test files. Every default is fixed, so output is deterministic. */

export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

export function locator(over: Partial<Locator> = {}): Locator {
  return { tag: 'div', indexPath: [0, 1, 2], ancestors: ['body', 'main', 'section'], ...over }
}

export function source(over: Partial<SourceLoc> = {}): SourceLoc {
  return {
    file: 'src/components/Card.tsx',
    line: 18,
    col: 5,
    component: 'Card',
    framework: 'react',
    level: 'exact',
    verifiedOnDisk: true,
    via: 'fiber',
    target: 'element',
    notes: [],
    ...over,
  }
}

export function ref(over: Partial<Ref> = {}): Ref {
  return {
    uid: 'u1',
    selector: 'main > section > div.card',
    tag: 'div',
    classes: ['card'],
    text: 'Pro plan',
    label: 'div.card "Pro plan"',
    rect: rect(100, 200, 320, 180),
    instanceCount: 1,
    source: source(),
    locator: locator(),
    ...over,
  }
}

export const condition = (over: Partial<Condition> = {}): Condition => ({ viewport: { w: 1280, h: 800, dpr: 1 }, colorScheme: 'light', ...over })

export function sideEffect(over: Partial<SideEffect> = {}): SideEffect {
  return {
    label: 'footer.site-footer',
    selector: 'body > footer.site-footer',
    locator: locator({ tag: 'footer', indexPath: [2], ancestors: ['body'] }),
    type: 'moved',
    before: rect(0, 900, 1280, 120),
    after: rect(0, 908, 1280, 120),
    subtreeCount: 0,
    verdict: 'unreviewed',
    ...over,
  }
}

/** An element the origin rule styles too; by default the secondary button next to a primary one. */
export function bystander(over: Partial<Bystander> = {}): Bystander {
  return {
    label: 'a.btn "See this week\'s beans"',
    selector: 'div.hero-actions > a:nth-of-type(2)',
    locator: locator({ tag: 'a', text: "See this week's beans", role: 'link', href: '#beans', indexPath: [1, 0, 2, 1], ancestors: ['body', 'main', 'section', 'div'] }),
    values: { 'padding-top': '10px', 'padding-right': '18px', 'padding-bottom': '10px', 'padding-left': '18px' },
    ...over,
  }
}

type StyleInput = Partial<Omit<StyleChange, 'kind' | 'expect'>> & { expect?: StyleChange['expect'] }

/** A style change; `expect` is derived unless given. */
export function style(over: StyleInput = {}): StyleChange {
  const { expect, ...rest } = over
  const item: Omit<StyleChange, 'expect'> = {
    id: 'it_1',
    seq: 1,
    createdAt: 1_795_000_000_000,
    page: '/pricing',
    status: 'queued',
    target: ref(),
    sideEffects: [],
    kind: 'style',
    property: 'padding-left',
    scope: 'instance',
    before: { computed: '12px' },
    after: { authored: '16px', computed: '16px' },
    condition: condition(),
    stylingSystem: 'unknown',
    ...rest,
  }
  return { ...item, expect: expect ?? deriveExpectations(item) }
}

/** A sibling named by a reorder: a list item at `index` among the children of the list, found again by its text. */
export function sibling(label: string, index: number, over: Partial<Locator> = {}): SiblingAnchor {
  const text = /"(.*)"$/.exec(label)?.[1]
  return { label, locator: locator({ tag: 'li', ...(text === undefined ? {} : { text }), indexPath: [1, 2, 0, index], ancestors: ['body', 'main', 'section', 'ul'], ...over }) }
}

export type Move = NonNullable<StructuralChange['move']>

/**
 * Where a reorder moved its element. By default the fourth of six beans (Kiamabara, Yirgacheffe,
 * Huila, the moved one, Sidamo, Antigua) became the second; index paths are those after the move.
 */
export function move(over: Partial<Move> = {}): Move {
  return {
    fromIndex: 3,
    toIndex: 1,
    siblingCount: 6,
    parent: 'ul.bean-grid',
    was: { prev: sibling('li "Huila"', 3), next: sibling('li "Sidamo"', 4) },
    now: { prev: sibling('li "Kiamabara"', 0), next: sibling('li "Yirgacheffe"', 2) },
    ...over,
  }
}

type StructureInput = Partial<Omit<StructuralChange, 'kind' | 'expect'>> & { expect?: StructuralChange['expect'] }

export function structure(over: StructureInput = {}): StructuralChange {
  const { expect, ...rest } = over
  const item: Omit<StructuralChange, 'expect'> = {
    id: 'it_9',
    seq: 9,
    createdAt: 1_795_000_000_000,
    page: '/pricing',
    status: 'queued',
    target: ref({ uid: 'u9', selector: 'body > div.banner', classes: ['banner'], text: 'Sale ends Friday', label: 'div.banner "Sale ends Friday"' }),
    sideEffects: [],
    kind: 'structure',
    op: 'remove',
    ...rest,
  }
  return { ...item, expect: expect ?? deriveExpectations(item) }
}

/** The page's `<body>`, as a page note's target. */
export function body(over: Partial<Ref> = {}): Ref {
  return ref({
    uid: 'u_body',
    selector: 'body',
    tag: 'body',
    classes: [],
    text: 'Pricing Pro plan $29 per month Choose Pro',
    label: 'body',
    rect: rect(0, 0, 1280, 2400),
    source: source({ file: 'index.html', line: 9, col: 3, component: undefined, framework: 'vite', via: 'html' }),
    locator: locator({ tag: 'body', indexPath: [], ancestors: [] }),
    ...over,
  })
}

type NoteInput = Partial<Omit<NoteChange, 'kind' | 'expect'>>

/** A note; by default one on the card element. `on: 'page'` without a target takes `body()`. */
export function note(over: NoteInput = {}): NoteChange {
  const on = over.on ?? 'element'
  return {
    id: 'it_n',
    seq: 11,
    createdAt: 1_795_000_000_000,
    page: '/pricing',
    status: 'queued',
    target: on === 'page' ? body() : ref(),
    sideEffects: [],
    kind: 'note',
    text: 'Make this card a link to the plan page',
    on,
    ...over,
    expect: [],
  }
}
