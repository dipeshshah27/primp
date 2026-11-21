import type { Condition, Locator, Rect, Ref, SideEffect, SourceLoc, StructuralChange, StyleChange } from '@reglet/protocol/change'
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
