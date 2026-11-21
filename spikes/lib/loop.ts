/**
 * Harness for closed-loop checks: a fixture's dev server, primp in front of it
 * (the real `startPrimp`), a headless page with the real dock, and an MCP
 * client talking to the real `primp mcp` stdio shim.
 *
 *   const loop = await startLoop('vite-react-19')
 *   await loop.open('/')                                   // loads the page, waits for the dock and the HMR socket
 *   const item = await loop.editAndClaim('.card', { property: 'padding', value: '28px' })
 *   editFile(loop.fixture, 'src/Card.module.css', replaceOnce(...))   // the "agent"
 *   const result = loop.only((await loop.verify([item.id])).outcome)
 *
 * The other gestures of the dock have the same shape: `editAndClaim(sel, { ..., state: 'hover' })`
 * for an edit made in an interaction state, `reorderAndClaim(sel, { by: 1 })` for a move among the
 * siblings, `resizeAndClaim(sel, { width, height })` for a handle drag (one item per axis).
 *
 * The dock is driven through `window.__primp_test` by METHOD NAME (`loop.dock('select', sel)`),
 * never by evaluating source text in the page, so it also works under a strict CSP.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Browser, Page } from '@playwright/test'
import type { ChangeItem, ElementState, VerificationResult } from '../../packages/protocol/src/change.ts'
import type { PendingChanges, VerifyChangesResult } from '../../packages/protocol/src/session.ts'
import type { PrimpTestHandle, TestEditResult } from '../../packages/overlay/src/test-handle.ts'
import { startPrimp, type PrimpHandle } from '../../packages/server/src/app.ts'
import { SESSION_DIR_ENV } from '../../packages/server/src/session-file.ts'
import { launchBrowser, newPage, type PageRecord } from './browser.ts'
import { REPO_ROOT, startFixture, TMP_ROOT, type FixtureHandle, type FixtureName } from './fixture.ts'
import { onCleanup } from './proc.ts'
import { expect } from './report.ts'
import { waitFor } from './wait.ts'

const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/index.ts')
/** tsx's loader as a file URL, so `node --import` finds it from the fixture's working directory. */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

export interface StyleEdit {
  property: string
  value: string
  media?: string
  scope?: 'instance' | 'all-instances'
  /** The interaction state the edit is for (`hover`, ...). Absent: the resting style, whatever the State control says. */
  state?: ElementState
}

/** Where a reorder moves the selection: `by` positions among its siblings (the Move buttons), or `to` an index from 0. */
export type ReorderRequest = { by: number } | { to: number }

/** A border-box size in CSS px, as a handle drag produces it. */
export interface SizeRequest {
  width?: number
  height?: number
}

/** A batch the agent took over MCP: its items (all claimed) and the prompt it received. */
export interface Claimed {
  items: ChangeItem[]
  prompt: string
}

type Method = keyof PrimpTestHandle
type Result<M extends Method> = Awaited<ReturnType<PrimpTestHandle[M]>>

export interface Loop {
  fixture: FixtureHandle
  primp: PrimpHandle
  browser: Browser
  page: Page
  record: PageRecord
  client: Client
  /** Calls one method of `window.__primp_test` in the page. */
  dock<M extends Method>(method: M, ...args: Parameters<PrimpTestHandle[M]>): Promise<Result<M>>
  /** Loads a path through primp and waits for the dock and for the dev server's HMR socket. */
  open(path: string): Promise<void>
  tool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>
  takePending(): Promise<PendingChanges>
  verify(ids: string[], waitMs?: number): Promise<{ outcome: VerifyChangesResult; text: string }>
  /** The single result of a verification of one change. */
  only(outcome: VerifyChangesResult): VerificationResult
  describe(result: VerificationResult): string
  itemStatus(id: string): string
  /** What the dock shows for an item's verification. */
  shownStatus(id: string): Promise<string>
  /** Select, edit, Send, and have the agent take the batch over MCP. Returns the one item of that batch. */
  editAndClaim(selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<ChangeItem>
  /** Select, edit and Send, without any agent taking it (the pasted-prompt flow). */
  editAndSend(selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<{ item: ChangeItem; prompt: string }>
  /** The agent takes what was sent over MCP: exactly `count` items, all claimed, and a prompt naming each and verify_changes. */
  claim(count?: number): Promise<Claimed>
  /** Select, move among the siblings, Send, and have the agent take it. `prompt` is what the agent received. */
  reorderAndClaim(selector: string, move: ReorderRequest): Promise<{ item: ChangeItem; prompt: string }>
  /**
   * Select, resize to a border-box size (as a corner drag would), Send, and have the agent take it.
   * `recorded` is what the one gesture recorded (one item per axis), `items` what the agent claimed.
   */
  resizeAndClaim(selector: string, size: SizeRequest, options?: Pick<StyleEdit, 'media' | 'scope' | 'state'>): Promise<Claimed & { recorded: ChangeItem[] }>
  /** The border-box size of the first element matching `selector`, in CSS px, as the page lays it out now. */
  borderBox(selector: string): Promise<{ width: number; height: number }>
}

export interface LoopOptions {
  viewport?: { width: number; height: number }
  /** Directory, relative to the fixture, the agent's shim is started in. Default: the fixture root. */
  shimCwd?: string
}

export async function startLoop(name: FixtureName, options: LoopOptions = {}): Promise<Loop> {
  const sessionDir = join(TMP_ROOT, `loop-sessions-${process.pid}-${name}`)
  mkdirSync(sessionDir, { recursive: true })
  onCleanup(() => rmSync(sessionDir, { recursive: true, force: true }))

  const fixture = await startFixture(name)
  const primp = await startPrimp({ projectRoot: fixture.dir, target: fixture.port, handleSignals: false, sessionDir })
  onCleanup(() => primp.close())
  const browser = await launchBrowser()
  const { page, record } = await newPage(browser, { viewport: options.viewport ?? { width: 1280, height: 900 } })

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI_ENTRY, 'mcp'],
    cwd: options.shimCwd === undefined ? fixture.dir : join(fixture.dir, options.shimCwd),
    env: { ...getDefaultEnvironment(), [SESSION_DIR_ENV]: sessionDir },
    stderr: 'pipe',
  })
  const client = new Client({ name: `primp-loop-${name}`, version: '0.0.0' })
  onCleanup(() => client.close().catch(() => undefined))
  await client.connect(transport)

  const dock = <M extends Method>(method: M, ...args: Parameters<PrimpTestHandle[M]>): Promise<Result<M>> =>
    page.evaluate(
      ([name, values]) => {
        const handle = (window as unknown as { __primp_test?: Record<string, (...a: unknown[]) => unknown> }).__primp_test
        if (handle === undefined) throw new Error('window.__primp_test is missing: the dock did not load')
        return (handle[name as string] as (...a: unknown[]) => unknown)(...(values as unknown[]))
      },
      [method, args] as const,
    ) as Promise<Result<M>>

  const tool = async (toolName: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
    (await client.callTool({ name: toolName, arguments: args }, { timeout: 120_000 })) as CallToolResult
  const textOf = (result: CallToolResult): string => (result.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('\n')

  const takePending = async (): Promise<PendingChanges> => {
    const result = await tool('get_pending_changes')
    expect(result.isError !== true, `get_pending_changes failed: ${textOf(result)}`)
    return result.structuredContent as PendingChanges
  }
  const verify = async (ids: string[], waitMs = 5000): Promise<{ outcome: VerifyChangesResult; text: string }> => {
    const result = await tool('verify_changes', { ids, waitMs })
    expect(result.isError !== true, `verify_changes failed: ${textOf(result)}`)
    return { outcome: result.structuredContent as VerifyChangesResult, text: textOf(result) }
  }
  const only = (outcome: VerifyChangesResult): VerificationResult => {
    expect(outcome.results.length === 1, `expected one result, got ${outcome.results.length}: ${outcome.summary}`)
    return outcome.results[0] as VerificationResult
  }
  const describe = (result: VerificationResult): string =>
    `${result.status} (attempt ${result.attempt}; settle ${result.settle?.status ?? '-'} by ${result.settle?.signal ?? '-'} in ${Math.round(result.settle?.ms ?? 0)} ms; files ${result.settle?.filesChanged.join(', ') || 'none'}); checks: ${result.checks.map((check) => `${check.status} expected ${check.expected} actual ${check.actual}`).join(' | ') || 'none'}; hint: ${result.hint}`

  const open = async (path: string): Promise<void> => {
    await page.goto(`${primp.url}${path}`)
    await page.waitForFunction(() => (window as unknown as { __primp_test?: unknown }).__primp_test !== undefined, undefined, { timeout: 20_000 })
    await dock('ready')
    // The HMR socket must be open before the first source edit, or the update is missed. A static site has none.
    if (primp.framework !== 'static' && primp.framework !== 'unknown') {
      await waitFor(() => primp.hmr.status().live, { what: 'the HMR socket through the proxy', timeoutMs: 15_000 })
    }
  }

  const applyEdit = async (selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<ChangeItem> => {
    await dock('select', selector)
    const result: TestEditResult =
      edit === 'remove'
        ? await dock('remove')
        : edit === 'hide'
          ? await dock('hide')
          : await dock('setStyle', edit.property, edit.value, { media: edit.media ?? null, scope: edit.scope ?? 'all-instances', state: edit.state ?? null })
    expect(result.ok && result.item !== null, `the edit was not recorded: ${result.error ?? 'no item'}`)
    return result.item as ChangeItem
  }

  const editAndSend = async (selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<{ item: ChangeItem; prompt: string }> => {
    const item = await applyEdit(selector, edit)
    const prompt = await dock('send')
    expect(prompt.length > 0, 'Send returned an empty prompt')
    return { item, prompt }
  }

  const claim = async (count = 1): Promise<Claimed> => {
    const pending = await takePending()
    const items = pending.files.flatMap((group) => group.items)
    expect(items.length === count, `expected ${count} claimed change(s), got ${items.length}`)
    for (const item of items) {
      expect(item.status === 'claimed', `the change ${item.id} came back as ${item.status}`)
      expect(pending.prompt.includes(item.id), `the agent prompt does not name the change ${item.id}`)
    }
    expect(pending.prompt.includes('verify_changes'), 'the agent prompt does not name the verify tool')
    return { items, prompt: pending.prompt }
  }

  const editAndClaim = async (selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<ChangeItem> => {
    await editAndSend(selector, edit)
    return (await claim(1)).items[0] as ChangeItem
  }

  const reorderAndClaim = async (selector: string, move: ReorderRequest): Promise<{ item: ChangeItem; prompt: string }> => {
    await dock('select', selector)
    const result = 'by' in move ? await dock('move', move.by) : await dock('reorder', move.to)
    expect(result.ok && result.item !== null, `the move was not recorded: ${result.error ?? 'no item'}`)
    const recorded = result.item as ChangeItem
    expect(recorded.kind === 'structure' && recorded.op === 'reorder', `recorded a ${recorded.kind === 'structure' ? recorded.op : recorded.kind}, not a reorder`)
    const sent = await dock('send')
    expect(sent.length > 0, 'Send returned an empty prompt')
    const { items, prompt } = await claim(1)
    const item = items[0] as ChangeItem
    expect(item.id === recorded.id, `claimed ${item.id}, recorded ${recorded.id}`)
    return { item, prompt }
  }

  const resizeAndClaim = async (selector: string, size: SizeRequest, options: Pick<StyleEdit, 'media' | 'scope' | 'state'> = {}): Promise<Claimed & { recorded: ChangeItem[] }> => {
    await dock('select', selector)
    const result = await dock('resize', size, { media: options.media ?? null, scope: options.scope ?? 'all-instances', state: options.state ?? null })
    expect(result.ok && result.items !== undefined && result.items.length > 0, `the resize was not recorded: ${result.error ?? 'no items'}`)
    const recorded = result.items as ChangeItem[]
    const sent = await dock('send')
    expect(sent.length > 0, 'Send returned an empty prompt')
    const claimed = await claim(recorded.length)
    const ids = new Set(claimed.items.map((item) => item.id))
    expect(recorded.every((item) => ids.has(item.id)), `claimed ${[...ids].join(', ')}, recorded ${recorded.map((item) => item.id).join(', ')}`)
    return { ...claimed, recorded }
  }

  const borderBox = (selector: string): Promise<{ width: number; height: number }> =>
    page.evaluate((sel) => {
      const rect = (document.querySelector(sel) as Element).getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }, selector)

  return {
    fixture,
    primp,
    browser,
    page,
    record,
    client,
    dock,
    open,
    tool,
    takePending,
    verify,
    only,
    describe,
    itemStatus: (id) => primp.session.item(id)?.status ?? 'missing',
    shownStatus: async (id) => (await dock('items')).find((item) => item.id === id)?.verification?.status ?? 'none',
    editAndClaim,
    editAndSend,
    claim,
    reorderAndClaim,
    resizeAndClaim,
    borderBox,
  }
}
