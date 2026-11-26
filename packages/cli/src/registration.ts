import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * How a coding agent is told about `primp mcp`.
 *
 * The commands are the ones spike S6 verified against the clients (see
 * `printRegistration` in spikes/s6-mcp.ts): each client's own `mcp add`
 * command for Claude Code and Codex, and a `.cursor/mcp.json` entry for
 * Cursor. primp prints them, or (in `primp setup`, after asking) runs the
 * client's command. It never edits a client's configuration file itself.
 */

export const MCP_SERVER_NAME = 'primp'

/**
 * How to run primp from a terminal, in advice the CLI prints. Most people run it with npx and have
 * no `primp` on their PATH; the npx form works for a global install too.
 */
export const SELF = 'npx @primpdev/cli'

/** The command line that starts the stdio shim. */
export interface ShimCommand {
  command: string
  args: string[]
  /** True when this is a checkout running from TypeScript sources, not the published package. */
  fromSource: boolean
}

/**
 * `npx -y @primpdev/cli mcp` for the published package. From a checkout, the shim
 * is started the way the CLI itself was: Node with
 * tsx's loader and the entry file, both as absolute paths so it works from any
 * working directory an agent host picks.
 */
export function shimCommand(entryUrl: string = import.meta.url): ShimCommand {
  if (!entryUrl.endsWith('.ts')) return { command: 'npx', args: ['-y', '@primpdev/cli', 'mcp'], fromSource: false }
  const entry = fileURLToPath(new URL('./index.ts', entryUrl))
  let loader = 'tsx'
  try {
    loader = pathToFileURL(createRequire(entryUrl).resolve('tsx')).href
  } catch {
    // Left as the bare name; Node resolves it from the working directory.
  }
  return { command: process.execPath, args: ['--import', loader, entry, 'mcp'], fromSource: true }
}

/** Quotes one argument for a POSIX shell when it needs it. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

export interface ClientRegistration {
  /** Display name. */
  client: string
  /** The client's CLI binary. */
  binary: string
  /** Arguments that register the shim. */
  args: string[]
  /** The same as one line for a terminal. */
  line: string
  /** Arguments that exit 0 when the shim is registered already (and print nothing that matters). */
  check: string[]
}

/** Claude Code: in the user scope, so it is registered once for every project (its default scope is this project only). */
export function claudeRegistration(shim: ShimCommand): ClientRegistration {
  const args = ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', shim.command, ...shim.args]
  return { client: 'Claude Code', binary: 'claude', args, line: ['claude', ...args].map(shellQuote).join(' '), check: ['mcp', 'get', MCP_SERVER_NAME] }
}

/** Codex keeps its MCP servers in one configuration for the user. */
export function codexRegistration(shim: ShimCommand): ClientRegistration {
  const args = ['mcp', 'add', MCP_SERVER_NAME, '--', shim.command, ...shim.args]
  return { client: 'Codex', binary: 'codex', args, line: ['codex', ...args].map(shellQuote).join(' '), check: ['mcp', 'get', MCP_SERVER_NAME] }
}

/** Contents for `.cursor/mcp.json` in the project. Cursor starts servers outside the project, hence `--project`. */
export function cursorConfig(shim: ShimCommand): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: shim.command, args: [...shim.args, '--project', '${workspaceFolder}'] } } },
    null,
    2,
  )
}

/** The block the default command prints once primp is running. */
export function registrationText(shim: ShimCommand): string {
  const indent = (text: string, by: string): string => text.split('\n').map((line) => by + line).join('\n')
  return [
    `Connect a coding agent (once per machine, or let \`${SELF} setup\` do it):`,
    `  Claude Code   ${claudeRegistration(shim).line}`,
    `  Codex         ${codexRegistration(shim).line}`,
    '  Cursor        put this in .cursor/mcp.json in the project:',
    indent(cursorConfig(shim), '                  '),
    ...(shim.fromSource ? ['  (running from a checkout: the published package registers as `npx -y @primpdev/cli mcp`)'] : []),
  ].join('\n')
}
