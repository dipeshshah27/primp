import { z } from 'zod'
import { ChangeItemSchema, ItemStatusSchema, VerificationResultSchema, VerificationStatusSchema, SourceLocSchema } from './change.ts'

/**
 * Session discovery and the `get_session` summary.
 *
 * A running primp process writes one session file so that `primp mcp` (the
 * stdio shim an agent spawns) can find its control endpoint. The file lives in
 * the user's home directory, never in the project.
 */

/** Bumped when the session file changes in a way older shims cannot read. */
export const SESSION_FILE_VERSION = 1

export const SessionFileSchema = z.object({
  version: z.literal(SESSION_FILE_VERSION),
  /** Process id of the long-running primp process; used to detect stale files. */
  pid: z.number().int().positive(),
  /** Absolute path of the directory primp was started for. */
  projectRoot: z.string().min(1),
  /** Loopback TCP port of the control endpoint. */
  controlPort: z.number().int().min(1).max(65535),
  /** Bearer token the control endpoint requires. Treat as a secret. */
  token: z.string().min(32),
  /** URL the developer opens in the browser (the proxy in front of the dev server). */
  proxyUrl: z.url(),
  /** ISO 8601 timestamp of process start. */
  startedAt: z.iso.datetime(),
})
export type SessionFile = z.infer<typeof SessionFileSchema>

/**
 * What `get_session` returns: enough for an agent to decide whether the other
 * tools can do anything useful right now.
 */
export const SessionSummarySchema = z.object({
  target: z.string().describe('Origin of the dev server primp is proxying, for example http://localhost:5173'),
  framework: z.string().describe('Detected framework, for example next, vite, sveltekit, static or unknown'),
  browserConnected: z
    .boolean()
    .describe('Whether a browser tab with the primp dock is attached; without one nothing can be measured'),
  counts: z
    .record(z.string(), z.number().int().nonnegative())
    .describe('Number of recorded items per status, keyed by status name'),
})
export type SessionSummary = z.infer<typeof SessionSummarySchema>

/**
 * What `get_pending_changes` returns: the changes the developer sent from the
 * dock that no agent has taken yet, ready to be implemented in source.
 */
export const PendingFileGroupSchema = z.object({
  file: z
    .string()
    .nullable()
    .describe('Project-relative source file the changes in this group belong to; null when primp could not tell where the element comes from'),
  items: z.array(ChangeItemSchema).describe('The recorded changes for this file, in the order the developer made them'),
})
export type PendingFileGroup = z.infer<typeof PendingFileGroupSchema>

export const PendingChangesSchema = z.object({
  batchIds: z.array(z.string()).describe('Ids of the batches the returned changes belong to (one per press of Send in the dock)'),
  count: z.number().int().nonnegative().describe('Number of changes returned; 0 means nothing is waiting'),
  files: z.array(PendingFileGroupSchema).describe('The changes grouped by source file'),
  prompt: z.string().describe('The same changes written out as instructions; empty when nothing is waiting'),
  claimedAt: z
    .number()
    .nullable()
    .describe('Epoch milliseconds at which these changes were handed to the caller; null when nothing was handed over'),
})
export type PendingChanges = z.infer<typeof PendingChangesSchema>

/** What `dismiss_change` returns. */
export const DismissChangeResultSchema = z.object({
  id: z.string(),
  dismissed: z.boolean().describe('True when the change is now closed'),
  status: ItemStatusSchema.nullable().describe('Status of the change after the call; null when no change has this id'),
  message: z.string().describe('One sentence saying what happened'),
})
export type DismissChangeResult = z.infer<typeof DismissChangeResultSchema>

/** What `verify_changes` returns. */
export const VerifyChangesResultSchema = z.object({
  results: z.array(VerificationResultSchema).describe('One result per verified change: status, each check with expected and actual values, and a hint'),
  counts: z
    .partialRecord(VerificationStatusSchema, z.number().int().nonnegative())
    .describe('Number of results per status'),
  fixup: z.string().describe('What did not pass, written out as instructions for the next pass; empty when everything passed'),
  summary: z.string().describe('One sentence saying what was verified and how it went'),
})
export type VerifyChangesResult = z.infer<typeof VerifyChangesResultSchema>

/** What `get_layout_shifts` returns. */
export const LayoutShiftsResultSchema = z.object({
  status: z
    .enum(['ok', 'tab_hidden', 'not_measurable', 'no_report'])
    .describe('ok: measured, and an empty issues list then means no shifts. Anything else: not measured, see message'),
  url: z.string().nullable().describe('Page the shifts were measured on'),
  cls: z.number().nullable().describe('Cumulative Layout Shift of that page load; a page should stay under 0.1. Null when not measured'),
  issues: z.array(
    z.object({
      id: z.string(),
      value: z.number().describe('Layout-shift score of this issue'),
      cause: z.enum(['unsized-media', 'font-swap', 'injected-content', 'dev-artifact', 'unknown']),
      confidence: z.number().describe('0 to 1; 0.7 and above only when the culprit explains the movement geometrically'),
      culprit: z.object({ label: z.string(), selector: z.string() }).nullable().describe('The element that caused the shift; null when none could be named'),
      source: SourceLocSchema.nullable().describe('Where the culprit is in the source, when primp could find it'),
      moved: z.array(z.string()).describe('The elements that moved'),
      evidence: z.array(z.string()),
    }),
  ),
  prompt: z.string().describe('The shifts with a known cause, written out as instructions; empty when there is none'),
  message: z.string().describe('One sentence saying what was measured'),
})
export type LayoutShiftsResult = z.infer<typeof LayoutShiftsResultSchema>

/** What `verify_layout_shift` returns. */
export const ShiftVerificationSchema = z.object({
  id: z.string(),
  status: z
    .enum(['pass', 'fail', 'tab_hidden', 'no_browser', 'not_measurable', 'unknown_id'])
    .describe('pass: the shift did not come back in any reload. fail: it did. Anything else: it could not be measured, which is not a pass'),
  before: z.number().nullable().describe('Score of the issue when it was reported'),
  replays: z.array(
    z.object({
      load: z.number().int(),
      status: z.enum(['ok', 'tab_hidden', 'not_measurable', 'no_browser', 'no_report']),
      cls: z.number().nullable().describe('CLS of the page in this reload'),
      remaining: z.number().nullable().describe('Score of what is left of the issue in this reload'),
      cached: z.array(z.string()).describe('Resources that came from the browser cache anyway; non-empty means this reload was not fully cold'),
    }),
  ),
  hint: z.string().describe('What the result means and what to do next'),
})
export type ShiftVerificationResult = z.infer<typeof ShiftVerificationSchema>
