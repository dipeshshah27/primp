import { mkdirSync, writeFileSync } from 'node:fs'
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

  it('Claude Code for one project (a parent directory counts), Codex, Cursor in the project', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: {} }, projects: { [join(root, 'code')]: { mcpServers: { primp: { command: 'npx' } } } } }))
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
