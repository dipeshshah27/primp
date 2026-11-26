/**
 * Which styles apply to an element, read from the CSSOM without the DevTools protocol.
 *
 * `readStyles(element)` walks every stylesheet the script may read (cross-origin sheets throw
 * and are skipped), keeps the rules whose selector matches the element at rest or would match
 * it in `:hover`, `:focus`, `:focus-visible` or `:active`, and works out for each declared
 * property which declaration wins at rest (`declaredIn` does the same for a state). It also
 * lists the `@media` queries an edit can be scoped to and guesses the styling system.
 *
 * Not modelled, and left out of the state views: `:focus-within`, and a state inside `:not()`
 * or `:has()` (`.btn:not(:hover)` counts as a resting rule in every view).
 *
 * Reads only. The winner is "good enough for the common cases" (see specificity.ts); what the
 * browser really applies is always available as the computed style.
 */

import type { ElementState, StyleChange } from '@primp/protocol/change'
import { setsProperty, type Flow } from './properties.ts'
import {
  activeStates,
  atRest,
  compareCascade,
  compareSpecificity,
  ELEMENT_STATES,
  hasPseudoElement,
  inStates,
  parseDeclarations,
  resolveNested,
  specificityOf,
  splitSelectorList,
  statesOf,
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
  /**
   * The interaction states `matched` needs before it styles the element: `['hover']` for
   * `.btn:hover` and for `.card:hover .btn`, both `hover` and `focus` for `.btn:hover:focus`.
   * Empty: the rule applies at rest. A rule whose selector list reaches the element through
   * different states (`.btn:hover, .btn:focus-visible`) is listed once for each, with the same `order`.
   */
  states: ElementState[]
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
  /** Every rule that styles the element at rest or in one of the states; see `MatchedRule.states`. */
  rules: MatchedRule[]
  inline: ParsedDeclaration[]
  /** The winning declaration of every property some rule that applies AT REST (or the style attribute) declares. For a state: `declaredIn`. */
  declared: DeclaredProperty[]
  /** The states at least one rule styles this element in (under the media that match now). */
  states: ElementState[]
  /** Cascade layers in the order the page declared them; a rule's rank is its layer's index. */
  layers: string[]
  media: MediaOption[]
  system: StylingSystem
  /** A Tailwind stylesheet is on the page. */
  tailwind: boolean
  /** The element's direction and writing mode, which logical properties (`padding-inline`) map through. */
  flow?: Flow
  /** Rules looked at, and sheets that could not be read. */
  stats: { rules: number; unreadableSheets: number; ms: number }
}

/** Marks an element (and what is above it) that `forceState` (states.ts) holds in a state. */
export const FORCE_ATTR = 'data-primp-force'

/**
 * A rule's selector as the page wrote it. While a state is forced, the page's rules for that
 * state carry a second selector with primp's marker in it (see states.ts); those are not the page's.
 */
export function pageSelector(selectorText: string): string {
  if (!selectorText.includes(FORCE_ATTR)) return selectorText
  return splitSelectorList(selectorText)
    .filter((part) => !part.includes(`[${FORCE_ATTR}`))
    .join(', ')
}

const ignoredSheets = new WeakSet<CSSStyleSheet>()

/** primp's own stylesheets (the preview sheet) are not part of the page's styles. */
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

/** The element's direction and whether its writing mode is vertical; empty when they cannot be read. */
function flowOf(el: Element): Flow {
  try {
    const style = getComputedStyle(el)
    return { direction: style.direction, vertical: style.writingMode.startsWith('vertical') || style.writingMode.startsWith('sideways') }
  } catch {
    return {}
  }
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

  const matches = (selector: string): boolean => {
    try {
      return el.matches(selector)
    } catch {
      // A selector this browser does not parse.
      return false
    }
  }

  const addRule = (selector: string, style: CSSStyleDeclaration, context: WalkContext): void => {
    // One candidate per set of states the selector list reaches the element through; of the parts
    // with the same needs, the most specific one. Whether the pointer or the focus is on the element
    // right now plays no part: the states in a selector are never asked of the browser.
    const reached: { key: string; matched: string; specificity: Specificity; states: ElementState[] }[] = []
    for (const part of splitSelectorList(selector)) {
      if (hasPseudoElement(part)) continue
      const needs = statesOf(part)
      let states: ElementState[]
      if (!needs.any) {
        if (!matches(part)) continue
        states = []
      } else if (matches(atRest(part))) {
        // `:is(.on, :hover)` on an element with `.on`, or `:not(:hover)`.
        states = []
      } else if (!needs.beyond && needs.states.length > 0 && matches(inStates(part, needs.states))) {
        states = needs.states
      } else continue
      const key = states.join(' ')
      const partSpecificity = specificityOf(part)
      const known = reached.find((entry) => entry.key === key)
      if (known === undefined) reached.push({ key, matched: part, specificity: partSpecificity, states })
      else if (compareSpecificity(partSpecificity, known.specificity) > 0) {
        known.matched = part
        known.specificity = partSpecificity
      }
    }
    if (reached.length === 0) return
    const declarations = parseDeclarations(style.cssText)
    if (declarations.length === 0) return
    // A rule that applies at rest applies in every state too: its other parts add nothing.
    const resting = reached.find((entry) => entry.key === '')
    const at = order++
    for (const entry of resting === undefined ? reached : [resting]) {
      const rule: MatchedRule = {
        selector,
        matched: entry.matched,
        specificity: entry.specificity,
        declarations,
        media: context.media,
        active: context.active,
        states: entry.states,
        cssInJs: context.cssInJs,
        order: at,
      }
      if (context.container !== undefined) rule.container = context.container
      if (context.layer !== undefined) rule.layer = context.layer
      if (context.sheet !== undefined) rule.sheet = context.sheet
      rules.push(rule)
    }
  }

  const walk = (list: CSSRuleList, context: WalkContext): void => {
    for (let i = 0; i < list.length; i++) {
      const rule = list[i]!
      seen++
      if (StyleRule !== undefined && rule instanceof StyleRule) {
        const styleRule = rule as CSSStyleRule
        const own = pageSelector(styleRule.selectorText)
        const selector = context.parent === undefined ? own : resolveNested(context.parent, own)
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

  const media: MediaOption[] = []
  for (const rule of rules) {
    if (rule.states.length > 0) continue
    const option = combineMedia(rule.media)
    if (option !== undefined && !media.some((known) => known.query === option.query)) media.push(option)
  }

  return {
    rules,
    inline,
    declared: declaredWinners(rules, inline, layers),
    states: statesWithRules(rules),
    layers,
    media,
    // As before states were read: from the rules that apply at rest.
    system: detectSystem(
      el,
      rules.filter((rule) => rule.states.length === 0),
      inline,
      tailwind,
    ),
    tailwind,
    flow: flowOf(el),
    stats: { rules: seen, unreadableSheets: unreadable, ms: performance.now() - started },
  }
}

// ---------------------------------------------------------------------------
// Which declaration wins, at rest and in a state
// ---------------------------------------------------------------------------

/** Whether a rule styles the element while it is in `state` (null: at rest): its media match and every state it needs holds. */
export function appliesIn(rule: Pick<MatchedRule, 'active' | 'states'>, state: ElementState | null = null): boolean {
  if (!rule.active) return false
  if (rule.states.length === 0) return true
  const holding = activeStates(state)
  return rule.states.every((needed) => holding.includes(needed))
}

/**
 * The states for which at least one rule exists: the rule needs that very state and applies in
 * it. A `:hover` rule alone does not make `:active` one of them, although it applies there too.
 */
export function statesWithRules(rules: readonly Pick<MatchedRule, 'active' | 'states'>[]): ElementState[] {
  return ELEMENT_STATES.filter((state) => rules.some((rule) => rule.states.includes(state) && appliesIn(rule, state)))
}

/**
 * The winning declaration of every property declared by the style attribute or by a rule that
 * applies in `state` (null: at rest), strongest source first. In a state these are the resting
 * rules plus the rules for that state, ranked as the cascade ranks them. Pure.
 */
export function declaredWinners(
  rules: readonly MatchedRule[],
  inline: readonly ParsedDeclaration[],
  layers: readonly string[],
  state: ElementState | null = null,
): DeclaredProperty[] {
  const rank = (rule: MatchedRule): number => (rule.layer === undefined ? Infinity : layers.indexOf(rule.layer))
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
    if (!appliesIn(rule, state)) continue
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
  return winners.map(({ entry, overrides }) => {
    const out: DeclaredProperty = { ...entry.declaration, from: entry.inline ? 'inline' : 'rule', overrides }
    if (entry.rule !== undefined) out.rule = entry.rule
    return out
  })
}

/**
 * The states in which a rule of the page written for that state sets `property` (by its own name,
 * through a shorthand or through its longhands) on this element under the media that match now.
 * A resting edit of the property does not reach into those states once it is in the source: the
 * state's rule still wins there. The preview of a resting edit is left out of them (preview.ts).
 */
export function statesCovering(styles: Pick<ElementStyles, 'rules' | 'flow'>, property: string): ElementState[] {
  const related = (name: string): boolean => setsProperty(name, property, styles.flow)
  const out = new Set<ElementState>()
  for (const rule of styles.rules) {
    if (rule.states.length === 0 || !rule.active) continue
    if (!rule.declarations.some((declaration) => related(declaration.property))) continue
    for (const state of ELEMENT_STATES) if (appliesIn(rule, state)) out.add(state)
  }
  return ELEMENT_STATES.filter((state) => out.has(state))
}

const declaredByState = new WeakMap<ElementStyles, Map<ElementState, DeclaredProperty[]>>()

/** The declared winners while the element is in `state`; at rest (null, undefined) that is `styles.declared`. */
export function declaredIn(styles: ElementStyles, state?: ElementState | null): DeclaredProperty[] {
  if (state === null || state === undefined) return styles.declared
  // No rule is particular to this state: it looks as it does at rest.
  if (!styles.rules.some((rule) => rule.states.length > 0 && appliesIn(rule, state))) return styles.declared
  let known = declaredByState.get(styles)
  if (known === undefined) declaredByState.set(styles, (known = new Map()))
  let declared = known.get(state)
  if (declared === undefined) known.set(state, (declared = declaredWinners(styles.rules, styles.inline, styles.layers, state)))
  return declared
}

/**
 * Whether a draft made for `draftState` decides the value shown in the view of `state`, on a row
 * whose page rule needs `ruleStates`. The draft for the very state does. Otherwise a draft shows
 * through from a weaker state (a resting edit seen under `:hover`, a `:hover` edit seen under
 * `:active`) as long as the page has no rule of its own for the stronger one, which is what the
 * stylesheet does once both edits are in the source.
 */
export function draftShowsIn(draftState: ElementState | null, state: ElementState | null, ruleStates: readonly ElementState[] = []): 'exact' | 'through' | false {
  if (draftState === state) return 'exact'
  if (draftState !== null && !activeStates(state).includes(draftState)) return false
  const own = activeStates(draftState)
  return ruleStates.every((needed) => own.includes(needed)) ? 'through' : false
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
  const authored = rules.some((rule) => rule.states.length === 0 && (rule.specificity[0] > 0 || rule.specificity[1] > 0))
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
  /** For `via: 'rule'`: the rule's whole selector list (`origin.selector` is only the part of it that matched this element). */
  ruleSelector?: string
  /** For `via: 'rule'`: the states that rule needs; empty when it is a resting rule (also when asked about a state). */
  ruleStates?: ElementState[]
  system: StylingSystem
}

/**
 * Of the declarations that set `property` (by its own name, a shorthand, a longhand, or a logical
 * property), the one that wins the cascade: importance, then inline, layers, specificity and source
 * order, and within one rule the later declaration (`padding` then `padding-left`: the latter).
 */
function decidingDeclaration(styles: Pick<ElementStyles, 'layers' | 'inline' | 'flow'>, declared: readonly DeclaredProperty[], property: string): DeclaredProperty | undefined {
  const rankOf = (entry: DeclaredProperty): CascadeRank =>
    entry.rule === undefined
      ? { inline: true, important: entry.important, layer: Infinity, specificity: [0, 0, 0], order: styles.inline.findIndex((one) => one.property === entry.property) }
      : { inline: false, important: entry.important, layer: entry.rule.layer === undefined ? Infinity : styles.layers.indexOf(entry.rule.layer), specificity: entry.rule.specificity, order: entry.rule.order }
  const placeIn = (entry: DeclaredProperty): number => (entry.rule === undefined ? -1 : entry.rule.declarations.findIndex((one) => one.property === entry.property))
  let best: DeclaredProperty | undefined
  for (const entry of declared) {
    if (entry.property !== property && !setsProperty(entry.property, property, styles.flow)) continue
    if (best === undefined) {
      best = entry
      continue
    }
    const order = compareCascade(rankOf(entry), rankOf(best))
    if (order > 0 || (order === 0 && entry.rule === best.rule && placeIn(entry) > placeIn(best))) best = entry
  }
  return best
}

/**
 * The declaration that sets `property` on the element before an edit: by its own name, through a
 * shorthand, or through its longhands. With `state`, the one that sets it while the element is in
 * that state, which is a resting rule when no rule for the state declares the property.
 */
export function originOf(styles: ElementStyles, property: string, state?: ElementState | null): PropertyOrigin {
  const declared = declaredIn(styles, state)
  // The list is sorted strongest first, so the first declaration that sets the property is the one
  // that decides: by its own name, a shorthand, a longhand, or the logical property that sets this
  // physical one (Tailwind 4's `px-4` is `padding-inline`, which decides `padding-left` over a
  // weaker `padding-left` of a component layer).
  const found = decidingDeclaration(styles, declared, property)
  const exact = found?.property === property ? found : undefined
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
  return { origin, ...(authored === undefined ? {} : { authored }), ruleSelector: rule.selector, ruleStates: rule.states, system: systemOfRule(rule, styles.tailwind) }
}

/** Custom properties declared by the rules matching the element. */
export function customPropertiesOf(styles: ElementStyles): string[] {
  const names = new Set<string>()
  for (const rule of styles.rules) for (const declaration of rule.declarations) if (declaration.property.startsWith('--')) names.add(declaration.property)
  for (const declaration of styles.inline) if (declaration.property.startsWith('--')) names.add(declaration.property)
  return [...names]
}
