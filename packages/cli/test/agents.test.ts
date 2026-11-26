import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeDir, tempDir } from '../../server/test/session-helpers.ts'
import { connectedLine, findRegistrations } from '../src/agents.ts'

describe('findRegistrations: which agents have primp, from their configuration files', () => {
  let root: string
  let home: string
  let project: string
  beforeAll(() => {
    root = tempDir('agents-test')
    home = join(root, 'home')
    project = join(root, 'code', 'shop')
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(project, '.cursor'), { recursive: true })
  })
  afterAll(() => removeDir(root))

  it('nothing configured: none', () => {
    expect(findRegistrations(project, home)).toEqual([])
    expect(connectedLine([])).toBeUndefined()
  })

  it('Claude Code for a parent directory only does not count: it applies to the directory it was started in', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [join(root, 'code')]: { mcpServers: { primp: {} } } } }))
    expect(findRegistrations(project, home)).toEqual([])
  })

  it('Claude Code started at the root of the repository the project is in counts (a monorepo)', () => {
    mkdirSync(join(root, 'code', '.git'), { recursive: true })
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [join(root, 'code')]: { mcpServers: { primp: {} } } } }))
    expect(findRegistrations(project, home)).toEqual([{ client: 'Claude Code', scope: 'this project' }])
    rmSync(join(root, 'code', '.git'), { recursive: true })
  })

  it('a .mcp.json server declined in the project\'s own Claude Code settings does not count', () => {
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { primp: {} } }))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({}))
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ disabledMcpjsonServers: ['primp'] }))
    expect(findRegistrations(project, home)).toEqual([])
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    expect(findRegistrations(project, home)[0]).toEqual({ client: 'Claude Code', scope: 'this project (.mcp.json)' })
    rmSync(join(project, '.claude'), { recursive: true })
    rmSync(join(project, '.mcp.json'))
  })

  it('.mcp.json in the project: counted, unless declined in Claude Code; said to need approval until approved', () => {
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { primp: {} } }))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({}))
    expect(findRegistrations(project, home)[0]).toEqual({ client: 'Claude Code', scope: 'this project (.mcp.json; Claude Code asks to approve it)' })
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { enabledMcpjsonServers: ['primp'] } } }))
    expect(findRegistrations(project, home)[0]).toEqual({ client: 'Claude Code', scope: 'this project (.mcp.json)' })
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { disabledMcpjsonServers: ['primp'] } } }))
    expect(findRegistrations(project, home)).toEqual([])
    rmSync(join(project, '.mcp.json'))
  })

  it('Claude Code for this project, Codex, Cursor in the project', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: {} }, projects: { [project]: { mcpServers: { primp: { command: 'npx' } } } } }))
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.primp]\ncommand = "npx"\n')
    writeFileSync(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { primp: {} } }))
    const found = findRegistrations(project, home)
    expect(found).toEqual([
      { client: 'Claude Code', scope: 'this project' },
      { client: 'Codex', scope: 'every project' },
      { client: 'Cursor', scope: 'this project' },
    ])
    expect(connectedLine(found)).toBe('Claude Code (this project), Codex (every project), Cursor (this project)')
  })

  it('Claude Code for every project wins over one project', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { primp: {} } }))
    expect(findRegistrations(project, home)[0]).toEqual({ client: 'Claude Code', scope: 'every project' })
  })
})
