import { existsSync, readFileSync, realpathSync } from 'node:fs'
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

interface ProjectEntry {
  mcpServers?: unknown
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
}

/** The project directory (also by its real path) and the root of the git repository it is in. */
function startDirs(projectRoot: string): string[] {
  const dirs = new Set<string>([resolve(projectRoot)])
  try {
    dirs.add(realpathSync(projectRoot))
  } catch {
    // Not there: the path as given.
  }
  for (let at = resolve(projectRoot); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) {
      dirs.add(at)
      break
    }
    if (dirname(at) === at) break
  }
  return [...dirs]
}

const hasServer = (config: unknown): boolean => {
  const servers = (config as { mcpServers?: unknown } | undefined)?.mcpServers
  return typeof servers === 'object' && servers !== null && Object.hasOwn(servers, MCP_SERVER_NAME)
}

export function findRegistrations(projectRoot: string, home: string = homedir()): AgentRegistration[] {
  const found: AgentRegistration[] = []

  // Claude Code keys a project's own servers by the directory it was started in: the project itself,
  // or the root of the repository it is in (a monorepo opened at its root). Not any parent.
  const claude = readJson(join(home, '.claude.json')) as { mcpServers?: unknown; projects?: Record<string, ProjectEntry> } | undefined
  const keys = startDirs(projectRoot)
  const entries = keys.map((dir) => claude?.projects?.[dir]).filter((entry): entry is ProjectEntry => entry !== undefined)
  const project = entries.find((entry) => hasServer(entry)) ?? entries[0]
  // Approvals of .mcp.json servers: in ~/.claude.json, or in the project's own Claude Code settings.
  const settings = [project, readJson(join(projectRoot, '.claude', 'settings.json')), readJson(join(projectRoot, '.claude', 'settings.local.json'))] as (ProjectEntry & { enableAllProjectMcpServers?: unknown } | undefined)[]
  const listed = (key: 'enabledMcpjsonServers' | 'disabledMcpjsonServers'): boolean => settings.some((one) => Array.isArray(one?.[key]) && (one[key] as unknown[]).includes(MCP_SERVER_NAME))
  const declined = listed('disabledMcpjsonServers')
  if (hasServer(claude)) found.push({ client: 'Claude Code', scope: 'every project' })
  else if (hasServer(project)) found.push({ client: 'Claude Code', scope: 'this project' })
  else if (!declined && hasServer(readJson(join(projectRoot, '.mcp.json')))) {
    // A server from .mcp.json runs once the person approved it in Claude Code.
    const approved = listed('enabledMcpjsonServers') || settings.some((one) => one?.enableAllProjectMcpServers === true)
    found.push({ client: 'Claude Code', scope: approved ? 'this project (.mcp.json)' : 'this project (.mcp.json; Claude Code asks to approve it)' })
  }

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
