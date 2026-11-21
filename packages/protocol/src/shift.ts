import { z } from 'zod'

/**
 * Layout-shift data: what the injected hook records in the page (`ShiftRecording`)
 * and what the attributor in `packages/engine` makes of it (`ShiftReport`).
 *
 * All times are `performance.now()` values of the page (milliseconds since
 * navigation start). All rectangles are in viewport CSS pixels, as the Layout
 * Instability API reports them.
 */

export const SHIFT_RECORDING_VERSION = 1

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})
export type ShiftRect = z.infer<typeof RectSchema>

export const SizeSchema = z.object({ w: z.number(), h: z.number() })
export type ShiftSize = z.infer<typeof SizeSchema>

/**
 * How to find a node again, captured at the moment something happened to it.
 * The node itself may be gone a frame later.
 */
export const NodeDescriptorSchema = z.object({
  /** Number the hook gave this node; the same node keeps it for the life of the document. */
  uid: z.number().int(),
  /** Lower-case tag name; `#text` for a text node. */
  tag: z.string(),
  id: z.string().optional(),
  /** Up to four class names. */
  classes: z.array(z.string()).optional(),
  /**
   * Index among the parent's element children at every level from `<html>` down.
   * Comparing two paths lexicographically gives document order; a prefix is an ancestor.
   * A text node carries its parent's path. Empty when the node was detached.
   */
  path: z.array(z.number().int()),
  /** Short CSS selector, anchored at the nearest ancestor with an id. */
  selector: z.string(),
  /** Start of the text content, whitespace collapsed. */
  text: z.string().optional(),
  /** A few attributes that identify resources and dev tooling: src, href, rel, data-vite-dev-id. */
  attrs: z.record(z.string(), z.string()).optional(),
})
export type NodeDescriptor = z.infer<typeof NodeDescriptorSchema>

/** Layout facts of an element read while layout was clean (inside an observer callback). */
export const NodeStyleSchema = z.object({
  position: z.string(),
  display: z.string(),
  float: z.string().optional(),
  /** Computed `font-family` list as the browser serialises it. */
  fontFamily: z.string().optional(),
  /** Used margins in px: top, right, bottom, left. */
  margin: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
})
export type NodeStyle = z.infer<typeof NodeStyleSchema>

/** Whether a replaced element had its space reserved before its content arrived. */
export const MediaHintsSchema = z.object({
  widthAttr: z.boolean(),
  heightAttr: z.boolean(),
  /** Computed (not used) values: `auto` means nothing was specified. */
  cssWidth: z.string(),
  cssHeight: z.string(),
  aspectRatio: z.string(),
})
export type MediaHints = z.infer<typeof MediaHintsSchema>

export const ShiftSourceSchema = z.object({
  /** Null when the browser gave no node (user-agent shadow tree, or already removed). */
  node: NodeDescriptorSchema.nullable(),
  previousRect: RectSchema,
  currentRect: RectSchema,
  style: NodeStyleSchema.optional(),
})
export type ShiftSource = z.infer<typeof ShiftSourceSchema>

export const ShiftEntrySchema = z.object({
  /** Position in the recording. */
  index: z.number().int(),
  value: z.number(),
  startTime: z.number(),
  hadRecentInput: z.boolean(),
  lastInputTime: z.number(),
  sources: z.array(ShiftSourceSchema),
  /** Set when the entry started within the self-mark window of a `markSelf` call. */
  selfInduced: z.object({ reason: z.string(), markedAt: z.number() }).optional(),
  /** `document.visibilityState` when the entry was delivered. */
  visibility: z.string(),
  deliveredAt: z.number(),
})
export type ShiftEntry = z.infer<typeof ShiftEntrySchema>

/** One change of an element's border-box size, from the hook's ResizeObserver. */
export const ResizeRecordSchema = z.object({
  t: z.number(),
  node: NodeDescriptorSchema,
  /** Size before the change. Null when the element was first measured after being inserted late. */
  before: SizeSchema.nullable(),
  after: SizeSchema,
  /** Viewport rectangle right after the change. */
  rect: RectSchema.optional(),
  style: NodeStyleSchema.optional(),
  media: MediaHintsSchema.optional(),
})
export type ResizeRecord = z.infer<typeof ResizeRecordSchema>

export const MutationKindSchema = z.enum(['add', 'remove', 'attr', 'text'])
export const MutationRecordSchema = z.object({
  t: z.number(),
  kind: MutationKindSchema,
  /** The added or removed node, or the element whose attribute or text changed. */
  node: NodeDescriptorSchema,
  /** Parent the node was added to or removed from. */
  parent: NodeDescriptorSchema.optional(),
  attr: z.string().optional(),
  oldValue: z.string().optional(),
  value: z.string().optional(),
  /** For a removal: the node's last measured size, when it was being tracked. */
  lastSize: SizeSchema.optional(),
  /** JavaScript stack of the DOM call, only when the hook was built with stack capture. */
  stack: z.string().optional(),
  /** Nodes of the same batch that were not recorded one by one. */
  more: z.number().int().optional(),
})
export type ShiftMutationRecord = z.infer<typeof MutationRecordSchema>

export const MediaEventSchema = z.object({
  t: z.number(),
  event: z.string(),
  node: NodeDescriptorSchema,
  url: z.string(),
  /** Intrinsic size of the loaded resource. */
  natural: SizeSchema.optional(),
  /** Last measured rendered size at the time of the event. */
  size: SizeSchema.optional(),
  hints: MediaHintsSchema.optional(),
})
export type MediaEvent = z.infer<typeof MediaEventSchema>

export const ResourceRecordSchema = z.object({
  url: z.string(),
  /** `initiatorType` of the resource timing entry: `img`, `css`, `script`, `fetch`, `link`, `video`, `iframe`, ... */
  initiator: z.string(),
  start: z.number(),
  end: z.number(),
  /** 0 for a cache hit or a cross-origin resource without Timing-Allow-Origin. */
  transferSize: z.number(),
})
export type ResourceRecord = z.infer<typeof ResourceRecordSchema>

export const FontRecordSchema = z.object({
  /** When the hook learned about it. */
  t: z.number(),
  /** Start of the interval in which it happened, when found by comparing two snapshots of `document.fonts`. */
  since: z.number().optional(),
  event: z.enum(['loading', 'loaded', 'error']),
  family: z.string(),
  weight: z.string().optional(),
  style: z.string().optional(),
  /** `event` (FontFaceSet event) or `snapshot` (difference between two reads of `document.fonts`). */
  via: z.enum(['event', 'snapshot']),
})
export type FontRecord = z.infer<typeof FontRecordSchema>

export const VisibilitySchema = z.object({
  /** `document.visibilityState` when the hook ran. */
  initial: z.string(),
  /** State at navigation start as the browser's own `visibility-state` entry reports it, when available. */
  atNavigationStart: z.string().optional(),
  /** Every change the hook saw, and every one the browser recorded before the hook ran. */
  changes: z.array(z.object({ t: z.number(), state: z.string() })),
  /** The document was prerendered, or restored from the back/forward cache. */
  prerendered: z.boolean(),
  restored: z.boolean(),
  /**
   * The validity flag: `document.visibilityState` was `visible` from navigation start until this
   * copy of the recording was made. When false the recording is not a measurement of layout
   * shifts: a hidden tab renders no frames and reports none, however the page behaves.
   */
  visibleThroughout: z.boolean(),
})
export type VisibilityRecord = z.infer<typeof VisibilitySchema>

export const HookCostSchema = z.object({
  /** Synchronous top-level run of the hook script. */
  topLevelMs: z.number(),
  /** Time inside each of the hook's callbacks so far. */
  shiftMs: z.number(),
  mutationMs: z.number(),
  resizeMs: z.number(),
  otherMs: z.number(),
  mutationCallbacks: z.number().int(),
  resizeCallbacks: z.number().int(),
  /** Elements under size observation. */
  tracked: z.number().int(),
  /** Elements seen but not tracked because the cap was reached. */
  untracked: z.number().int(),
})
export type HookCost = z.infer<typeof HookCostSchema>

export const ShiftRecordingSchema = z.object({
  version: z.literal(SHIFT_RECORDING_VERSION),
  url: z.string(),
  /** `performance.now()` when this copy of the recording was made: the end of the measured window. */
  capturedAt: z.number(),
  hookStartedAt: z.number(),
  /** False when the browser has no `layout-shift` entry type (anything but Chromium). */
  supported: z.boolean(),
  viewport: z.object({ width: z.number(), height: z.number(), dpr: z.number() }),
  viewportChanges: z.array(z.object({ t: z.number(), width: z.number(), height: z.number() })),
  scroll: z.object({ x: z.number(), y: z.number() }),
  scrolls: z.array(z.object({ t: z.number(), x: z.number(), y: z.number() })),
  navigation: z.object({
    type: z.string(),
    domInteractive: z.number(),
    domContentLoaded: z.number(),
    load: z.number(),
    firstPaint: z.number().optional(),
    firstContentfulPaint: z.number().optional(),
    /** First animation frame the hook saw; mutations before it are not recorded one by one. */
    firstFrame: z.number().optional(),
  }),
  visibility: VisibilitySchema,
  shifts: z.array(ShiftEntrySchema),
  resizes: z.array(ResizeRecordSchema),
  mutations: z.array(MutationRecordSchema),
  media: z.array(MediaEventSchema),
  resources: z.array(ResourceRecordSchema),
  fonts: z.array(FontRecordSchema),
  selfMarks: z.array(z.object({ t: z.number(), reason: z.string() })),
  /** Records dropped from each ring buffer because it was full. */
  dropped: z.object({
    shifts: z.number().int(),
    resizes: z.number().int(),
    mutations: z.number().int(),
    media: z.number().int(),
    resources: z.number().int(),
  }),
  cost: HookCostSchema,
})
export type ShiftRecording = z.infer<typeof ShiftRecordingSchema>

// ---------------------------------------------------------------------------
// Attribution result
// ---------------------------------------------------------------------------

export const ShiftCauseSchema = z.enum(['unsized-media', 'font-swap', 'injected-content', 'dev-artifact', 'unknown'])
export type ShiftCause = z.infer<typeof ShiftCauseSchema>

export const ShiftVictimSchema = z.object({
  node: NodeDescriptorSchema.nullable(),
  previousRect: RectSchema,
  currentRect: RectSchema,
  /** Movement of the start corner in px. */
  dx: z.number(),
  dy: z.number(),
  /** Whether the culprit explains this victim's movement: directly, as reflow inside the culprit, or not. */
  explained: z.enum(['direct', 'inside', 'no']),
})
export type ShiftVictim = z.infer<typeof ShiftVictimSchema>

export const ShiftCulpritSchema = z.object({
  node: NodeDescriptorSchema,
  /** Null: the element did not exist or had no box. */
  sizeBefore: SizeSchema.nullable(),
  sizeAfter: SizeSchema,
  rect: RectSchema.optional(),
  media: MediaHintsSchema.optional(),
})
export type ShiftCulprit = z.infer<typeof ShiftCulpritSchema>

export const ShiftTriggerSchema = z.object({
  kind: z.enum(['resource', 'font', 'mutation', 'self']),
  /** Resource URL (image, font file, script). */
  url: z.string().optional(),
  family: z.string().optional(),
  /** Stack of the DOM call that inserted or changed the culprit, when captured. */
  stack: z.string().optional(),
  detail: z.string().optional(),
  t: z.number().optional(),
})
export type ShiftTrigger = z.infer<typeof ShiftTriggerSchema>

export const ShiftIssueSchema = z.object({
  id: z.string(),
  /** Indexes of the recording's entries that this issue covers (one per frame). */
  entries: z.array(z.number().int()),
  startTime: z.number(),
  endTime: z.number(),
  /** Sum of the entries' values. */
  value: z.number(),
  /** Index into `ShiftReport.windows`; absent for excluded issues. */
  window: z.number().int().optional(),
  cause: ShiftCauseSchema,
  /** 0 to 1. At or above 0.7 only with a geometric match. */
  confidence: z.number().min(0).max(1),
  /** The culprit's change in size accounts for the victims' movement. */
  geometricMatch: z.boolean(),
  /** Absent when nothing explains the movement well enough to name. */
  culprit: ShiftCulpritSchema.optional(),
  /** Other elements that changed in the same frame and were needed, with the culprit, to account for the movement. */
  coCulprits: z.array(ShiftCulpritSchema).optional(),
  trigger: ShiftTriggerSchema.optional(),
  victims: z.array(ShiftVictimSchema),
  evidence: z.array(z.string()),
  /** Whether the issue counts towards the score. */
  scored: z.boolean(),
  excluded: z.enum(['recent-input', 'self-induced', 'dev-artifact']).optional(),
})
export type ShiftIssue = z.infer<typeof ShiftIssueSchema>

export const SessionWindowSchema = z.object({
  start: z.number(),
  end: z.number(),
  value: z.number(),
  entries: z.array(z.number().int()),
})
export type SessionWindow = z.infer<typeof SessionWindowSchema>

/**
 * `ok`: measured; `issues` may be empty and that means no shifts.
 * `tab_hidden`: the tab was not visible for the whole window, so the absence of entries proves nothing.
 * `not_measurable`: the browser has no Layout Instability API, or the recording is unusable.
 */
export const ShiftStatusSchema = z.enum(['ok', 'tab_hidden', 'not_measurable'])
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>

export const ShiftReportSchema = z.object({
  status: ShiftStatusSchema,
  reason: z.string().optional(),
  /** Largest session window; the page's CLS so far. Null unless `status` is `ok`. */
  cls: z.number().nullable(),
  windows: z.array(SessionWindowSchema),
  /** Scored issues, largest value first, then excluded ones. */
  issues: z.array(ShiftIssueSchema),
  /** Same-origin resources the page got from a cache (path and query). Non-empty: this was not a cold load. */
  cachedResources: z.array(z.string()),
  /** Entries delivered while a ring buffer had already dropped evidence, and similar caveats. */
  notes: z.array(z.string()),
})
export type ShiftReport = z.infer<typeof ShiftReportSchema>
