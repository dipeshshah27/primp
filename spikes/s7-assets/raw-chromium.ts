/**
 * Chromium started as an ordinary browser, driven over its DevTools socket
 * with nothing but tab-level commands.
 *
 * Why not Playwright here: Playwright keeps every page it controls "focused"
 * (it turns on focus emulation per page), so `document.visibilityState` stays
 * `visible` whatever tab is in front, and a hidden tab cannot be produced.
 * This launcher starts the same Chromium binary with its normal tab strip
 * (`--headless=new`, or a real window with `headed`), and uses the protocol
 * only as a hand on the tab strip: open a tab, bring a tab to the front,
 * reload, read a value. Visibility is whatever the browser itself decides.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import WebSocket from 'ws'
import { defaultRunId, onCleanup, sleep, TMP_ROOT } from '../lib/index.ts'

export interface RawTab {
  targetId: string
  sessionId: string
}

export interface RawChromium {
  version: string
  headed: boolean
  /** Opens a tab. A new tab takes the front unless `background` is set. */
  open(url: string, options?: { background?: boolean }): Promise<RawTab>
  /** Brings a tab to the front; the one that was in front becomes hidden. */
  activate(tab: RawTab): Promise<void>
  /** Starts a reload and returns at once (does not wait for the load). */
  reload(tab: RawTab): Promise<void>
  /** Evaluates an expression in the tab and returns its JSON-serialisable value. */
  evaluate<T>(tab: RawTab, expression: string): Promise<T>
  close(): Promise<void>
}

interface ProtocolReply {
  id?: number
  result?: Record<string, unknown>
  error?: { message: string }
}

export async function launchRawChromium(options: { headed?: boolean } = {}): Promise<RawChromium> {
  const headed = options.headed === true
  const profile = join(TMP_ROOT, defaultRunId(), `chromium-profile-${process.pid}-${Date.now()}`)
  mkdirSync(profile, { recursive: true })
  const child = spawn(
    chromium.executablePath(),
    [
      ...(headed ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  let socket: WebSocket | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      socket?.close()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        await Promise.race([exited, sleep(2000)])
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          await Promise.race([exited, sleep(2000)])
        }
      }
      await sleep(100)
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      removeCleanup()
    })()
    return closing
  }
  const removeCleanup = onCleanup(close)

  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = ''
      const timer = setTimeout(() => reject(new Error(`Chromium did not print its DevTools endpoint: ${stderr.slice(0, 400)}`)), 20_000)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
        if (match?.[1] !== undefined) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Chromium exited with code ${code} before it was ready: ${stderr.slice(0, 400)}`))
      })
    })

    const ws = new WebSocket(endpoint)
    socket = ws
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    let nextId = 0
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ProtocolReply
      if (message.id === undefined) return
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result ?? {})
    })
    ws.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('DevTools socket closed'))
      pending.clear()
    })
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
      })

    const version = String((await send('Browser.getVersion')).product ?? 'unknown')
    return {
      version,
      headed,
      async open(url, openOptions = {}) {
        const { targetId } = (await send('Target.createTarget', { url, background: openOptions.background === true })) as { targetId: string }
        const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
        return { targetId, sessionId }
      },
      async activate(tab) {
        await send('Target.activateTarget', { targetId: tab.targetId })
      },
      async reload(tab) {
        await send('Page.reload', {}, tab.sessionId)
      },
      async evaluate<T>(tab: RawTab, expression: string): Promise<T> {
        const reply = (await send('Runtime.evaluate', { expression: `JSON.stringify(${expression})`, returnByValue: true }, tab.sessionId)) as {
          result?: { value?: string }
          exceptionDetails?: { text?: string; exception?: { description?: string } }
        }
        if (reply.exceptionDetails !== undefined) {
          throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'evaluation failed')
        }
        return JSON.parse(reply.result?.value ?? 'null') as T
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
