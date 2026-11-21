import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChangeItem, Locator, Ref, StructuralChange, StyleChange } from '../../protocol/src/change.ts'
import type { ClientMessage, ServerMessage } from '../../protocol/src/messages.ts'
import type { SessionSocket } from '../src/session.ts'

/** Test doubles and builders shared by the session, app and CLI tests. */

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** A fresh directory under the repo's git-ignored `.tmp/`; remove it with `rmSync` (or `removeDir`) when done. */
export function tempDir(prefix: string): string {
  const base = join(REPO_ROOT, '.tmp')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, `${prefix}-`))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** A socket whose other end is the test. */
export class FakeSocket implements SessionSocket {
  /** Everything the server sent, parsed. */
  readonly sent: ServerMessage[] = []
  open = true
  private readonly listeners: { message: ((data: unknown) => void)[]; close: (() => void)[]; error: ((error: unknown) => void)[] } = { message: [], close: [], error: [] }

  send(data: string): void {
    if (!this.open) throw new Error('socket is closed')
    this.sent.push(JSON.parse(data) as ServerMessage)
  }

  on(event: 'message' | 'close' | 'error', listener: never): this {
    ;(this.listeners[event] as unknown[]).push(listener)
    return this
  }

  /** The browser sends a protocol message. */
  receive(message: ClientMessage): void {
    this.receiveRaw(JSON.stringify(message))
  }

  /** The browser sends anything at all. */
  receiveRaw(data: unknown): void {
    for (const listener of [...this.listeners.message]) listener(data)
  }

  close(): void {
    this.open = false
    for (const listener of [...this.listeners.close]) listener()
  }

  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.of(type).at(-1)
  }
}

export function hello(doc: string, visible = true): ClientMessage {
  return { type: 'session:hello', doc, url: `http://localhost:5174/${doc}`, viewport: { w: 1280, h: 800, dpr: 2 }, visible }
}

export const LOCATOR: Locator = { tag: 'button', indexPath: [0, 2, 1], ancestors: ['body', 'main'], text: 'Sign in' }

export function ref(uid: string, file: string | null, line = 12): Ref {
  return {
    uid,
    selector: `[data-reglet-id="${uid}"]`,
    tag: 'button',
    classes: ['btn'],
    text: 'Sign in',
    label: 'button.btn "Sign in"',
    rect: { x: 10, y: 20, w: 120, h: 40 },
    instanceCount: 1,
    source:
      file === null
        ? null
        : { file, line, col: 5, component: 'Header', framework: 'react', level: 'exact', verifiedOnDisk: true, via: 'react-stack', target: 'element', notes: [] },
    locator: LOCATOR,
  }
}

const CONDITION = { viewport: { w: 1280, h: 800, dpr: 2 }, colorScheme: 'light' as const }

export function styleItem(id: string, file: string | null = 'src/components/Header.tsx', overrides: Partial<StyleChange> = {}): StyleChange {
  return {
    id,
    seq: 0,
    createdAt: 1_750_000_000_000,
    page: '/',
    status: 'draft',
    target: ref(`el-${id}`, file),
    sideEffects: [],
    expect: [{ type: 'computed', property: 'padding-top', value: '24px', condition: CONDITION }],
    kind: 'style',
    property: 'padding-top',
    scope: 'instance',
    before: { authored: '16px', computed: '16px' },
    after: { authored: '24px', computed: '24px' },
    condition: CONDITION,
    stylingSystem: 'plain-css',
    ...overrides,
  }
}

export function structureItem(id: string, file: string | null = 'src/components/Banner.tsx', overrides: Partial<StructuralChange> = {}): StructuralChange {
  return {
    id,
    seq: 0,
    createdAt: 1_750_000_000_001,
    page: '/',
    status: 'draft',
    target: ref(`el-${id}`, file, 10),
    sideEffects: [],
    expect: [{ type: 'absent' }],
    kind: 'structure',
    op: 'remove',
    ...overrides,
  }
}

export const statuses = (items: readonly ChangeItem[]): Record<string, string> => Object.fromEntries(items.map((item) => [item.id, item.status]))

function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

/**
 * A port P with P, P+1 and P+2 free on both loopback families, taken from below the range the
 * OS hands out for `listen(0)`.
 *
 * reglet puts its proxy on "dev-server port + 1". With an OS-assigned dev-server port that
 * neighbour is, on macOS, the very next port the OS gives to whatever asks next, so tests that
 * run in parallel would find reglet's proxy on a port they were just given or had just freed.
 * Dev servers of tests that let reglet choose its port therefore listen down here.
 */
export async function freeLowPort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = 21_000 + Math.floor(Math.random() * 3000) * 3
    const checks = await Promise.all([0, 1, 2].flatMap((offset) => [isFree(candidate + offset, '127.0.0.1'), isFree(candidate + offset, '::1')]))
    if (checks.every(Boolean)) return candidate
  }
  throw new Error('no free port triple found between 21000 and 30000')
}
