import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeDir, tempDir } from '../../server/test/session-helpers.ts'
import type { ShimCommand } from '../src/registration.ts'
import { isOnPath, runSetup, type SetupDeps } from '../src/setup.ts'

/**
 * `reglet setup` with every outside effect replaced: nothing here starts
 * `claude` or `codex`, and nothing touches a client's configuration.
 */

const SHIM: ShimCommand = { command: 'npx', args: ['-y', 'reglet', 'mcp'], fromSource: false }

interface Script {
  installed: string[]
  answers: boolean[]
  exitCodes?: Record<string, number>
}

function deps(script: Script): SetupDeps & { printed: string[]; asked: string[]; ran: [string, string[]][] } {
  const printed: string[] = []
  const asked: string[] = []
  const ran: [string, string[]][] = []
  const answers = [...script.answers]
  return {
    printed,
    asked,
    ran,
    has: (binary) => script.installed.includes(binary),
    async confirm(question) {
      asked.push(question)
      return answers.shift() ?? false
    },
    async exec(binary, args) {
      ran.push([binary, args])
      return script.exitCodes?.[binary] ?? 0
    },
    print: (line) => printed.push(line),
  }
}

describe('reglet setup', () => {
  it('asks once per installed client and runs that client\'s own command on yes', async () => {
    const d = deps({ installed: ['claude', 'codex'], answers: [true, true] })
    const outcomes = await runSetup(d, { shim: SHIM })
    expect(d.asked).toHaveLength(2)
    expect(d.ran).toEqual([
      ['claude', ['mcp', 'add', 'reglet', '--', 'npx', '-y', 'reglet', 'mcp']],
      ['codex', ['mcp', 'add', 'reglet', '--', 'npx', '-y', 'reglet', 'mcp']],
    ])
    expect(outcomes).toEqual([
      { client: 'Claude Code', result: 'registered', exitCode: 0 },
      { client: 'Codex', result: 'registered', exitCode: 0 },
    ])
    // The command is shown before the question, so the user knows what they agree to.
    expect(d.printed.indexOf('  claude mcp add reglet -- npx -y reglet mcp')).toBeGreaterThan(-1)
  })

  it('runs nothing on no (the default answer)', async () => {
    const d = deps({ installed: ['claude', 'codex'], answers: [false] })
    const outcomes = await runSetup(d, { shim: SHIM })
    expect(d.ran).toEqual([])
    expect(outcomes.map((outcome) => outcome.result)).toEqual(['declined', 'declined'])
  })

  it('does not ask about a client whose CLI is missing, and prints the command for later', async () => {
    const d = deps({ installed: ['codex'], answers: [true] })
    const outcomes = await runSetup(d, { shim: SHIM })
    expect(d.asked).toHaveLength(1)
    expect(d.ran.map(([binary]) => binary)).toEqual(['codex'])
    expect(outcomes.map((outcome) => outcome.result)).toEqual(['not-installed', 'registered'])
    expect(d.printed).toContain('  claude mcp add reglet -- npx -y reglet mcp')
    expect(d.printed.some((line) => line.includes('`claude` command was not found'))).toBe(true)
  })

  it('--yes skips the question, not the check that the CLI exists', async () => {
    const d = deps({ installed: ['claude'], answers: [] })
    const outcomes = await runSetup(d, { shim: SHIM, yes: true })
    expect(d.asked).toEqual([])
    expect(d.ran.map(([binary]) => binary)).toEqual(['claude'])
    expect(outcomes.map((outcome) => outcome.result)).toEqual(['registered', 'not-installed'])
  })

  it('reports a failing client command and carries on with the next client', async () => {
    const d = deps({ installed: ['claude', 'codex'], answers: [true, true], exitCodes: { claude: 1 } })
    const outcomes = await runSetup(d, { shim: SHIM })
    expect(outcomes).toEqual([
      { client: 'Claude Code', result: 'failed', exitCode: 1 },
      { client: 'Codex', result: 'registered', exitCode: 0 },
    ])
    expect(d.printed.some((line) => line.includes('`claude` exited with code 1'))).toBe(true)
  })

  it('always prints the Cursor JSON and never runs anything for Cursor', async () => {
    const d = deps({ installed: [], answers: [] })
    await runSetup(d, { shim: SHIM })
    const json = d.printed.at(-1) ?? ''
    expect(JSON.parse(json).mcpServers.reglet.args).toEqual(['-y', 'reglet', 'mcp', '--project', '${workspaceFolder}'])
    expect(d.printed.at(-2)).toMatch(/Cursor: put this in \.cursor\/mcp\.json/)
    expect(d.ran).toEqual([])
  })
})

describe('isOnPath', () => {
  let dir: string
  beforeAll(() => {
    dir = tempDir('setup-test')
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'other'))
    writeFileSync(join(dir, 'bin', 'fakeclient'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'bin', 'fakeclient'), 0o755)
    writeFileSync(join(dir, 'bin', 'notexec'), 'data')
    chmodSync(join(dir, 'bin', 'notexec'), 0o644)
    mkdirSync(join(dir, 'bin', 'adir'))
    writeFileSync(join(dir, 'bin', 'tool.CMD'), '@echo off\r\n')
  })
  afterAll(() => removeDir(dir))

  it.skipIf(process.platform === 'win32')('finds executables in PATH directories only', () => {
    const env = { PATH: [join(dir, 'other'), '', join(dir, 'bin')].join(delimiter) }
    expect(isOnPath('fakeclient', env)).toBe(true)
    expect(isOnPath('notexec', env)).toBe(false)
    expect(isOnPath('adir', env)).toBe(false)
    expect(isOnPath('missing', env)).toBe(false)
    expect(isOnPath('fakeclient', { PATH: join(dir, 'other') })).toBe(false)
    expect(isOnPath('fakeclient', {})).toBe(false)
  })

  it('tries the PATHEXT extensions on Windows', () => {
    // One PATH entry, so the host's list separator does not matter.
    const env = { Path: join(dir, 'bin'), PATHEXT: '.EXE;.CMD' }
    expect(isOnPath('tool', env, 'win32')).toBe(true)
    expect(isOnPath('fakeclient', env, 'win32')).toBe(false)
  })
})
