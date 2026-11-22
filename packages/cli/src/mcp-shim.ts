import { request } from 'node:http'
import { z } from 'zod'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import {
  RPC_PATH,
  RpcResponseSchema,
  controlMethods,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
} from '../../protocol/src/rpc.ts'
import {
  DismissChangeResultSchema,
  LayoutShiftsResultSchema,
  ShiftVerificationSchema,
  VerifyChangesResultSchema,
  PendingChangesSchema,
  SessionSummarySchema,
  type DismissChangeResult,
  type PendingChanges,
  type SessionFile,
  type SessionSummary,
} from '../../protocol/src/session.ts'
import { findSession, isProcessAlive, removeSessionFile, type SessionDirOption } from './session-file.ts'

/**
 * `primp mcp`: the stdio MCP server an agent host starts.
 *
 * It holds no state. Every tool call looks up the session file again and
 * forwards to the control endpoint of the running primp process, so it does
 * not matter whether primp or the agent was started first, or whether primp
 * was restarted in between.
 *
 * stdout carries the protocol; anything for humans goes to stderr.
 */

export interface ShimOptions extends SessionDirOption {
  /** Directory the session lookup starts from. Defaults to the working directory. */
  cwd?: string
  /** Version reported to the client. */
  version?: string
  /** How long one control call may take before the tool reports a failure. */
  controlTimeoutMs?: number
}

export const SERVER_NAME = 'primp'

const DEFAULT_CONTROL_TIMEOUT_MS = 10_000

/** Start of the message agents see when nothing is running; kept stable so it can be matched. */
export const NOT_RUNNING = 'primp is not running for this project; start it with npx primp'

const INSTRUCTIONS = [
  'primp runs next to a web project during development. It serves the app through a local proxy and gives the developer a dock in the page for trying visual changes (CSS values, also for a state such as :hover or :focus, resizing by dragging, hiding or removing elements, and moving an element among its siblings), for writing notes about an element or the whole page when CSS cannot say what they want, and for inspecting layout shifts. It measures the rendered page; it never writes to source files, so the source edits are yours to make.',
  'Reach for this server when the developer mentions primp, says they sent or queued changes from the browser, or wants a visual change or a layout-shift fix carried over into the code.',
  'The loop: (1) call get_session to see whether primp is running for this project, whether a browser tab is attached, and whether anything is queued; (2) call get_pending_changes to take the queued changes, which come grouped by source file together with written instructions; (3) make those edits in the source files named there, keeping to the recorded values, the media, state or viewport condition, and every "must not move" constraint; (4) call verify_changes: primp waits for the dev server to hot-reload your edits, measures the page in the developer\'s tab and answers pass, drift or fail per change with expected and actual values; (5) fix what failed and verify again, at most twice, then report what still fails; (6) if a change cannot or should not be made, close it with dismiss_change and say why.',
  'Layout shifts are separate from the queued changes: get_layout_shifts lists what jumped while the page loaded and why, and verify_layout_shift reloads the page to confirm a fix.',
  'A result of no browser, tab hidden or not measurable means primp could not look, not that the change is right: say so to the developer (the tab with the app has to be open and in front) instead of treating it as a pass.',
  'A note is the developer\'s own instruction in free text (new copy, "make this a link"). Carry it out like any other change; primp cannot measure it, so verify_changes answers not_checkable for it: neither a pass nor something to fix. Tell the developer what you did for each note so they can check it by eye.',
  `If a tool answers "${NOT_RUNNING}", pass that on to the developer: primp has to be started in a terminal in the project directory, and it keeps running there.`,
].join('\n\n')

const GET_SESSION_DESCRIPTION = [
  'Status of the primp process serving this project. Takes no arguments and changes nothing.',
  'Returns the dev-server origin being proxied (target), the detected framework, whether a browser tab with the primp dock is attached (browserConnected), and how many recorded items there are per status (counts): draft is still being edited by the developer, queued is waiting for you, claimed is already handed to an agent.',
  'Use it before any other primp tool, and again whenever a result says no browser was available.',
].join(' ')

const GET_PENDING_CHANGES_DESCRIPTION = [
  'Takes the visual changes the developer sent from the primp dock and hands them to you for implementing in source.',
  'Each change names the element (selector, text, and source file and line when primp could find them), what the developer did to it (one CSS property with its value before and after, hiding or removing the element, moving it to another position among the children of its parent, or a note: an instruction in their own words, about that element or about the whole page, for what CSS cannot express), the viewport, media query and interaction state (such as :hover) it was made under, the side effects the developer marked as unwanted, and the checks that have to hold once the source matches. One resize by dragging can produce two changes, one for width and one for height.',
  'The result groups the changes by source file (files) and repeats them as written instructions (prompt).',
  'Calling this marks the returned changes as claimed: the dock shows them as in progress and a later call does not return them again. Call it when you are ready to make the edits, not to look around; get_session shows the counts without claiming anything.',
  'Pass batchId to get one batch a second time, for example after its first answer was lost.',
].join(' ')

const VERIFY_CHANGES_DESCRIPTION = [
  'Checks your source edits against the running page. Call it after implementing changes taken with get_pending_changes.',
  'primp waits until the dev server has applied your edits and the page is quiet, then measures each change in the developer\'s browser tab with its own previews switched off, and compares the result with what the developer recorded.',
  'Each result has a status: pass (every check holds); drift (the value landed close to the requested one, as happens when the nearest design token was used: keep it only if that was your intent, and say so); fail (a check does not hold: expected and actual are given); unresolved (the element could not be found again); no_update_observed (no source file changed since you took the changes); build_error (the dev server reports an error, quoted in the hint); not_measurable, tab_hidden and no_browser (primp could not measure: not a pass; not_measurable means the viewport is outside the media query of the change, or the interaction state the change is made for could not be emulated on this page, in which case ask the developer to check it by eye); not_checkable (the change is a note, free text with nothing to measure: never a pass and not a failure; tell the developer what you did for it, so they can check it by eye).',
  'fixup repeats everything that did not pass as instructions for your next edit; notes are not repeated there, as there is nothing in them to fix, and the summary names them. Leave ids out to verify every change you have taken.',
  'The call blocks while the page settles, normally a second or two and at most waitMs plus a few seconds.',
].join(' ')

const GET_LAYOUT_SHIFTS_DESCRIPTION = [
  'Lists the layout shifts primp measured during the last load of the page open in the developer\'s tab. Changes nothing and reloads nothing.',
  'A layout shift is visible content jumping after it was first shown, scored as in Cumulative Layout Shift (CLS). For each one the result names the element that caused it (not just the elements that moved), the cause (media without reserved space, a web font swapping in, content inserted above existing content), how confident the attribution is, the evidence it rests on, and the source position of the culprit when primp could find it.',
  'prompt repeats the shifts with a known cause as instructions including the usual fix for that cause. A status other than ok means the load could not be measured (most often because the tab was hidden), which is not the same as no shifts.',
  'Use it when the developer asks about layout shift, CLS or content jumping, then fix the cause in source and call verify_layout_shift with the id.',
].join(' ')

const VERIFY_LAYOUT_SHIFT_DESCRIPTION = [
  'Checks whether a layout shift from get_layout_shifts is gone after your source edit.',
  'primp reloads the developer\'s tab three times with the browser cache switched off for that page (a cached image or font would hide the shift) and looks in each load for a shift with the same culprit or the same moved elements.',
  'pass means it did not come back in any reload; fail means it did, with how much of it remains. tab_hidden, no_browser and not_measurable mean primp could not look: tell the developer, do not treat it as fixed.',
  'This visibly reloads the page in the developer\'s browser and takes about five seconds per reload, so call it once after the fix, not to explore.',
].join(' ')

const DISMISS_CHANGE_DESCRIPTION = [
  'Closes one change without implementing it and records the reason.',
  'Use it when a change cannot or should not be made in the source: the element is rendered by a dependency, the change contradicts another one in the same batch, or the developer told you to leave it.',
  'The reason is shown to the developer in the dock next to the change, so write one sentence addressed to them.',
  'Not for changes you implemented, and not for drafts the developer has not sent yet.',
].join(' ')

/** A failure with wording meant for the agent and, through it, the developer. */
class ShimError extends Error {}

export function createShimServer(options: ShimOptions = {}): McpServer {
  const cwd = options.cwd ?? process.cwd()
  const timeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS

  const server = new McpServer(
    { name: SERVER_NAME, title: 'primp', version: options.version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  )

  server.registerTool(
    'get_session',
    {
      title: 'primp session status',
      description: GET_SESSION_DESCRIPTION,
      outputSchema: SessionSummarySchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      try {
        const session = locateSession(cwd, options)
        const summary = await callControl(session, 'get_session', {}, timeoutMs)
        return {
          content: [{ type: 'text', text: describeSession(summary, session.file) }],
          structuredContent: summary,
        }
      } catch (error) {
        return toolFailure(error)
      }
    },
  )

  server.registerTool(
    'get_pending_changes',
    {
      title: 'Take the queued primp changes',
      description: GET_PENDING_CHANGES_DESCRIPTION,
      inputSchema: z.object({
        batchId: z
          .string()
          .min(1)
          .optional()
          .describe('Id of one batch to return, including changes of it that were claimed before. Leave out to take everything that is queued.'),
      }),
      outputSchema: PendingChangesSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ batchId }): Promise<CallToolResult> => {
      try {
        const session = locateSession(cwd, options)
        const pending = await callControl(session, 'get_pending_changes', batchId === undefined ? {} : { batchId }, timeoutMs)
        return { content: [{ type: 'text', text: describePending(pending, batchId) }], structuredContent: pending }
      } catch (error) {
        return toolFailure(error)
      }
    },
  )

  server.registerTool(
    'verify_changes',
    {
      title: 'Verify primp changes against the page',
      description: VERIFY_CHANGES_DESCRIPTION,
      inputSchema: z.object({
        ids: z
          .array(z.string().min(1))
          .max(500)
          .optional()
          .describe('Ids of the changes to verify, as returned by get_pending_changes. Leave out to verify every change that is claimed, queued or failed.'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(60_000)
          .optional()
          .describe('How long to wait for the page to settle after your last edit, in milliseconds. Default 5000; raise it for a slow build.'),
      }),
      outputSchema: VerifyChangesResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, waitMs }): Promise<CallToolResult> => {
      try {
        const session = locateSession(cwd, options)
        const params = { ...(ids === undefined ? {} : { ids }), ...(waitMs === undefined ? {} : { waitMs }) }
        // Settle wait, then the browser's measurement (up to 5 s), then some slack.
        const result = await callControl(session, 'verify_changes', params, (waitMs ?? 5000) + 15_000)
        const text = result.fixup === '' ? result.summary : `${result.summary}\n\n${result.fixup}`
        return { content: [{ type: 'text', text }], structuredContent: result }
      } catch (error) {
        return toolFailure(error)
      }
    },
  )

  server.registerTool(
    'get_layout_shifts',
    {
      title: 'List the layout shifts of the current page',
      description: GET_LAYOUT_SHIFTS_DESCRIPTION,
      inputSchema: z.object({
        minValue: z.number().min(0).max(10).optional().describe('Leave out shifts scoring below this, for example 0.01. Default: all.'),
      }),
      outputSchema: LayoutShiftsResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ minValue }): Promise<CallToolResult> => {
      try {
        const session = locateSession(cwd, options)
        const result = await callControl(session, 'get_layout_shifts', minValue === undefined ? {} : { minValue }, timeoutMs)
        const text = result.prompt === '' ? result.message : `${result.message}\n\n${result.prompt}`
        return { content: [{ type: 'text', text }], structuredContent: result }
      } catch (error) {
        return toolFailure(error)
      }
    },
  )

  server.registerTool(
    'verify_layout_shift',
    {
      title: 'Check that a layout shift is gone',
      description: VERIFY_LAYOUT_SHIFT_DESCRIPTION,
      inputSchema: z.object({
        id: z.string().min(1).describe('Id of the layout shift, as returned by the latest get_layout_shifts call'),
      }),
      outputSchema: ShiftVerificationSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const session = locateSession(cwd, options)
        // Three reloads, each waiting for the page to load and report.
        const result = await callControl(session, 'verify_layout_shift', { id }, 90_000)
        return { content: [{ type: 'text', text: `${id}: ${result.status}. ${result.hint}` }], structuredContent: result }
      } catch (error) {
        return toolFailure(error)
      }
    },
  )

  server.registerTool(
    'dismiss_change',
    {
      title: 'Dismiss a primp change',
      description: DISMISS_CHANGE_DESCRIPTION,
      inputSchema: z.object({
        id: z.string().min(1).describe('Id of the change, as returned by get_pending_changes'),
        reason: z.string().min(1).max(2000).describe('Why the change is not being implemented, written for the developer'),
      }),
      outputSchema: DismissChangeResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, reason }): Promise<CallToolResult> => {
      try {
        const session = locateSession(cwd, options)
        const result = await callControl(session, 'dismiss_change', { id, reason }, timeoutMs)
        // Not dismissed is something the agent has to act on: a tool error, which (like every error here) carries text only.
        if (!result.dismissed) return { content: [{ type: 'text', text: result.message }], isError: true }
        return { content: [{ type: 'text', text: result.message }], structuredContent: result }
      } catch (error) {
        return toolFailure(error)
      }
    },
  )

  return server
}

/** Serves the shim on this process's stdin and stdout until the client closes stdin. */
export function runShim(options: ShimOptions = {}): StdioServerHandle {
  return serveStdio(() => createShimServer(options), {
    onerror: (error) => process.stderr.write(`primp mcp: ${error.message}\n`),
  })
}

interface LocatedSession {
  path: string
  file: SessionFile
}

function locateSession(cwd: string, options: SessionDirOption): LocatedSession {
  const lookup = findSession(cwd, options)
  switch (lookup.kind) {
    case 'found':
      return { path: lookup.path, file: lookup.session }
    case 'ambiguous':
      throw new ShimError(
        [
          `primp is running for ${lookup.projectRoots.length} projects below ${cwd} and it is not clear which one is meant:`,
          ...lookup.projectRoots.map((root) => `  ${root}`),
          'Start the agent inside one of those directories, or register the server as "primp mcp --project <directory>".',
        ].join('\n'),
      )
    case 'none':
      throw new ShimError(`${NOT_RUNNING} (no running session covers ${cwd}).`)
  }
}

async function callControl<M extends ControlMethod>(
  session: LocatedSession,
  method: M,
  params: ControlParams<M>,
  timeoutMs: number,
): Promise<ControlResult<M>> {
  let body: string
  try {
    body = await postJson(session.file, { method, params }, timeoutMs)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
      // Nothing listens on the recorded port: the process died without removing
      // its file, or the pid now belongs to something else.
      removeSessionFile(session.path)
      throw new ShimError(`${NOT_RUNNING} (the session recorded for ${session.file.projectRoot} no longer answers).`)
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new ShimError(
      `The primp process (pid ${session.file.pid}) did not answer ${method}: ${reason}. If it is stuck, restart it with npx primp.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  const response = RpcResponseSchema.safeParse(parsed)
  if (!response.success) {
    throw new ShimError(`The primp process (pid ${session.file.pid}) sent a reply to ${method} that could not be read.`)
  }
  if (!response.data.ok) {
    const { code, message } = response.data.error
    if (code === 'unauthorized' && !isProcessAlive(session.file.pid)) {
      removeSessionFile(session.path)
      throw new ShimError(`${NOT_RUNNING} (the recorded session is stale).`)
    }
    if (code === 'method_not_found') {
      throw new ShimError(
        `The running primp does not know ${method}; it is probably an older version than this MCP server. Restart it with npx primp.`,
      )
    }
    throw new ShimError(`primp could not complete ${method}: ${message}`)
  }

  const result = controlMethods[method].result.safeParse(response.data.result)
  if (!result.success) {
    throw new ShimError(
      `primp answered ${method} in a shape this MCP server does not understand; the two are probably different versions. Restart primp with npx primp.`,
    )
  }
  return result.data as ControlResult<M>
}

/**
 * One POST to the control endpoint. Uses a fresh socket per call (`agent:
 * false`) so no keep-alive connection holds the shim open after stdin closes.
 */
function postJson(file: SessionFile, payload: unknown, timeoutMs: number): Promise<string> {
  const data = JSON.stringify(payload)
  return new Promise<string>((resolvePromise, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: file.controlPort,
        path: RPC_PATH,
        method: 'POST',
        agent: false,
        headers: {
          authorization: `Bearer ${file.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no reply within ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end(data)
  })
}

function describeSession(summary: SessionSummary, file: SessionFile): string {
  const counts = Object.entries(summary.counts)
  const lines = [
    `primp is running for ${file.projectRoot}`,
    `target: ${summary.target}`,
    `framework: ${summary.framework}`,
    `browserConnected: ${summary.browserConnected}`,
    `counts: ${counts.length > 0 ? counts.map(([status, n]) => `${status}=${n}`).join(', ') : 'none recorded'}`,
    `proxy URL (what the developer opens): ${file.proxyUrl}`,
  ]
  if (!summary.browserConnected) {
    lines.push(`No browser tab is attached. Ask the developer to open ${file.proxyUrl} and keep the tab visible.`)
  }
  return lines.join('\n')
}

function describePending(pending: PendingChanges, batchId: string | undefined): string {
  if (pending.count === 0) {
    return batchId === undefined
      ? 'Nothing is queued. Either the developer has not pressed Send in the primp dock since the last call, or the queued changes were already taken (get_session shows the counts).'
      : `Batch ${batchId} has no queued or claimed changes. Check the id, or call get_pending_changes without batchId.`
  }
  const files = pending.files.map((group) => `${group.file ?? '(source file unknown)'}: ${group.items.map((item) => item.id).join(', ')}`)
  return [
    `${pending.count} change(s) from ${pending.batchIds.length === 1 ? `batch ${pending.batchIds[0]}` : `batches ${pending.batchIds.join(', ')}`} are now claimed by you.`,
    'By source file (change ids):',
    ...files.map((line) => `  ${line}`),
    '',
    pending.prompt,
  ].join('\n')
}

function toolFailure(error: unknown): CallToolResult {
  if (!(error instanceof ShimError)) {
    process.stderr.write(`primp mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  }
  const text = error instanceof ShimError ? error.message : 'primp mcp failed unexpectedly; see its stderr output.'
  return { content: [{ type: 'text', text }], isError: true }
}

/** Re-exported so callers can type the structured results. */
export type { DismissChangeResult, PendingChanges, SessionSummary }
