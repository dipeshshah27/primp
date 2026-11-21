/**
 * Describing an element (`Ref`, `Locator`) and finding it again after the page re-rendered.
 *
 * Everything here reads the DOM and writes nothing. The scoring that decides whether a
 * candidate is "the same element" is the engine's (packages/engine/src/locator.ts, pure); this
 * module describes the candidates and adds one guard of its own (see `contradicts`).
 */

import { MIN_CONFIDENCE, pickBest, scoreCandidate, textSimilarity } from '@primp/engine/locator'
import type { Locator, Rect, Ref, SourceLoc } from '@primp/protocol/change'
import { composeSelector, type SelectorStep } from './selector.ts'
import { OVERLAY_ROOT_ATTR } from './snapshot.ts'

/** The attribute a previewed element carries; its value is the element's uid. */
export const MARK_ATTR = 'data-primp-id'

const TEXT_MAX = 80

/** Whether `node` is the dock's host or inside it. */
export function isOwn(node: Node | null): boolean {
  for (let current: Node | null = node; current !== null; ) {
    if (current.nodeType === 1 && (current as Element).hasAttribute(OVERLAY_ROOT_ATTR)) return true
    const parent: Node | null = current.parentNode
    current = parent !== null && parent.nodeType === 11 && (parent as ShadowRoot).host !== undefined ? (parent as ShadowRoot).host : parent
  }
  return false
}

export function collapse(text: string, max = TEXT_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) : clean
}

/** Text of the element's own text nodes. */
export function ownText(el: Element, max = TEXT_MAX): string {
  let out = ''
  for (let node = el.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 3) out += ` ${(node as Text).data}`
  }
  return collapse(out, max)
}

/** Text of the subtree, reading no more nodes than needed for `max` characters. */
export function subtreeText(el: Element, max = TEXT_MAX): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let out = ''
  let budget = 200
  for (let node = walker.nextNode(); node !== null && budget-- > 0; node = walker.nextNode()) {
    const tag = node.parentElement?.localName
    if (tag === 'script' || tag === 'style' || tag === 'noscript') continue
    const data = (node as Text).data
    if (data.trim() === '') continue
    out += ` ${data}`
    if (out.length > max * 2) break
  }
  return collapse(out, max)
}

// ---------------------------------------------------------------------------
// Role and name, cheaply
// ---------------------------------------------------------------------------

const TAG_ROLE: Record<string, string> = {
  article: 'article',
  aside: 'complementary',
  button: 'button',
  dialog: 'dialog',
  fieldset: 'group',
  figure: 'figure',
  footer: 'contentinfo',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  header: 'banner',
  hr: 'separator',
  li: 'listitem',
  main: 'main',
  nav: 'navigation',
  ol: 'list',
  option: 'option',
  output: 'status',
  p: 'paragraph',
  progress: 'progressbar',
  select: 'combobox',
  summary: 'button',
  table: 'table',
  td: 'cell',
  textarea: 'textbox',
  th: 'columnheader',
  tr: 'row',
  ul: 'list',
}

const INPUT_ROLE: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  image: 'button',
  number: 'spinbutton',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
}

/** The explicit `role`, or the implicit one of the tag. Not the full ARIA mapping: enough to tell elements apart. */
export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]
  if (explicit !== undefined && explicit !== '') return explicit
  const tag = el.localName
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : undefined
  if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img'
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase()
    return type === 'hidden' ? undefined : (INPUT_ROLE[type] ?? 'textbox')
  }
  if (tag === 'section') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : undefined
  return TAG_ROLE[tag]
}

/**
 * A name for the element: `aria-label`, the text of `aria-labelledby`, `alt`, the form label,
 * the placeholder, or the start of its text. The last one goes beyond ARIA's naming rules on
 * purpose: a card is told from its siblings by what it says.
 */
export function accNameOf(el: Element): string | undefined {
  const label = el.getAttribute('aria-label')
  if (label !== null && label.trim() !== '') return collapse(label)
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const root = el.getRootNode() as Document | ShadowRoot
    const text = labelledBy
      .split(/\s+/)
      .map((id) => (id === '' ? '' : (root.getElementById?.(id)?.textContent ?? '')))
      .join(' ')
    if (text.trim() !== '') return collapse(text)
  }
  const tag = el.localName
  if (tag === 'img' || tag === 'area') {
    const alt = el.getAttribute('alt')
    if (alt !== null && alt !== '') return collapse(alt)
  }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const labels = (el as HTMLInputElement).labels
    const text = labels !== null && labels.length > 0 ? (labels[0]?.textContent ?? '') : ''
    if (text.trim() !== '') return collapse(text)
    const placeholder = el.getAttribute('placeholder') ?? el.getAttribute('title')
    if (placeholder !== null && placeholder.trim() !== '') return collapse(placeholder)
    return undefined
  }
  const text = subtreeText(el)
  if (text !== '') return text
  const title = el.getAttribute('title')
  return title !== null && title.trim() !== '' ? collapse(title) : undefined
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

interface PathInfo {
  indexPath: number[]
  ancestors: string[]
}
export type PathCache = Map<Element, PathInfo>

/** Index path and ancestor tags, from `<body>` down. Parents are computed once per cache. */
function pathInfo(el: Element, cache?: PathCache): PathInfo {
  const known = cache?.get(el)
  if (known !== undefined) return known
  const parent = el.parentElement
  let info: PathInfo
  if (parent === null || el.localName === 'body') {
    info = { indexPath: [], ancestors: [] }
  } else {
    const up = pathInfo(parent, cache)
    let index = 0
    for (let sibling = el.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) index++
    info = { indexPath: [...up.indexPath, index], ancestors: [...up.ancestors, parent.localName] }
  }
  cache?.set(el, info)
  return info
}

function anchorOf(el: Element | null): string | undefined {
  if (el === null || isOwnHost(el)) return undefined
  if (el.id !== '') return `${el.localName}#${el.id}`
  const text = ownText(el, 30)
  return text === '' ? el.localName : `${el.localName} "${text}"`
}

const isOwnHost = (el: Element): boolean => el.hasAttribute(OVERLAY_ROOT_ATTR)

export function locatorOf(el: Element, cache?: PathCache): Locator {
  const { indexPath, ancestors } = pathInfo(el, cache)
  const locator: Locator = { tag: el.localName, indexPath, ancestors }
  if (el.id !== '') locator.id = el.id
  const testId = el.getAttribute('data-testid')
  if (testId !== null && testId !== '') locator.testId = testId
  const role = roleOf(el)
  if (role !== undefined) locator.role = role
  const accName = accNameOf(el)
  if (accName !== undefined) locator.accName = accName
  const href = el.getAttribute('href')
  if (href !== null && href !== '') locator.href = href.slice(0, 300)
  const name = el.getAttribute('name')
  if (name !== null && name !== '') locator.name = name
  const text = ownText(el)
  if (text !== '') locator.text = text
  const prev = anchorOf(el.previousElementSibling)
  if (prev !== undefined) locator.prevAnchor = prev
  const next = anchorOf(el.nextElementSibling)
  if (next !== undefined) locator.nextAnchor = next
  return locator
}

// ---------------------------------------------------------------------------
// Selector, label, rect
// ---------------------------------------------------------------------------

/** A CSS selector that matches exactly this element now. */
export function buildSelector(el: Element): string {
  const doc = el.ownerDocument
  if (el === doc.body) return 'body'
  if (el === doc.documentElement) return 'html'
  const steps: SelectorStep[] = []
  for (let current: Element | null = el; current !== null && current !== doc.body && current !== doc.documentElement; current = current.parentElement) {
    const tag = current.localName
    let nth = 1
    let twins = 0
    const parent: Element | null = current.parentElement
    if (parent !== null) {
      let before = true
      for (let child: Element | null = parent.firstElementChild; child !== null; child = child.nextElementSibling) {
        if (child === current) before = false
        else if (child.localName === tag) {
          twins++
          if (before) nth++
        }
      }
    }
    const step: SelectorStep = { tag: CSS.escape(tag), nthOfType: nth, hasTwin: twins > 0 }
    if (current.id !== '') step.id = current.id
    const testId = current.getAttribute('data-testid')
    if (testId !== null && testId !== '') step.testId = testId
    steps.push(step)
  }
  const root = el.getRootNode() as Document | ShadowRoot
  return composeSelector(steps, (selector) => {
    try {
      const found = root.querySelectorAll(selector)
      return found.length === 1 && found[0] === el
    } catch {
      return false
    }
  })
}

/** Hashed class names of CSS modules, reduced to the name the author wrote. */
export function readableClass(name: string): string {
  const vite = /^_([A-Za-z][\w-]*?)_[A-Za-z0-9]{4,8}_\d+$/.exec(name)
  if (vite !== null) return vite[1]!
  const next = /^[\w-]+-module__[\w-]{4,}__([A-Za-z][\w-]*)$/.exec(name)
  if (next !== null) return next[1]!
  const webpack = /^[A-Za-z][\w-]*_([A-Za-z][\w-]*?)__[\w-]{5,}$/.exec(name)
  if (webpack !== null) return webpack[1]!
  return name
}

/** `button.btn "Sign in"` */
export function labelOf(el: Element): string {
  let out = el.localName
  if (el.id !== '') out += `#${el.id}`
  else {
    const first = el.classList[0]
    if (first !== undefined) out += `.${readableClass(first)}`
  }
  const text = subtreeText(el, 28)
  return text === '' ? out : `${out} "${text}"`
}

const half = (n: number): number => Math.round(n * 2) / 2

/** Border box in document coordinates, rounded to half pixels like the geometry snapshot. */
export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView ?? window
  return { x: half(r.left + view.scrollX), y: half(r.top + view.scrollY), w: half(r.width), h: half(r.height) }
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

const classKey = (el: Element): string => [...el.classList].sort().join(' ')

/**
 * The elements rendered from the same place as `el`, as far as the DOM shows it: same tag,
 * the same set of classes, under parents with the same tag path. Always contains `el`.
 * An element with an id is its only instance.
 */
export function instancesOf(el: Element): Element[] {
  if (el.id !== '' || !el.isConnected) return [el]
  const key = classKey(el)
  const cache: PathCache = new Map()
  const path = pathInfo(el, cache).ancestors.join('>')
  const out: Element[] = []
  for (const candidate of el.ownerDocument.getElementsByTagName(el.localName)) {
    if (candidate !== el) {
      if (candidate.id !== '' || candidate.classList.length !== el.classList.length || classKey(candidate) !== key) continue
      if (pathInfo(candidate, cache).ancestors.join('>') !== path || isOwnHost(candidate)) continue
    }
    out.push(candidate)
  }
  return out
}

// ---------------------------------------------------------------------------
// Uid and Ref
// ---------------------------------------------------------------------------

const uids = new WeakMap<Element, string>()
const byUid = new Map<string, WeakRef<Element>>()
let uidPrefix = 'e'
let uidCounter = 0

/** Makes uids unique across the documents of one session (the dock passes the document id). */
export function setUidPrefix(prefix: string): void {
  uidPrefix = prefix
}

/** The element's session-unique id: its mark when it has one, otherwise a new id kept off the DOM. */
export function uidOf(el: Element): string {
  const marked = el.getAttribute(MARK_ATTR)
  if (marked !== null && marked !== '') {
    adoptUid(el, marked)
    return marked
  }
  let uid = uids.get(el)
  if (uid === undefined) adoptUid(el, (uid = `${uidPrefix}${(++uidCounter).toString(36)}`))
  return uid
}

/** Gives `el` a known uid (an element found again for a recorded item keeps the item's uid). */
export function adoptUid(el: Element, uid: string): void {
  if (uids.get(el) === uid) return
  uids.set(el, uid)
  byUid.set(uid, new WeakRef(el))
}

/** The element that was last known under `uid`, if it still exists; it may have left the document. */
export function elementOfUid(uid: string): Element | null {
  return byUid.get(uid)?.deref() ?? null
}

export function buildRef(el: Element, source: SourceLoc | null = null): Ref {
  return {
    uid: uidOf(el),
    selector: buildSelector(el),
    tag: el.localName,
    classes: [...el.classList],
    text: subtreeText(el),
    label: labelOf(el),
    rect: rectOf(el),
    instanceCount: instancesOf(el).length,
    source,
    locator: locatorOf(el),
  }
}

// ---------------------------------------------------------------------------
// Finding an element again
// ---------------------------------------------------------------------------

export interface LocateResult {
  /** Null when no candidate is good enough or two are too close to call. */
  element: Element | null
  /** 0 to 1: score of the best candidate, also when it was not accepted. */
  confidence: number
  candidates: number
  /**
   * Why no element is returned. `none`: nothing with that tag. `weak`: the best candidate scores
   * below the engine's minimum. `different-content`: the best candidate says something else
   * (see `contradicts`). `ambiguous`: a candidate is good enough but another is as good, so the
   * element may well be there.
   */
  reason?: 'none' | 'weak' | 'ambiguous' | 'different-content'
}

/** Chooses among described candidates. The default is the engine's `pickBest`. */
export type LocatorPicker = (
  want: Locator,
  candidates: readonly Locator[],
  options: { anyInstance?: boolean },
) => { index: number; confidence: number } | null

export interface LocateOptions {
  picker?: LocatorPicker
  document?: Document
  /** Accept a tie between equivalent instances (for an edit that applies to all of them). */
  anyInstance?: boolean
}

const wordCount = (text: string): number => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length

/**
 * Whether `got` says something else than the recorded element did.
 *
 * The engine's score lets structure outvote content: when a list item is removed, the next
 * item slides into its place and scores high on position alone. An element that was recorded
 * with a text or name of two words or more, and now shows next to none of it, is treated as a
 * different element unless its id or test id says otherwise. (One-word texts are exempt: a
 * counter that went from 3 to 4 is still the counter.)
 */
export function contradicts(want: Locator, got: Locator): boolean {
  if (want.id !== undefined && want.id === got.id) return false
  if (want.testId !== undefined && want.testId === got.testId) return false
  const similarities: number[] = []
  if (want.text !== undefined && wordCount(want.text) >= 2) similarities.push(textSimilarity(want.text, got.text ?? ''))
  if (want.accName !== undefined && wordCount(want.accName) >= 2) similarities.push(textSimilarity(want.accName, got.accName ?? ''))
  return similarities.length > 0 && Math.max(...similarities) < 0.3
}

/** Finds the element a locator was recorded for, without looking at class names. */
export function locate(want: Locator, options: LocateOptions = {}): LocateResult {
  const doc = options.document ?? document
  const picker: LocatorPicker = options.picker ?? pickBest
  const cache: PathCache = new Map()
  const elements: Element[] = []
  const candidates: Locator[] = []
  // The dock's host is a child of <html> and its inside is a shadow tree, which this does not reach.
  for (const candidate of doc.getElementsByTagName(want.tag)) {
    if (isOwnHost(candidate)) continue
    elements.push(candidate)
    candidates.push(locatorOf(candidate, cache))
  }
  if (elements.length === 0) return { element: null, confidence: 0, candidates: 0, reason: 'none' }
  const picked = picker(want, candidates, options.anyInstance === true ? { anyInstance: true } : {})
  if (picked === null) {
    let best = 0
    for (const candidate of candidates) best = Math.max(best, scoreCandidate(want, candidate))
    return { element: null, confidence: best, candidates: elements.length, reason: best >= MIN_CONFIDENCE ? 'ambiguous' : 'weak' }
  }
  const chosen = candidates[picked.index]
  const element = elements[picked.index]
  if (chosen === undefined || element === undefined) return { element: null, confidence: 0, candidates: elements.length, reason: 'none' }
  if (contradicts(want, chosen)) return { element: null, confidence: picked.confidence, candidates: elements.length, reason: 'different-content' }
  return { element, confidence: picked.confidence, candidates: elements.length }
}
