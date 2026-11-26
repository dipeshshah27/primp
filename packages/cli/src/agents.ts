import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { MCP_SERVER_NAME } from './registration.ts'

/**
 * Which coding agents already have primp's MCP server, read from their configuration files (never
 * by running them: `claude mcp get` starts the server to check its health). Used by the start-up
 * lines, to say "connected" instead of printing the registration commands every time, and by
 * doctor.
 *
 *   Claude Code  ~/.claude.json: `mcpServers` (every project) and `projects[<dir>].mcpServers`
 *                (that project); `.mcp.json` in the project (shared with the team)
 *   Codex        ~/.codex/config.toml: a `[mcp_servers.primp]` table
 *   Cursor       .cursor/mcp.json in the project, or ~/.cursor/mcp.json
 */

export interface AgentRegistration {
  client: 'Claude Code' | 'Codex' | 'Cursor'
  /** Where it is registered, in words: `every project`, `this project`. */
  scope: string
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const hasServer = (config: unknown): boolean => {
  const servers = (config as { mcpServers?: unknown } | undefined)?.mcpServers
  return typeof servers === 'object' && servers !== null && Object.hasOwn(servers, MCP_SERVER_NAME)
}

/** The project directory and the ones above it: Claude Code keys a project's settings by the directory it was started in. */
function upFrom(dir: string): string[] {
  const out: string[] = []
  for (let at = resolve(dir); ; at = dirname(at)) {
    out.push(at)
    if (dirname(at) === at) return out
  }
}

export function findRegistrations(projectRoot: string, home: string = homedir()): AgentRegistration[] {
  const found: AgentRegistration[] = []

  const claude = readJson(join(home, '.claude.json')) as { mcpServers?: unknown; projects?: Record<string, unknown> } | undefined
  if (hasServer(claude)) found.push({ client: 'Claude Code', scope: 'every project' })
  else if (upFrom(projectRoot).some((dir) => hasServer(claude?.projects?.[dir]))) found.push({ client: 'Claude Code', scope: 'this project' })
  else if (hasServer(readJson(join(projectRoot, '.mcp.json')))) found.push({ client: 'Claude Code', scope: 'this project (.mcp.json)' })

  try {
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    if (new RegExp(`^\\s*\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`, 'm').test(toml)) found.push({ client: 'Codex', scope: 'every project' })
  } catch {
    // No Codex configuration.
  }

  if (hasServer(readJson(join(projectRoot, '.cursor', 'mcp.json')))) found.push({ client: 'Cursor', scope: 'this project' })
  else if (existsSync(join(home, '.cursor', 'mcp.json')) && hasServer(readJson(join(home, '.cursor', 'mcp.json')))) found.push({ client: 'Cursor', scope: 'every project' })

  return found
}

/** One line for the start-up block: the agents that have primp, or undefined when none does. */
export function connectedLine(found: readonly AgentRegistration[]): string | undefined {
  if (found.length === 0) return undefined
  return found.map((one) => `${one.client} (${one.scope})`).join(', ')
}
