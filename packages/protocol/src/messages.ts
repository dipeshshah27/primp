import { z } from 'zod'
import { BatchSchema, ChangeItemSchema, CheckResultSchema, ExpectationSchema, LocatorSchema, SourceLocSchema } from './change.ts'
import { ShiftRecordingSchema, ShiftReportSchema } from './shift.ts'

/**
 * Messages on the overlay socket (`OVERLAY_SOCKET_PATH`), JSON text frames.
 *
 * One socket per document carries two families, told apart by the `type`
 * prefix: `settle:*` (see packages/server/src/settle.ts; the settle detector
 * reads those itself) and `session:*` (this file). Either side ignores types
 * it does not know, so the two ends can be different versions.
 *
 * Requests carry a `reqId` chosen by the sender; the answer repeats it.
 */

/** Everything primp serves lives under this prefix on the proxy origin. */
export const RESERVED_PREFIX = '/__primp/'
export const OVERLAY_SOCKET_PATH = '/__primp/ws'
/** Synchronous head script: layout-shift hook, settle client, socket; then loads the overlay. */
export const HOOK_ASSET_PATH = '/__primp/hook.js'
/** The dock (probe + UI), loaded by the hook after DOMContentLoaded. */
export const OVERLAY_ASSET_PATH = '/__primp/overlay.js'

export const SessionInfoSchema = z.object({
  /** Origin of the dev server behind the proxy. */
  target: z.string(),
  framework: z.string(),
  /** Last path segment of the project directory, for the dock's title. */
  projectName: z.string(),
  version: z.string(),
  /** An agent is waiting for the next Send (MCP `wait_for_changes`): what is sent now goes straight to it. */
  agentWaiting: z.boolean().optional(),
})
export type SessionInfo = z.infer<typeof SessionInfoSchema>

// ---------------------------------------------------------------------------
// Browser -> server
// ---------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session:hello'),
    /** Random id of the document; the same one the settle client uses. */
    doc: z.string(),
    url: z.string(),
    viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
    visible: z.boolean(),
  }),
  /** Ask where an element comes from. `evidence` is what @primp/source's collectEvidence returned. */
  z.object({ type: z.literal('session:resolve'), reqId: z.string(), evidence: z.unknown() }),
  /** Create or replace a draft item (the dock is the only writer of drafts). */
  z.object({ type: z.literal('session:upsert'), item: ChangeItemSchema }),
  /** Drop a draft item (undo, or the user removed it from the tray). */
  z.object({ type: z.literal('session:delete'), id: z.string() }),
  /** The user pressed Send: queue these drafts as one batch and return the prompt. */
  z.object({ type: z.literal('session:send'), reqId: z.string(), ids: z.array(z.string()) }),
  /** The user pressed Copy: render the prompt these drafts would get, without queueing them. */
  z.object({ type: z.literal('session:prompt'), reqId: z.string(), ids: z.array(z.string()) }),
  /** Everything the hook recorded about layout shifts for this document so far. */
  z.object({ type: z.literal('session:shifts'), doc: z.string(), recording: ShiftRecordingSchema }),
  /** Answer to `session:measure`. */
  z.object({
    type: z.literal('session:measured'),
    reqId: z.string(),
    visible: z.boolean(),
    results: z.array(
      z.object({
        itemId: z.string(),
        /** 0-1; below the probe's margin the element counts as not found. */
        locatorConfidence: z.number(),
        found: z.boolean(),
        checks: z.array(CheckResultSchema),
      }),
    ),
  }),
  /** The user asked for the items to be checked again from the dock. */
  z.object({ type: z.literal('session:reverify'), ids: z.array(z.string()) }),
  /** The tab became visible or hidden; a measurement taken while hidden is not trusted. */
  z.object({ type: z.literal('session:visibility'), doc: z.string(), visible: z.boolean() }),
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

// ---------------------------------------------------------------------------
// Server -> browser
// ---------------------------------------------------------------------------

export const ServerMessageSchema = z.discriminatedUnion('type', [
  /** Sent after `session:hello` and again whenever an item changes (an agent claimed it, verification finished). */
  z.object({ type: z.literal('session:state'), info: SessionInfoSchema, items: z.array(ChangeItemSchema) }),
  z.object({ type: z.literal('session:resolved'), reqId: z.string(), source: SourceLocSchema.nullable() }),
  z.object({
    type: z.literal('session:sent'),
    reqId: z.string(),
    batch: BatchSchema,
    /**
     * Replaces what the dock says after Send ("Copied. Paste into your agent, or it will pick the
     * batch up over MCP.", or the manual-copy text when the clipboard refused). For a session that
     * is not primp's server, such as a stand-in on a website with no agent. primp's server never sets it.
     */
    note: z.string().optional(),
  }),
  /** Answer to `session:prompt`: the prompt the drafts would be sent with (empty when none of them is a draft). */
  z.object({ type: z.literal('session:prompt-text'), reqId: z.string(), prompt: z.string(), count: z.number().int().nonnegative() }),
  /** Attributed layout shifts for the document, culprits resolved to source where possible. */
  z.object({
    type: z.literal('session:shift-report'),
    doc: z.string(),
    report: ShiftReportSchema,
    /** Source of each issue's culprit, by issue id; absent when it could not be resolved. */
    culpritSources: z.record(z.string(), SourceLocSchema),
  }),
  /** Measure these expectations now, with every preview switched off, and answer with `session:measured`. */
  z.object({
    type: z.literal('session:measure'),
    reqId: z.string(),
    items: z.array(z.object({ itemId: z.string(), locator: LocatorSchema, expect: z.array(ExpectationSchema) })),
  }),
  /** Reload the page (layout-shift replay). */
  z.object({ type: z.literal('session:reload'), reason: z.string() }),
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
