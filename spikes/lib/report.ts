/**
 * Check reporting for spikes: prints each check as it finishes, then a table,
 * and decides the exit code.
 *
 * The rules, which no spike may bend:
 *   - a check passes only when its code measured a pass;
 *   - a check that threw has failed;
 *   - a skipped check is listed and FAILS the run, unless the spike declared
 *     it optional and gave the reason;
 *   - `n/a` is for a criterion that does not exist on a fixture (no auth on a
 *     static site); it must carry the reason and is listed, not counted.
 */

export type CheckResult = 'pass' | 'fail' | 'skipped' | 'optional-skip' | 'n/a'

export interface CheckEntry {
  /** Section the check was recorded under. */
  group: string
  name: string
  result: CheckResult
  /** Measured numbers, or the reason for a skip. */
  evidence: string
}

export interface Report {
  entries: CheckEntry[]
  /** Starts a section; later checks belong to it. */
  section(title: string): void
  /** Records a measured result. Returns `pass` so callers can branch on it. */
  check(name: string, pass: boolean, evidence: string): boolean
  /**
   * Runs `body` as one check. It returns the evidence text for a pass, or
   * throws (use `expect`) for a fail. The error message becomes the evidence.
   */
  attempt(name: string, body: () => Promise<string> | string): Promise<boolean>
  /** A check that could not run. Fails the run unless `optional` is set, which requires the reason to say why that is acceptable. */
  skip(name: string, reason: string, options?: { optional?: boolean }): void
  /** A criterion that does not apply to this fixture. Listed, not counted. */
  notApplicable(name: string, reason: string): void
  /** An informational line (a measurement that is not a criterion). */
  info(line: string): void
  /** True when nothing so far has failed or been skipped without being optional. */
  ok(): boolean
  /** Prints the table and the verdict, sets `process.exitCode`, returns it. */
  finish(): number
}

/** Throws with `message` when `condition` is false; for use inside `report.attempt`. */
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const LABEL: Record<CheckResult, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'SKIP',
  'optional-skip': 'skip',
  'n/a': 'n/a ',
}

export function createReport(title: string): Report {
  const entries: CheckEntry[] = []
  let group = ''
  const started = performance.now()

  const add = (name: string, result: CheckResult, evidence: string): void => {
    entries.push({ group, name, result, evidence })
    console.log(`  ${LABEL[result]}  ${name}\n        ${evidence.replace(/\n/g, '\n        ')}`)
  }
  const failing = (entry: CheckEntry): boolean => entry.result === 'fail' || entry.result === 'skipped'

  const report: Report = {
    entries,
    section(sectionTitle) {
      group = sectionTitle
      console.log(`\n== ${sectionTitle}`)
    },
    check(name, pass, evidence) {
      add(name, pass ? 'pass' : 'fail', evidence)
      return pass
    },
    async attempt(name, body) {
      try {
        add(name, 'pass', await body())
        return true
      } catch (error) {
        add(name, 'fail', error instanceof Error ? error.message : String(error))
        return false
      }
    },
    skip(name, reason, options = {}) {
      add(name, options.optional === true ? 'optional-skip' : 'skipped', reason)
    },
    notApplicable(name, reason) {
      add(name, 'n/a', reason)
    },
    info(line) {
      console.log(`  info  ${line.replace(/\n/g, '\n        ')}`)
    },
    ok: () => !entries.some(failing),
    finish() {
      const count = (result: CheckResult): number => entries.filter((entry) => entry.result === result).length
      const groupWidth = Math.max(5, ...entries.map((entry) => entry.group.length))
      console.log(`\n${'='.repeat(100)}\n${title}\n${'='.repeat(100)}`)
      for (const entry of entries) {
        console.log(`${LABEL[entry.result]}  ${entry.group.padEnd(groupWidth)}  ${entry.name}`)
      }
      const problems = entries.filter(failing)
      if (problems.length > 0) {
        console.log('\nFailed or skipped:')
        for (const entry of problems) {
          console.log(`  ${LABEL[entry.result]}  [${entry.group}] ${entry.name}\n        ${entry.evidence.replace(/\n/g, '\n        ')}`)
        }
      }
      const optional = entries.filter((entry) => entry.result === 'optional-skip')
      if (optional.length > 0) {
        console.log('\nOptional checks that did not run (declared optional by the spike):')
        for (const entry of optional) console.log(`  [${entry.group}] ${entry.name}: ${entry.evidence}`)
      }
      const code = problems.length === 0 && count('pass') > 0 ? 0 : 1
      const seconds = ((performance.now() - started) / 1000).toFixed(1)
      console.log(
        `\n${count('pass')} passed, ${count('fail')} failed, ${count('skipped')} skipped (counted as failed), ` +
          `${count('optional-skip')} optional not run, ${count('n/a')} not applicable; ${seconds} s`,
      )
      console.log(code === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
      process.exitCode = code
      return code
    },
  }
  return report
}
