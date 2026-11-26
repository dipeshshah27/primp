import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { claudeRegistration, codexRegistration, cursorConfig, shimCommand, type ClientRegistration, type ShimCommand } from './registration.ts'

/**
 * `primp setup`: registers the MCP shim with the coding agents installed on
 * this machine.
 *
 * For Claude Code and Codex it runs the client's own `mcp add` command, after
 * asking, and only when the client's CLI is on PATH. For Cursor it prints the
 * JSON to paste. It never opens or writes a client's configuration file: what
 * ends up in them is decided by the client's own command.
 */

export interface SetupDeps {
  /** Whether a client's CLI can be started. */
  has(binary: string): boolean | Promise<boolean>
  /** Asks a yes/no question; false on anything but yes. */
  confirm(question: string): Promise<boolean>
  /** Runs the client's command with its output shown; resolves with the exit code. */
  exec(binary: string, args: string[]): Promise<number>
  /** Runs a client's command with its output hidden; resolves with the exit code. Absent: nothing is checked first. */
  probe?(binary: string, args: string[]): Promise<number>
  print(line: string): void
}

export interface SetupOptions {
  /** Do not ask. */
  yes?: boolean
  shim?: ShimCommand
}

export interface SetupOutcome {
  client: string
  result: 'registered' | 'already' | 'failed' | 'declined' | 'not-installed'
  exitCode?: number
}

export async function runSetup(deps: SetupDeps, options: SetupOptions = {}): Promise<SetupOutcome[]> {
  const shim = options.shim ?? shimCommand()
  const outcomes: SetupOutcome[] = []
  const clients: ClientRegistration[] = [claudeRegistration(shim), codexRegistration(shim)]

  for (const registration of clients) {
    if (!(await deps.has(registration.binary))) {
      deps.print(`${registration.client}: the \`${registration.binary}\` command was not found. Once it is installed, run:`)
      deps.print(`  ${registration.line}`)
      outcomes.push({ client: registration.client, result: 'not-installed' })
      continue
    }
    if (deps.probe !== undefined && (await deps.probe(registration.binary, registration.check)) === 0) {
      deps.print(`${registration.client}: already connected to primp; nothing to do.`)
      outcomes.push({ client: registration.client, result: 'already' })
      continue
    }
    deps.print(`${registration.client}: primp can register itself by running`)
    deps.print(`  ${registration.line}`)
    const agreed = options.yes === true || (await deps.confirm(`Run it now? [y/N] `))
    if (!agreed) {
      deps.print('  skipped; run the command yourself whenever you like.')
      outcomes.push({ client: registration.client, result: 'declined' })
      continue
    }
    const exitCode = await deps.exec(registration.binary, registration.args)
    if (exitCode === 0) {
      deps.print(`  registered with ${registration.client}.`)
      outcomes.push({ client: registration.client, result: 'registered', exitCode })
    } else {
      deps.print(`  \`${registration.binary}\` exited with code ${exitCode}; its message is above.`)
      outcomes.push({ client: registration.client, result: 'failed', exitCode })
    }
  }

  deps.print('Cursor: put this in .cursor/mcp.json in the project (primp does not write it for you):')
  deps.print(cursorConfig(shim))
  return outcomes
}

/** Whether `binary` is an executable file in one of the PATH directories. */
export function isOnPath(binary: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = join(dir, binary + extension)
      try {
        if (!statSync(candidate).isFile()) continue
        if (platform !== 'win32') accessSync(candidate, constants.X_OK)
        return true
      } catch {
        // Not here.
      }
    }
  }
  return false
}

function run(binary: string, args: string[], stdio: 'inherit' | 'ignore'): Promise<number> {
  return new Promise<number>((resolve) => {
    // Windows installs these CLIs as .cmd shims, which only a shell can start.
    const child = spawn(binary, args, { stdio, shell: process.platform === 'win32' })
    child.once('error', () => resolve(127))
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

/** The real thing: PATH lookup, a terminal prompt, and the client's command with inherited stdio. */
export function terminalSetupDeps(): SetupDeps {
  return {
    has: (binary) => isOnPath(binary),
    async confirm(question) {
      // Without a terminal nobody can answer, and "no" is the safe answer.
      if (!process.stdin.isTTY || !process.stdout.isTTY) return false
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return /^y(es)?$/i.test((await prompt.question(question)).trim())
      } finally {
        prompt.close()
      }
    },
    exec: (binary, args) => run(binary, args, 'inherit'),
    probe: (binary, args) => run(binary, args, 'ignore'),
    print: (line) => process.stdout.write(`${line}\n`),
  }
}
