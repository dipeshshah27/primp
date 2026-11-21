/**
 * Harness for closed-loop checks: a fixture's dev server, reglet in front of it
 * (the real `startReglet`), a headless page with the real dock, and an MCP
 * client talking to the real `reglet mcp` stdio shim.
 *
 *   const loop = await startLoop('vite-react-19')
 *   await loop.open('/')                                   // loads the page, waits for the dock and the HMR socket
 *   const item = await loop.editAndClaim('.card', { property: 'padding', value: '28px' })
 *   editFile(loop.fixture, 'src/Card.module.css', replaceOnce(...))   // the "agent"
 *   const result = loop.only((await loop.verify([item.id])).outcome)
 *
 * The dock is driven through `window.__reglet_test` by METHOD NAME (`loop.dock('select', sel)`),
 * never by evaluating source text in the page, so it also works under a strict CSP.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Browser, Page } from '@playwright/test'
import type { ChangeItem, VerificationResult } from '../../packages/protocol/src/change.ts'
import type { PendingChanges, VerifyChangesResult } from '../../packages/protocol/src/session.ts'
import type { RegletTestHandle, TestEditResult } from '../../packages/overlay/src/test-handle.ts'
import { startReglet, type RegletHandle } from '../../packages/server/src/app.ts'
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
}

type Method = keyof RegletTestHandle
type Result<M extends Method> = Awaited<ReturnType<RegletTestHandle[M]>>

export interface Loop {
  fixture: FixtureHandle
  reglet: RegletHandle
  browser: Browser
  page: Page
  record: PageRecord
  client: Client
  /** Calls one method of `window.__reglet_test` in the page. */
  dock<M extends Method>(method: M, ...args: Parameters<RegletTestHandle[M]>): Promise<Result<M>>
  /** Loads a path through reglet and waits for the dock and for the dev server's HMR socket. */
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
  const reglet = await startReglet({ projectRoot: fixture.dir, target: fixture.port, handleSignals: false, sessionDir })
  onCleanup(() => reglet.close())
  const browser = await launchBrowser()
  const { page, record } = await newPage(browser, { viewport: options.viewport ?? { width: 1280, height: 900 } })

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI_ENTRY, 'mcp'],
    cwd: options.shimCwd === undefined ? fixture.dir : join(fixture.dir, options.shimCwd),
    env: { ...getDefaultEnvironment(), [SESSION_DIR_ENV]: sessionDir },
    stderr: 'pipe',
  })
  const client = new Client({ name: `reglet-loop-${name}`, version: '0.0.0' })
  onCleanup(() => client.close().catch(() => undefined))
  await client.connect(transport)

  const dock = <M extends Method>(method: M, ...args: Parameters<RegletTestHandle[M]>): Promise<Result<M>> =>
    page.evaluate(
      ([name, values]) => {
        const handle = (window as unknown as { __reglet_test?: Record<string, (...a: unknown[]) => unknown> }).__reglet_test
        if (handle === undefined) throw new Error('window.__reglet_test is missing: the dock did not load')
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
    await page.goto(`${reglet.url}${path}`)
    await page.waitForFunction(() => (window as unknown as { __reglet_test?: unknown }).__reglet_test !== undefined, undefined, { timeout: 20_000 })
    await dock('ready')
    // The HMR socket must be open before the first source edit, or the update is missed. A static site has none.
    if (reglet.framework !== 'static' && reglet.framework !== 'unknown') {
      await waitFor(() => reglet.hmr.status().live, { what: 'the HMR socket through the proxy', timeoutMs: 15_000 })
    }
  }

  const applyEdit = async (selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<ChangeItem> => {
    await dock('select', selector)
    const result: TestEditResult =
      edit === 'remove' ? await dock('remove') : edit === 'hide' ? await dock('hide') : await dock('setStyle', edit.property, edit.value, { media: edit.media ?? null, scope: edit.scope ?? 'all-instances' })
    expect(result.ok && result.item !== null, `the edit was not recorded: ${result.error ?? 'no item'}`)
    return result.item as ChangeItem
  }

  const editAndSend = async (selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<{ item: ChangeItem; prompt: string }> => {
    const item = await applyEdit(selector, edit)
    const prompt = await dock('send')
    expect(prompt.length > 0, 'Send returned an empty prompt')
    return { item, prompt }
  }

  const editAndClaim = async (selector: string, edit: StyleEdit | 'remove' | 'hide'): Promise<ChangeItem> => {
    await editAndSend(selector, edit)
    const pending = await takePending()
    const items = pending.files.flatMap((group) => group.items)
    expect(items.length === 1, `expected one claimed change, got ${items.length}`)
    const item = items[0] as ChangeItem
    expect(item.status === 'claimed', `the change came back as ${item.status}`)
    expect(pending.prompt.includes(item.id) && pending.prompt.includes('verify_changes'), 'the agent prompt does not name the change id and the verify tool')
    return item
  }

  return {
    fixture,
    reglet,
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
    itemStatus: (id) => reglet.session.item(id)?.status ?? 'missing',
    shownStatus: async (id) => (await dock('items')).find((item) => item.id === id)?.verification?.status ?? 'none',
    editAndClaim,
    editAndSend,
  }
}
