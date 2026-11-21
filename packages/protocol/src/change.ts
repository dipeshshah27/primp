import { z } from 'zod'

/**
 * Recorded edits ("items"), their side effects, what is expected of the source
 * after an agent implemented them, and the result of checking that.
 *
 * The overlay creates items, the server stores them and hands them to agents,
 * and the engine (pure) renders prompts from them and judges verification.
 * Browser code imports the TYPES only, so zod stays out of the injected bundle.
 */

export const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
export type Rect = z.infer<typeof RectSchema>

// ---------------------------------------------------------------------------
// Where an element is in the source
// ---------------------------------------------------------------------------

/** Mirrors `SourceResult` of @primp/source, minus timing; see that package for the meaning of each level. */
export const SourceLocSchema = z.object({
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  component: z.string().optional(),
  framework: z.string(),
  /** `exact`: this tag, checked on disk. `file`: right file, line is a guess. `candidates`: ranked guesses. */
  level: z.enum(['exact', 'file', 'candidates']),
  verifiedOnDisk: z.boolean(),
  via: z.string(),
  /** `usage`: the element is created inside a dependency; the position is where project code uses it. */
  target: z.enum(['element', 'usage']),
  candidates: z
    .array(z.object({ file: z.string(), line: z.number(), col: z.number(), score: z.number(), why: z.array(z.string()) }))
    .optional(),
  notes: z.array(z.string()),
})
export type SourceLoc = z.infer<typeof SourceLocSchema>

// ---------------------------------------------------------------------------
// How to find an element again
// ---------------------------------------------------------------------------

/**
 * What the probe needs to re-find an element after the page re-rendered or
 * reloaded. Class names are deliberately not part of it: an agent often
 * implements a style change by changing classes.
 */
export const LocatorSchema = z.object({
  tag: z.string(),
  id: z.string().optional(),
  testId: z.string().optional(),
  role: z.string().optional(),
  accName: z.string().optional(),
  href: z.string().optional(),
  name: z.string().optional(),
  /** Own text, whitespace collapsed, at most 80 characters. */
  text: z.string().optional(),
  /** Element-child index path from <body> (first step) to the element. */
  indexPath: z.array(z.number().int().nonnegative()),
  /** Tag names from <body> to the element's parent. */
  ancestors: z.array(z.string()),
  /** Short descriptors (tag + id or own text) of the previous and next element siblings. */
  prevAnchor: z.string().optional(),
  nextAnchor: z.string().optional(),
})
export type Locator = z.infer<typeof LocatorSchema>

export const RefSchema = z.object({
  /** Session-unique id of the element as selected (`data-primp-id` while a preview is on it). */
  uid: z.string(),
  /** A CSS selector that matched exactly this element when it was recorded. For humans and agents; not used to re-find it. */
  selector: z.string(),
  tag: z.string(),
  classes: z.array(z.string()),
  /** Subtree text, whitespace collapsed, at most 80 characters. */
  text: z.string(),
  /** Short human label, for example `button.btn "Sign in"`. */
  label: z.string(),
  /** Document coordinates when recorded. */
  rect: RectSchema,
  /** How many elements come from the same source position (a list item rendered six times: 6). */
  instanceCount: z.number().int().positive(),
  source: SourceLocSchema.nullable(),
  locator: LocatorSchema,
})
export type Ref = z.infer<typeof RefSchema>

// ---------------------------------------------------------------------------
// Under which condition a style change applies
// ---------------------------------------------------------------------------

/** An interaction state a style change can be made for. */
export const ElementStateSchema = z.enum(['hover', 'focus', 'focus-visible', 'active'])
export type ElementState = z.infer<typeof ElementStateSchema>

export const ConditionSchema = z.object({
  /** Media query text of the rule the change is scoped to, exactly as authored, e.g. `(min-width: 768px)`. Absent: unconditional. */
  media: z.string().optional(),
  /**
   * The change applies only while the element is in this state (`:hover`, ...). Absent: the resting style.
   * `before` and `after` of the change, and the expectation's value, are the values IN that state.
   */
  state: ElementStateSchema.optional(),
  /** Viewport when the change was made. */
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
  colorScheme: z.enum(['light', 'dark']),
})
export type Condition = z.infer<typeof ConditionSchema>

// ---------------------------------------------------------------------------
// Side effects of one edit on the rest of the page
// ---------------------------------------------------------------------------

export const SideEffectSchema = z.object({
  /** Short label of the affected element (top-most moved ancestor when a whole subtree moved together). */
  label: z.string(),
  selector: z.string(),
  locator: LocatorSchema,
  type: z.enum(['moved', 'resized', 'overflow', 'wrapped', 'offscreen']),
  before: RectSchema,
  after: RectSchema,
  /** Elements inside `selector` that changed with it (0 when it is a single element). */
  subtreeCount: z.number().int().nonnegative(),
  /** `unwanted`: the user said this must not happen; it becomes a "must not move" constraint for the agent. */
  verdict: z.enum(['unreviewed', 'expected', 'unwanted']),
})
export type SideEffect = z.infer<typeof SideEffectSchema>

// ---------------------------------------------------------------------------
// What must be true once the source matches the edit
// ---------------------------------------------------------------------------

/** A sibling named in a reorder: enough to tell the reader which one and to find it again. */
export const SiblingAnchorSchema = z.object({
  /** Short human label, for example `li "Kiamabara"`. */
  label: z.string(),
  locator: LocatorSchema,
})
export type SiblingAnchor = z.infer<typeof SiblingAnchorSchema>

export const ExpectationSchema = z.discriminatedUnion('type', [
  /** `getComputedStyle(target)[property]` equals `value` under `condition`. */
  z.object({
    type: z.literal('computed'),
    property: z.string(),
    value: z.string(),
    condition: ConditionSchema,
  }),
  /** The target is no longer in the document. */
  z.object({ type: z.literal('absent') }),
  /** The target is in the document but takes no space and is not painted. */
  z.object({ type: z.literal('hidden') }),
  /** The element found by `locator` must be where it was before the edit, within `tolerancePx`. */
  z.object({
    type: z.literal('no-move'),
    label: z.string(),
    locator: LocatorSchema,
    rect: RectSchema,
    tolerancePx: z.number(),
  }),
  /**
   * A bystander: the element found by `locator` is styled by the rule that set the changed value
   * but is not part of the change, so its computed `property` must still be `value`.
   */
  z.object({
    type: z.literal('unchanged'),
    label: z.string(),
    selector: z.string(),
    locator: LocatorSchema,
    property: z.string(),
    value: z.string(),
  }),
  /**
   * After a reorder: these children of one parent appear in the document in exactly this order.
   * The moved element is the entry with `self`; the others are its nearest siblings (at most five
   * each side) as they should stand around it. Other nodes may lie between them.
   */
  z.object({
    type: z.literal('order'),
    siblings: z.array(SiblingAnchorSchema.extend({ self: z.boolean().optional() })).min(2).max(11),
  }),
])
export type Expectation = z.infer<typeof ExpectationSchema>

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const VerificationStatusSchema = z.enum([
  /** Every check holds. */
  'pass',
  /** The change landed with a nearby value (a design token or utility step); the agent may have done this on purpose. */
  'drift',
  /** At least one check does not hold. */
  'fail',
  /** The element could not be re-found with confidence. */
  'unresolved',
  /** No source file changed and the page did not update since the batch was claimed. */
  'no_update_observed',
  /** The dev server reports a build error. */
  'build_error',
  /** The check cannot be made in the page's current state (viewport outside the media query, for example). */
  'not_measurable',
  /** The tab was not visible, so nothing measured in it can be trusted. */
  'tab_hidden',
  /** No browser tab with the dock is connected. */
  'no_browser',
])
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>

export const CheckResultSchema = z.object({
  expectation: ExpectationSchema,
  status: z.enum(['pass', 'drift', 'fail', 'not_measurable', 'unresolved']),
  expected: z.string(),
  actual: z.string(),
  /** Numeric difference where one exists (px, or colour distance). */
  delta: z.number().optional(),
  note: z.string().optional(),
})
export type CheckResult = z.infer<typeof CheckResultSchema>

export const VerificationResultSchema = z.object({
  itemId: z.string(),
  attempt: z.number().int().positive(),
  at: z.number(),
  status: VerificationStatusSchema,
  checks: z.array(CheckResultSchema),
  /** 0-1: how sure the probe is that it measured the same element. */
  locatorConfidence: z.number().min(0).max(1).optional(),
  settle: z
    .object({
      status: z.string(),
      signal: z.string(),
      ms: z.number(),
      filesChanged: z.array(z.string()),
    })
    .optional(),
  /** One or two sentences the agent can act on. */
  hint: z.string(),
})
export type VerificationResult = z.infer<typeof VerificationResultSchema>

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ItemStatusSchema = z.enum([
  /** Being edited in the dock; not handed to anyone yet. */
  'draft',
  /** Sent by the user; waiting for an agent (or pasted as a prompt). */
  'queued',
  /** An agent fetched it and is implementing it. */
  'claimed',
  'verified',
  'failed',
  'dismissed',
])
export type ItemStatus = z.infer<typeof ItemStatusSchema>

const ItemBase = {
  id: z.string(),
  /** Monotonic within the session; orders items and the journal. */
  seq: z.number().int().nonnegative(),
  batchId: z.string().optional(),
  createdAt: z.number(),
  /** Page the edit was made on (`location.pathname + search`). */
  page: z.string(),
  /** Free text from the user, passed to the agent verbatim. */
  note: z.string().optional(),
  status: ItemStatusSchema,
  target: RefSchema,
  sideEffects: z.array(SideEffectSchema),
  /** True when the page had more elements than the side-effect check looks at. */
  sideEffectsPartial: z.boolean().optional(),
  expect: z.array(ExpectationSchema),
  verification: VerificationResultSchema.optional(),
  /** Epoch ms when an agent claimed it; the settle window is anchored here. */
  claimedAt: z.number().optional(),
  dismissReason: z.string().optional(),
}

/**
 * An element that is styled by the rule a change's previous value came from (`origin`) but is
 * not part of the change: not the target, and not one of its instances when the scope is
 * `all-instances`. It must look the same after the source was edited.
 */
export const BystanderSchema = z.object({
  /** Short human label, like `Ref.label`. */
  label: z.string(),
  /** A CSS selector that matched exactly this element when it was recorded. */
  selector: z.string(),
  locator: LocatorSchema,
  /** Computed value before the edit, per longhand of the changed property (or for the property itself when it has none). */
  values: z.record(z.string(), z.string()),
})
export type Bystander = z.infer<typeof BystanderSchema>

/** Which elements a style change is meant for. */
export const StyleScopeSchema = z.enum([
  /** Only this element. */
  'instance',
  /** Every element rendered from the same source position, or sharing the winning rule. */
  'all-instances',
])

export const StyleChangeSchema = z.object({
  ...ItemBase,
  kind: z.literal('style'),
  /** CSS property name in kebab case, shorthand or longhand, or a custom property. */
  property: z.string(),
  scope: StyleScopeSchema,
  /** `authored`: the declared value that won the cascade, when it could be read. `computed`: getComputedStyle. */
  before: z.object({ authored: z.string().optional(), computed: z.string() }),
  /** `authored`: what the user typed. `computed`: getComputedStyle with the preview applied. */
  after: z.object({ authored: z.string(), computed: z.string() }),
  /** Longhand computed values before/after, when `property` is a shorthand (padding -> padding-top, ...). */
  longhands: z.record(z.string(), z.object({ before: z.string(), after: z.string() })).optional(),
  condition: ConditionSchema,
  /** The rule that set the value before the edit, as far as the CSSOM shows it. */
  origin: z
    .object({
      /** `inline`: style attribute. `rule`: a stylesheet rule. `inherited`/`default`: nothing on the element set it. */
      via: z.enum(['inline', 'rule', 'inherited', 'default']),
      selector: z.string().optional(),
      /** Stylesheet URL or dev-server id (`data-vite-dev-id`), when known. */
      sheet: z.string().optional(),
      media: z.string().optional(),
      /** How many rendered elements outside the change this rule styles too. The true count; `bystanders` names at most three of them. */
      alsoStyles: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** Up to three of the elements counted by `origin.alsoStyles`, with the values they must keep. */
  bystanders: z.array(BystanderSchema).max(3).optional(),
  /** `tailwind`, `css-modules`, `css-in-js`, `plain-css`, `inline`, or `unknown`: how the element appears to be styled. */
  stylingSystem: z.string(),
})
export type StyleChange = z.infer<typeof StyleChangeSchema>

export const StructuralChangeSchema = z.object({
  ...ItemBase,
  kind: z.literal('structure'),
  /**
   * `remove`: delete the element from the source. `hide`: keep it in the DOM but not displayed.
   * `reorder`: the element was moved among the children of its parent; `move` says from where to where.
   */
  op: z.enum(['remove', 'hide', 'reorder']),
  /** Only with `reorder`. Indexes count the parent's element children, starting at 0. */
  move: z
    .object({
      fromIndex: z.number().int().nonnegative(),
      toIndex: z.number().int().nonnegative(),
      /** How many element children the parent has. */
      siblingCount: z.number().int().positive(),
      /** Short label of the parent, for example `ul.bean-grid`. */
      parent: z.string(),
      /** The neighbours before the move; absent at the start or the end of the parent. */
      was: z.object({ prev: SiblingAnchorSchema.optional(), next: SiblingAnchorSchema.optional() }),
      /** The neighbours after the move. */
      now: z.object({ prev: SiblingAnchorSchema.optional(), next: SiblingAnchorSchema.optional() }),
      /**
       * The siblings around the element after the move, in the wanted order: up to five before it
       * (nearest last) and five after it (nearest first). With six or fewer children on each side this
       * is the parent's whole order, which is what verification checks. Absent in items recorded
       * before it existed; verification then falls back to `now`.
       */
      around: z.object({ before: z.array(SiblingAnchorSchema).max(5), after: z.array(SiblingAnchorSchema).max(5) }).optional(),
    })
    .optional(),
})
export type StructuralChange = z.infer<typeof StructuralChangeSchema>

export const ChangeItemSchema = z.discriminatedUnion('kind', [StyleChangeSchema, StructuralChangeSchema])
export type ChangeItem = z.infer<typeof ChangeItemSchema>

/** One rendered hand-off: the items of a batch as an agent or a clipboard prompt receives them. */
export const BatchSchema = z.object({
  batchId: z.string(),
  items: z.array(ChangeItemSchema),
  /** The prompt, rendered by the engine; identical for MCP and clipboard. */
  prompt: z.string(),
})
export type Batch = z.infer<typeof BatchSchema>
