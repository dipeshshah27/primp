#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import pkg from '../package.json' with { type: 'json' }

/**
 * Entry point of the `primp` binary.
 *
 *   primp [--target <url|port>] [--port <n>] [--exec "<command>"] [--project <dir>] [--no-open]
 *   primp setup     register the MCP server with the coding agents on this machine
 *   primp doctor    report what primp sees: Node, project, framework, dev server, session, bundles
 *   primp mcp       the stdio MCP server an agent host starts
 *
 * From a checkout it runs without a build step:
 *
 *   node --import tsx packages/cli/src/index.ts mcp
 *
 * (`--import tsx` is resolved from the working directory; when the command is
 * started somewhere else, as an agent host does, pass the absolute path or
 * file URL of node_modules/tsx/dist/loader.mjs instead.)
 *
 * citty runs a parent command's `run` after a subcommand has returned. The
 * default command lives in that parent `run`, so every subcommand sets
 * `subcommandRan` and the parent returns early when it is set.
 */

requireSupportedNode()

let subcommandRan = false

const projectArg = {
  type: 'string',
  valueHint: 'directory',
  description: 'Project directory to use instead of the working directory',
} as const

const mcp = defineCommand({
  meta: {
    name: 'mcp',
    description: 'Stdio MCP server that connects a coding agent to the primp process running for this project',
  },
  args: { project: projectArg },
  async run({ args }) {
    subcommandRan = true
    // Loaded here so other commands do not pay for the MCP SDK.
    const { runShim } = await import('./mcp-shim.ts')
    runShim({ cwd: args.project || process.cwd(), version: pkg.version })
    // Nothing else to do: the process ends when the client closes stdin.
  },
})

const setup = defineCommand({
  meta: {
    name: 'setup',
    description: 'Register the primp MCP server with Claude Code and Codex (asks first) and print the Cursor configuration',
  },
  args: {
    yes: { type: 'boolean', alias: 'y', description: 'Run the registration commands without asking' },
  },
  async run({ args }) {
    subcommandRan = true
    const { runSetup, terminalSetupDeps } = await import('./setup.ts')
    const outcomes = await runSetup(terminalSetupDeps(), { yes: args.yes === true })
    if (outcomes.some((outcome) => outcome.result === 'failed')) process.exitCode = 1
  },
})

const doctor = defineCommand({
  meta: { name: 'doctor', description: 'Check the environment: Node, project, framework, dev server, running session, overlay bundles' },
  args: { project: projectArg },
  async run({ args }) {
    subcommandRan = true
    const { resolve } = await import('node:path')
    const { runDoctor, defaultDoctorDeps } = await import('./doctor.ts')
    const assets =
      process.env.PRIMP_HOOK_ENTRY !== undefined || process.env.PRIMP_OVERLAY_ENTRY !== undefined
        ? { hookEntry: process.env.PRIMP_HOOK_ENTRY, overlayEntry: process.env.PRIMP_OVERLAY_ENTRY }
        : undefined
    process.exitCode = await runDoctor(resolve(args.project || process.cwd()), defaultDoctorDeps({ assets }))
  },
})

const demo = defineCommand({
  meta: { name: 'demo', description: 'Try primp on a small demo site with one seeded layout shift (copied to ./primp-demo)' },
  args: {
    dir: { type: 'string', valueHint: 'directory', description: 'Where to put the demo site (default: ./primp-demo)' },
    open: { type: 'boolean', default: true, description: 'Open the browser on the demo', negativeDescription: 'Do not open the browser' },
  },
  async run({ args }) {
    subcommandRan = true
    const { DemoError, demoGuide, prepareDemo, startDemoServer } = await import('./demo.ts')
    const { CliError, runPrimp } = await import('./run.ts')
    let closers: (() => Promise<void>)[] = []
    let stopping = false
    const stop = (code: number): void => {
      if (stopping) return
      stopping = true
      const pending = closers
      closers = []
      void Promise.allSettled(pending.map((close) => close())).finally(() => process.exit(code))
    }
    process.on('SIGINT', () => stop(130))
    process.on('SIGTERM', () => stop(143))
    process.on('SIGHUP', () => stop(129))
    try {
      const site = prepareDemo(args.dir || 'primp-demo')
      const server = await startDemoServer(site.dir)
      closers.push(() => server.close())
      process.stdout.write(`primp: demo site ${site.created ? 'created in' : 'found in'} ${site.dir}, served at ${server.url}\n`)
      const running = await runPrimp({ project: site.dir, target: String(server.port), open: args.open, version: pkg.version })
      closers.push(() => running.close())
      process.stdout.write(`\n${demoGuide(site.dir)}\n`)
    } catch (error) {
      if (!(error instanceof CliError) && !(error instanceof DemoError)) throw error
      process.stderr.write(`${error.message}\n`)
      stop(1)
    }
  },
})

const main = defineCommand({
  meta: { name: 'primp', version: pkg.version, description: pkg.description },
  args: {
    target: { type: 'string', valueHint: 'url|port', description: 'The dev server to put the proxy in front of (default: found by looking at the processes of this project)' },
    port: { type: 'string', valueHint: 'n', description: 'Port for the proxy (default: the dev server port + 1, or the next free one)' },
    exec: { type: 'string', valueHint: 'command', description: 'Start the dev server with this command and stop it again on exit, for example --exec "npm run dev"' },
    project: projectArg,
    open: { type: 'boolean', default: true, description: 'Open the browser on the proxy URL', negativeDescription: 'Do not open the browser' },
  },
  subCommands: { demo, mcp, setup, doctor },
  async run({ args }) {
    if (subcommandRan) return
    const { CliError, runPrimp } = await import('./run.ts')
    let running: Awaited<ReturnType<typeof runPrimp>> | undefined
    let stopping = false
    const stop = (code: number): void => {
      if (stopping) return
      stopping = true
      // Still starting: leaving through process.exit runs the exit hooks, which stop a dev server
      // started with --exec and remove a session file that was already written.
      if (running === undefined) process.exit(code)
      void running.close().finally(() => process.exit(code))
    }
    // Installed before anything is started, so an interrupt during start-up cleans up as well.
    process.on('SIGINT', () => stop(130))
    process.on('SIGTERM', () => stop(143))
    process.on('SIGHUP', () => stop(129))
    try {
      running = await runPrimp({
        project: args.project,
        target: args.target,
        port: args.port,
        exec: args.exec,
        open: args.open,
        version: pkg.version,
      })
      // Only happens with --exec: without its dev server there is nothing left to show.
      void running.devServerExit.then((code) => stop(code === 0 ? 0 : 1))
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
  },
})

await runMain(main)

/** Mirrors the "engines" field of package.json; checked before anything else runs. */
function requireSupportedNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const supported = (major === 22 && minor >= 22) || (major === 24 && minor >= 11) || major > 24
  if (supported) return
  process.stderr.write(`primp needs Node ^22.22.0 or >=24.11.0; this is ${process.versions.node}.\n`)
  process.exit(1)
}
