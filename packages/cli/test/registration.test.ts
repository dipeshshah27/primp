import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claudeRegistration, codexRegistration, cursorConfig, registrationText, shellQuote, shimCommand, type ShimCommand } from '../src/registration.ts'

const PUBLISHED: ShimCommand = { command: 'npx', args: ['-y', 'primp', 'mcp'], fromSource: false }

describe('registration commands', () => {
  it('are the ones spike S6 verified for the published package', () => {
    expect(claudeRegistration(PUBLISHED).line).toBe('claude mcp add primp -- npx -y primp mcp')
    expect(claudeRegistration(PUBLISHED)).toMatchObject({ binary: 'claude', args: ['mcp', 'add', 'primp', '--', 'npx', '-y', 'primp', 'mcp'] })
    expect(codexRegistration(PUBLISHED).line).toBe('codex mcp add primp -- npx -y primp mcp')
    expect(JSON.parse(cursorConfig(PUBLISHED))).toEqual({
      mcpServers: { primp: { type: 'stdio', command: 'npx', args: ['-y', 'primp', 'mcp', '--project', '${workspaceFolder}'] } },
    })
  })

  it('print all three clients in the block shown at start-up', () => {
    const text = registrationText(PUBLISHED)
    expect(text).toContain('claude mcp add primp -- npx -y primp mcp')
    expect(text).toContain('codex mcp add primp -- npx -y primp mcp')
    expect(text).toContain('.cursor/mcp.json')
    expect(text).toContain('"${workspaceFolder}"')
    expect(text).not.toContain('checkout')
  })

  it('from a checkout, start the shim with Node, tsx and the entry file by absolute path', () => {
    const shim = shimCommand()
    expect(shim.fromSource).toBe(true)
    expect(shim.command).toBe(process.execPath)
    expect(shim.args[0]).toBe('--import')
    expect(existsSync(fileURLToPath(shim.args[1] as string))).toBe(true)
    expect(shim.args[2]).toBe(fileURLToPath(new URL('../src/index.ts', import.meta.url)))
    expect(shim.args[3]).toBe('mcp')
    expect(registrationText(shim)).toContain('running from a checkout')
    // The bundled CLI is a .js file: it registers the published form.
    expect(shimCommand('file:///usr/lib/node_modules/primp/dist/cli.js')).toEqual(PUBLISHED)
  })

  it('quote arguments a shell would split or expand', () => {
    expect(shellQuote('plain-arg_1.0/x:y')).toBe('plain-arg_1.0/x:y')
    expect(shellQuote('/Users/sam/my project/cli.ts')).toBe("'/Users/sam/my project/cli.ts'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$HOME')).toBe("'$HOME'")
    const spaced: ShimCommand = { command: '/opt/node 22/bin/node', args: ['--import', 'file:///a b/loader.mjs', '/a b/index.ts', 'mcp'], fromSource: true }
    expect(claudeRegistration(spaced).line).toBe("claude mcp add primp -- '/opt/node 22/bin/node' --import 'file:///a b/loader.mjs' '/a b/index.ts' mcp")
  })
})
