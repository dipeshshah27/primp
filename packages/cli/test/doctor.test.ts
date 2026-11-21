import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OverlayAssets } from '../../server/src/assets.ts'
import type { DevServerDetection } from '../../server/src/detect.ts'
import { removeDir, tempDir } from '../../server/test/session-helpers.ts'
import { collectDoctorChecks, formatDoctor, isSupportedNode, runDoctor, type DoctorDeps } from '../src/doctor.ts'

let dir: string
let project: string

beforeAll(() => {
  dir = tempDir('doctor-test')
  project = join(dir, 'shop')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), '{"name":"shop","devDependencies":{"vite":"8"}}')
})
afterAll(() => removeDir(dir))

const asset = (bytes: number, from: 'esbuild' | 'prebuilt') => ({ path: '/__primp/x.js', code: '', bytes, hash: 'abc', from, source: '/x' })
const ASSETS: OverlayAssets = { hook: asset(9216, 'esbuild'), overlay: asset(81920, 'prebuilt'), assets: new Map(), headScripts: [] }
const NOTHING: DevServerDetection = { others: [], ignored: [], method: 'none' }

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps & { excluded: { ports: number[]; pids: number[] }[] } {
  const excluded: { ports: number[]; pids: number[] }[] = []
  return {
    excluded,
    nodeVersion: '22.22.0',
    platform: 'darwin',
    framework: () => ({ framework: 'vite', packageName: 'shop', reason: 'package.json depends on vite' }),
    devServer: async (_root, _framework, ports, pids) => {
      excluded.push({ ports, pids })
      return {
        chosen: { port: 5173, url: 'http://localhost:5173', via: 'process', pid: 41875, command: 'node', cwd: project },
        others: [{ port: 5180, url: 'http://localhost:5180', via: 'process' }],
        ignored: [],
        method: 'process',
      }
    },
    session: () => ({ kind: 'none' }),
    ownProcesses: () => ({ ports: [5174, 60001], pids: [777] }),
    buildAssets: async () => ASSETS,
    ...overrides,
  }
}

describe('primp doctor', () => {
  it('reports every check in order when all is well, and exits 0', async () => {
    const d = deps()
    const checks = await collectDoctorChecks(project, d)
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ['Node', 'ok'],
      ['Project', 'ok'],
      ['Framework', 'ok'],
      ['Dev server', 'ok'],
      ['Session', 'ok'],
      ['Overlay bundles', 'ok'],
    ])
    const text = formatDoctor(checks)
    expect(text).toContain('22.22.0 on darwin')
    expect(text).toContain(project)
    expect(text).toContain('vite (package.json depends on vite)')
    expect(text).toContain(`http://localhost:5173 (node pid 41875, working in ${project}); also answering: http://localhost:5180`)
    expect(text).toContain('primp is not running for this project')
    expect(text).toContain('hook.js 9.0 kB (esbuild), overlay.js 80.0 kB (prebuilt)')
    // primp's own ports and process are not candidates for "the dev server".
    expect(d.excluded).toEqual([{ ports: [5174, 60001], pids: [777] }])
    const printed: string[] = []
    expect(await runDoctor(project, d, (line) => printed.push(line))).toBe(0)
    expect(printed).toEqual([text])
  })

  it('fails on an unsupported Node and on bundles that do not build', async () => {
    const old = await collectDoctorChecks(project, deps({ nodeVersion: '20.11.1' }))
    expect(old[0]).toEqual({ name: 'Node', status: 'fail', detail: '20.11.1; primp needs ^22.22.0 or >=24.11.0' })
    const broken = deps({
      buildAssets: async () => {
        throw new Error('could not build overlay.js from /x/overlay.ts: boom')
      },
    })
    expect((await collectDoctorChecks(project, broken)).at(-1)).toEqual({ name: 'Overlay bundles', status: 'fail', detail: 'could not build overlay.js from /x/overlay.ts: boom' })
    expect(await runDoctor(project, broken, () => {})).toBe(1)
    expect(await runDoctor(project, deps({ nodeVersion: '23.5.0' }), () => {})).toBe(1)
  })

  it('warns, without failing, when there is no dev server, no known framework, or only a guess by port', async () => {
    const none = deps({
      framework: () => ({ framework: 'unknown', reason: 'no known framework in package.json' }),
      devServer: async () => ({ ...NOTHING, ignored: [{ port: 24678, reason: 'HTTP 426, content type (none)' }], processScan: 'lsof is not installed; only well-known ports were tried' }),
    })
    const checks = await collectDoctorChecks(project, none)
    expect(Object.fromEntries(checks.map((check) => [check.name, check.status]))).toMatchObject({ Framework: 'warn', 'Dev server': 'warn', 'Process scan': 'warn' })
    expect(checks.find((check) => check.name === 'Dev server')?.detail).toContain('24678 (HTTP 426, content type (none))')
    expect(await runDoctor(project, none, () => {})).toBe(0)

    const byPort = deps({ devServer: async () => ({ chosen: { port: 3000, url: 'http://localhost:3000', via: 'port' }, others: [], ignored: [], method: 'port' }) })
    const guess = (await collectDoctorChecks(project, byPort)).find((check) => check.name === 'Dev server')
    expect(guess?.status).toBe('warn')
    expect(guess?.detail).toContain('could not be tied to this project')

    const throwing = deps({
      devServer: async () => {
        throw new Error('lsof exploded')
      },
    })
    expect((await collectDoctorChecks(project, throwing)).find((check) => check.name === 'Dev server')).toMatchObject({ status: 'warn', detail: 'detection failed: lsof exploded' })
  })

  it('says where a running session is, and when several match', async () => {
    const session = { version: 1 as const, pid: 4242, projectRoot: project, controlPort: 60001, token: 't'.repeat(43), proxyUrl: 'http://localhost:5174', startedAt: new Date().toISOString() }
    const found = await collectDoctorChecks(project, deps({ session: () => ({ kind: 'found', path: '/s.json', session, relation: 'contains-cwd' }) }))
    expect(found.find((check) => check.name === 'Session')).toEqual({ name: 'Session', status: 'ok', detail: `primp is running for ${project} (pid 4242); open http://localhost:5174` })
    const many = await collectDoctorChecks(project, deps({ session: () => ({ kind: 'ambiguous', projectRoots: ['/a', '/b'] }) }))
    expect(many.find((check) => check.name === 'Session')).toMatchObject({ status: 'warn', detail: expect.stringContaining('/a, /b') })
  })

  it('stops at a project directory that does not exist, and warns about one without package.json', async () => {
    const missing = await collectDoctorChecks(join(dir, 'nope'), deps())
    expect(missing.map((check) => [check.name, check.status])).toEqual([
      ['Node', 'ok'],
      ['Project', 'fail'],
    ])
    const bare = join(dir, 'bare')
    mkdirSync(bare)
    expect((await collectDoctorChecks(bare, deps()))[1]).toMatchObject({ name: 'Project', status: 'warn' })
  })

  it('knows the supported Node range', () => {
    expect(['22.22.0', '22.23.2', 'v24.11.0', '25.0.0', '26.1.0'].map(isSupportedNode)).toEqual([true, true, true, true, true])
    expect(['18.20.0', '20.19.0', '22.21.9', '23.11.0', '24.10.0'].map(isSupportedNode)).toEqual([false, false, false, false, false])
  })
})
