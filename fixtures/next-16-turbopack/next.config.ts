import { realpathSync } from 'node:fs'
import { dirname, join, parse, sep } from 'node:path'
import type { NextConfig } from 'next'

const here = import.meta.dirname

/**
 * Turbopack only compiles files under its root and does not follow a
 * node_modules symlink that leads outside it. Tests run this fixture from a
 * copy whose node_modules is a symlink back to the checked-in fixture, so the
 * root has to be the closest directory that contains both. With a real
 * node_modules directory that is simply this directory, which also keeps
 * Turbopack from picking the repo root because of the lockfile there.
 */
function turbopackRoot(): string {
  const modulesParent = dirname(realpathSync(join(here, 'node_modules')))
  const a = realpathSync(here).split(sep)
  const b = modulesParent.split(sep)
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1
  return a.slice(0, shared).join(sep) || parse(here).root
}

const nextConfig: NextConfig = {
  turbopack: {
    root: turbopackRoot(),
  },
  // By default `next dev` writes an AGENTS.md into the project when it detects
  // an AI coding agent in the environment. A fixture must not change its own
  // directory depending on who starts it, so that is off.
  agentRules: false,
  // Deliberately NOT set: experimental.serverActions.allowedOrigins and
  // allowedDevOrigins. A proxy in front of this app has to make Server
  // Actions and dev assets work on its own.
}

export default nextConfig
