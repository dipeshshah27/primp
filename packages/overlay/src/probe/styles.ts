/**
 * Which styles apply to an element, read from the CSSOM without the DevTools protocol.
 *
 * `readStyles(element)` walks every stylesheet the script may read (cross-origin sheets throw
 * and are skipped), keeps the rules whose selector matches the element, and works out for each
 * declared property which declaration wins. It also lists the `@media` queries an edit can be
 * scoped to and guesses the styling system.
 *
 * Reads only. The winner is "good enough for the common cases" (see specificity.ts); what the
 * browser really applies is always available as the computed style.
 */

import type { StyleChange } from '@reglet/protocol/change'
import { longhandsOf } from './properties.ts'
import {
  compareCascade,
  compareSpecificity,
  hasDynamicState,
  hasPseudoElement,
  parseDeclarations,
  resolveNested,
  specificityOf,
  splitSelectorList,
  type CascadeRank,
  type ParsedDeclaration,
  type Specificity,
} from './specificity.ts'

export type StylingSystem = 'tailwind' | 'css-modules' | 'css-in-js' | 'inline' | 'plain-css' | 'unknown'

export interface MediaContext {
  /** The query as authored, e.g. `(min-width: 768px)`. */
  query: string
  matches: boolean
}

export interface MatchedRule {
  /** Selector of the rule, written out in full when it was nested. */
  selector: string
  /** The part of the selector list that matched with the highest specificity. */
  matched: string
  specificity: Specificity
  declarations: ParsedDeclaration[]
  /** Enclosing `@media` rules, outermost first. */
  media: MediaContext[]
  /** Every enclosing `@media` matches now (and no enclosing `@supports` failed). */
  active: boolean
  /** The selector only matches because of a transient state (`:hover`...). */
  dynamic: boolean
  /** Condition of the innermost enclosing `@container`, which is assumed to hold. */
  container?: string
  layer?: string
  /** Href, or the dev server's id of the owner `<style>` element. */
  sheet?: string
  /** The owner `<style>` belongs to a CSS-in-JS library. */
  cssInJs: boolean
  order: number
}

export interface DeclaredProperty extends ParsedDeclaration {
  from: 'inline' | 'rule'
  /** The winning rule; absent for the style attribute. */
  rule?: MatchedRule
  /** How many other declarations of the same property lost. */
  overrides: number
}

export interface MediaOption {
  /** Query to scope an edit to: the enclosing queries of a matching rule, joined with `and`. */
  query: string
  matches: boolean
}

export interface ElementStyles {
  rules: MatchedRule[]
  inline: ParsedDeclaration[]
  /** The winning declaration of every property some matching rule (or the style attribute) declares. */
  declared: DeclaredProperty[]
  media: MediaOption[]
  system: StylingSystem
  /** A Tailwind stylesheet is on the page. */
  tailwind: boolean
  /** Rules looked at, and sheets that could not be read. */
  stats: { rules: number; unreadableSheets: number; ms: number }
}

const ignoredSheets = new WeakSet<CSSStyleSheet>()

/** reglet's own stylesheets (the preview sheet) are not part of the page's styles. */
export function ignoreSheet(sheet: CSSStyleSheet): void {
  ignoredSheets.add(sheet)
}

const ruleClass = (name: string): (new () => CSSRule) | undefined => (globalThis as unknown as Record<string, (new () => CSSRule) | undefined>)[name]

function sheetIdentity(sheet: CSSStyleSheet): { id: string | undefined; cssInJs: boolean; owner: Element | null } {
  const owner = sheet.ownerNode instanceof Element ? sheet.ownerNode : null
  if (sheet.href !== null && sheet.href !== '') return { id: sheet.href, cssInJs: false, owner }
  if (owner === null) return { id: undefined, cssInJs: false, owner }
  const id = owner.getAttribute('data-vite-dev-id') ?? owner.getAttribute('data-n-href') ?? owner.getAttribute('data-href') ?? undefined
  const cssInJs =
    owner.hasAttribute('data-emotion') || owner.hasAttribute('data-styled') || owner.hasAttribute('data-styled-jsx') || owner.hasAttribute('data-jss')
  return { id, cssInJs, owner }
}

const tailwindSheets = new WeakMap<CSSStyleSheet, boolean>()

/** Tailwind's banner comment is not in the CSSOM, but a dev server's `<style>` element still has it as text. */
function hasTailwindBanner(sheet: CSSStyleSheet, owner: Element | null): boolean {
  let known = tailwindSheets.get(sheet)
  if (known === undefined) {
    known = owner !== null && owner.localName === 'style' && /tailwindcss v\d/.test((owner.textContent ?? '').slice(0, 400))
    tailwindSheets.set(sheet, known)
  }
  return known
}

interface WalkContext {
  media: MediaContext[]
  active: boolean
  layer: string | undefined
  container: string | undefined
  parent: string | undefined
  sheet: string | undefined
  cssInJs: boolean
}

function combineMedia(media: readonly MediaContext[]): MediaOption | undefined {
  if (media.length === 0) return undefined
  if (media.length === 1) return { query: media[0]!.query, matches: media[0]!.matches }
  // A query list (`a, b`) cannot be joined with `and`; the innermost query then stands for the lot.
  if (media.some((entry) => entry.query.includes(','))) {
    const inner = media[media.length - 1]!
    return { query: inner.query, matches: media.every((entry) => entry.matches) }
  }
  return { query: media.map((entry) => entry.query).join(' and '), matches: media.every((entry) => entry.matches) }
}

/** The combined query an edit of this rule's property would be scoped to. */
export function mediaOf(rule: MatchedRule): string | undefined {
  return combineMedia(rule.media)?.query
}

export function readStyles(el: Element): ElementStyles {
  const started = performance.now()
  const doc = el.ownerDocument
  const view = doc.defaultView ?? window
  const rules: MatchedRule[] = []
  const layers: string[] = []
  let order = 0
  let seen = 0
  let unreadable = 0
  let tailwind = false
  let anonymous = 0

  const StyleRule = ruleClass('CSSStyleRule')
  const MediaRule = ruleClass('CSSMediaRule')
  const SupportsRule = ruleClass('CSSSupportsRule')
  const LayerBlock = ruleClass('CSSLayerBlockRule')
  const LayerStatement = ruleClass('CSSLayerStatementRule')
  const ContainerRule = ruleClass('CSSContainerRule')
  const ImportRule = ruleClass('CSSImportRule')
  const NestedDeclarations = ruleClass('CSSNestedDeclarations')

  const layerName = (context: WalkContext, name: string): string => {
    const full = context.layer === undefined ? name : `${context.layer}.${name}`
    if (!layers.includes(full)) layers.push(full)
    if (name === 'utilities' || name === 'theme') tailwind ||= layers.includes('theme') && layers.includes('utilities')
    return full
  }

  const mediaQueries = new Map<string, boolean>()
  const mediaMatches = (query: string): boolean => {
    let known = mediaQueries.get(query)
    if (known === undefined) {
      try {
        known = query.trim() === '' || view.matchMedia(query).matches
      } catch {
        known = false
      }
      mediaQueries.set(query, known)
    }
    return known
  }

  const addRule = (selector: string, style: CSSStyleDeclaration, context: WalkContext): void => {
    let matchedAll: boolean
    try {
      matchedAll = el.matches(selector)
    } catch {
      return
    }
    if (!matchedAll) return
    // A part that matches without a transient state (`:hover`) decides; among those, the most specific.
    let matched = ''
    let specificity: Specificity = [0, 0, 0]
    let dynamic = true
    let any = false
    for (const part of splitSelectorList(selector)) {
      if (hasPseudoElement(part)) continue
      let hit = false
      try {
        hit = el.matches(part)
      } catch {
        // A selector this browser does not parse.
      }
      if (!hit) continue
      const partSpecificity = specificityOf(part)
      const partDynamic = hasDynamicState(part)
      const better = !any || (dynamic && !partDynamic) || (dynamic === partDynamic && compareSpecificity(partSpecificity, specificity) > 0)
      if (better) {
        matched = part
        specificity = partSpecificity
        dynamic = partDynamic
      }
      any = true
    }
    if (!any) return
    const declarations = parseDeclarations(style.cssText)
    if (declarations.length === 0) return
    const rule: MatchedRule = {
      selector,
      matched,
      specificity,
      declarations,
      media: context.media,
      active: context.active,
      dynamic,
      cssInJs: context.cssInJs,
      order: order++,
    }
    if (context.container !== undefined) rule.container = context.container
    if (context.layer !== undefined) rule.layer = context.layer
    if (context.sheet !== undefined) rule.sheet = context.sheet
    rules.push(rule)
  }

  const walk = (list: CSSRuleList, context: WalkContext): void => {
    for (let i = 0; i < list.length; i++) {
      const rule = list[i]!
      seen++
      if (StyleRule !== undefined && rule instanceof StyleRule) {
        const styleRule = rule as CSSStyleRule
        const selector = context.parent === undefined ? styleRule.selectorText : resolveNested(context.parent, styleRule.selectorText)
        addRule(selector, styleRule.style, context)
        if (styleRule.cssRules !== undefined && styleRule.cssRules.length > 0) walk(styleRule.cssRules, { ...context, parent: selector })
      } else if (NestedDeclarations !== undefined && rule instanceof NestedDeclarations) {
        if (context.parent !== undefined) addRule(context.parent, (rule as unknown as { style: CSSStyleDeclaration }).style, context)
      } else if (MediaRule !== undefined && rule instanceof MediaRule) {
        const mediaRule = rule as CSSMediaRule
        const query = mediaRule.media.mediaText
        const matches = mediaMatches(query)
        walk(mediaRule.cssRules, { ...context, media: [...context.media, { query, matches }], active: context.active && matches })
      } else if (SupportsRule !== undefined && rule instanceof SupportsRule) {
        const supportsRule = rule as CSSSupportsRule
        let holds = false
        try {
          holds = CSS.supports(supportsRule.conditionText)
        } catch {
          // Treated as not supported.
        }
        if (holds) walk(supportsRule.cssRules, context)
      } else if (LayerBlock !== undefined && rule instanceof LayerBlock) {
        const block = rule as CSSLayerBlockRule
        walk(block.cssRules, { ...context, layer: layerName(context, block.name === '' ? `(anonymous ${++anonymous})` : block.name) })
      } else if (LayerStatement !== undefined && rule instanceof LayerStatement) {
        for (const name of (rule as CSSLayerStatementRule).nameList) layerName(context, name)
      } else if (ContainerRule !== undefined && rule instanceof ContainerRule) {
        const containerRule = rule as CSSContainerRule
        walk(containerRule.cssRules, { ...context, container: containerRule.conditionText })
      } else if (ImportRule !== undefined && rule instanceof ImportRule) {
        const importRule = rule as CSSImportRule
        const imported = importRule.styleSheet
        if (imported === null) continue
        const query = importRule.media.mediaText
        const next: WalkContext = { ...context, sheet: imported.href ?? context.sheet }
        if (query !== '' && query !== 'all') {
          const matches = mediaMatches(query)
          next.media = [...context.media, { query, matches }]
          next.active = context.active && matches
        }
        if (importRule.layerName !== null) next.layer = layerName(context, importRule.layerName === '' ? `(anonymous ${++anonymous})` : importRule.layerName)
        walkSheet(imported, next)
      }
      // @scope, @starting-style, @keyframes, @font-face, @property and the like do not style the element at rest.
    }
  }

  const walkSheet = (sheet: CSSStyleSheet, context: WalkContext): void => {
    let list: CSSRuleList
    try {
      list = sheet.cssRules
    } catch {
      unreadable++
      return
    }
    walk(list, context)
  }

  const sheets: CSSStyleSheet[] = [...doc.styleSheets, ...(doc.adoptedStyleSheets ?? [])]
  for (const sheet of sheets) {
    if (ignoredSheets.has(sheet) || sheet.disabled) continue
    const identity = sheetIdentity(sheet)
    if (hasTailwindBanner(sheet, identity.owner)) tailwind = true
    const query = sheet.media.mediaText
    const context: WalkContext = {
      media: [],
      active: true,
      layer: undefined,
      container: undefined,
      parent: undefined,
      sheet: identity.id,
      cssInJs: identity.cssInJs,
    }
    if (query !== '' && query !== 'all') {
      const matches = mediaMatches(query)
      context.media = [{ query, matches }]
      context.active = matches
    }
    walkSheet(sheet, context)
  }

  const inline = parseDeclarations(el.getAttribute('style') ?? '')
  const rank = (rule: MatchedRule): number => (rule.layer === undefined ? Infinity : layers.indexOf(rule.layer))

  // Winner per declared property name, among the rules that apply right now.
  interface Entry extends CascadeRank {
    declaration: ParsedDeclaration
    rule?: MatchedRule
  }
  const byProperty = new Map<string, Entry[]>()
  const push = (entry: Entry): void => {
    const list = byProperty.get(entry.declaration.property)
    if (list === undefined) byProperty.set(entry.declaration.property, [entry])
    else list.push(entry)
  }
  inline.forEach((declaration, index) =>
    push({ declaration, inline: true, important: declaration.important, layer: Infinity, specificity: [0, 0, 0], order: index }),
  )
  for (const rule of rules) {
    if (!rule.active || rule.dynamic) continue
    for (const declaration of rule.declarations) {
      push({ declaration, rule, inline: false, important: declaration.important, layer: rank(rule), specificity: rule.specificity, order: rule.order })
    }
  }
  const winners: { entry: Entry; overrides: number }[] = []
  for (const entries of byProperty.values()) {
    let best = entries[0]!
    for (const entry of entries) if (compareCascade(entry, best) > 0) best = entry
    winners.push({ entry: best, overrides: entries.length - 1 })
  }
  // Strongest source first, as a person reads a style panel; declarations of one rule stay together.
  winners.sort((a, b) => compareCascade({ ...b.entry, important: false }, { ...a.entry, important: false }))
  const declared: DeclaredProperty[] = winners.map(({ entry, overrides }) => {
    const out: DeclaredProperty = { ...entry.declaration, from: entry.inline ? 'inline' : 'rule', overrides }
    if (entry.rule !== undefined) out.rule = entry.rule
    return out
  })

  const media: MediaOption[] = []
  for (const rule of rules) {
    if (rule.dynamic) continue
    const option = combineMedia(rule.media)
    if (option !== undefined && !media.some((known) => known.query === option.query)) media.push(option)
  }

  return {
    rules,
    inline,
    declared,
    media,
    system: detectSystem(el, rules, inline, tailwind),
    tailwind,
    stats: { rules: seen, unreadableSheets: unreadable, ms: performance.now() - started },
  }
}

// ---------------------------------------------------------------------------
// Styling system
// ---------------------------------------------------------------------------

/** Class names as CSS-modules tooling generates them: `_card_1x2y3_1`, `page-module__AbC12__card`, `Card_card__x7s9K`, `card_1a2b3`. */
export function isModuleClass(name: string): boolean {
  if (/^_[A-Za-z][\w-]*_[A-Za-z0-9]{4,8}_\d+$/.test(name)) return true
  if (/-module__[\w-]{4,}__[\w-]+$/.test(name)) return true
  if (/^[A-Za-z][\w-]*_[A-Za-z][\w-]*__[\w-]{5,}$/.test(name)) return true
  const hashed = /^[A-Za-z][A-Za-z0-9-]*_([A-Za-z0-9]{5,8})$/.exec(name)
  return hashed !== null && /\d/.test(hashed[1]!) && /[A-Za-z]/.test(hashed[1]!)
}

const UTILITY =
  /^(?:[a-z0-9-]+:|\[[^\]]+\]:)*!?-?(?:p[xytrblse]?|m[xytrblse]?|w|h|size|min-[wh]|max-[wh]|flex|grid|gap|text|bg|border|rounded|font|items|justify|shadow|tracking|leading|inset|top|left|right|bottom|z|opacity|space-[xy]|col-span|row-span|grid-cols|grid-rows|overflow|cursor|ring|divide|place|self|order|basis|grow|shrink|transition|duration|ease|underline|uppercase|lowercase|capitalize|block|inline|inline-block|inline-flex|hidden|relative|absolute|fixed|sticky|container|sr-only|truncate|antialiased|italic)(?:-[\w./[\]%#()-]+)?$/

/** Whether a class name looks like a utility class (`px-4`, `md:grid-cols-3`, `text-slate-900`). */
export function isUtilityClass(name: string): boolean {
  return UTILITY.test(name)
}

const inUtilitiesLayer = (rule: MatchedRule): boolean => rule.layer !== undefined && /(^|\.)utilities$/.test(rule.layer)
const fromModule = (rule: MatchedRule): boolean => (rule.matched.match(/\.((?:\\.|[\w-])+)/g) ?? []).some((cls) => isModuleClass(cls.slice(1).replace(/\\/g, '')))

function systemOfRule(rule: MatchedRule, tailwind: boolean): StylingSystem {
  if (rule.cssInJs) return 'css-in-js'
  if (fromModule(rule)) return 'css-modules'
  if (tailwind && inUtilitiesLayer(rule)) return 'tailwind'
  return 'plain-css'
}

function detectSystem(el: Element, rules: readonly MatchedRule[], inline: readonly ParsedDeclaration[], tailwind: boolean): StylingSystem {
  const classes = [...el.classList]
  if (rules.some((rule) => rule.cssInJs)) return 'css-in-js'
  if (classes.some(isModuleClass)) return 'css-modules'
  if (tailwind && (rules.some(inUtilitiesLayer) || classes.some(isUtilityClass))) return 'tailwind'
  // Rules that name a class or an id of the element are the author's; bare tag rules are usually a reset.
  const authored = rules.some((rule) => !rule.dynamic && (rule.specificity[0] > 0 || rule.specificity[1] > 0))
  if (inline.length > 0 && !authored) return 'inline'
  if (authored || rules.length > 0) return 'plain-css'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Where one property's value comes from
// ---------------------------------------------------------------------------

const INHERITED = new Set(
  'color cursor direction font font-family font-feature-settings font-kerning font-size font-size-adjust font-stretch font-style font-variant font-weight letter-spacing line-height list-style list-style-image list-style-position list-style-type quotes tab-size text-align text-align-last text-indent text-rendering text-shadow text-transform text-wrap visibility white-space word-break word-spacing writing-mode overflow-wrap hyphens caret-color accent-color color-scheme border-collapse border-spacing caption-side empty-cells orphans widows pointer-events'.split(
    ' ',
  ),
)

export interface PropertyOrigin {
  origin: NonNullable<StyleChange['origin']>
  /** The declared value that won, when exactly this property is declared. */
  authored?: string
  system: StylingSystem
}

/** The declaration that sets `property` on the element before an edit: by its own name, through a shorthand, or through its longhands. */
export function originOf(styles: ElementStyles, property: string): PropertyOrigin {
  const exact = styles.declared.find((entry) => entry.property === property)
  let found = exact
  if (found === undefined) {
    const longhands = longhandsOf(property)
    // `styles.declared` is sorted strongest first, so the first relative found is the one that decides.
    found = styles.declared.find((entry) => longhands.includes(entry.property) || longhandsOf(entry.property).includes(property))
  }
  if (found === undefined) {
    const inherited = property.startsWith('--') || INHERITED.has(property)
    return { origin: { via: inherited ? 'inherited' : 'default' }, system: styles.system }
  }
  const authored = exact === undefined ? undefined : exact.value
  if (found.from === 'inline' || found.rule === undefined) {
    return { origin: { via: 'inline' }, ...(authored === undefined ? {} : { authored }), system: 'inline' }
  }
  const rule = found.rule
  const origin: PropertyOrigin['origin'] = { via: 'rule', selector: rule.matched }
  if (rule.sheet !== undefined) origin.sheet = rule.sheet
  const media = mediaOf(rule)
  if (media !== undefined) origin.media = media
  return { origin, ...(authored === undefined ? {} : { authored }), system: systemOfRule(rule, styles.tailwind) }
}

/** Custom properties declared by the rules matching the element. */
export function customPropertiesOf(styles: ElementStyles): string[] {
  const names = new Set<string>()
  for (const rule of styles.rules) for (const declaration of rule.declarations) if (declaration.property.startsWith('--')) names.add(declaration.property)
  for (const declaration of styles.inline) if (declaration.property.startsWith('--')) names.add(declaration.property)
  return [...names]
}
