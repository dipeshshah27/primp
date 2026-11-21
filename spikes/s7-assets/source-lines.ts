/**
 * Spike S7, section E: from the culprit the attributor named to a file and line.
 *
 * Two routes, depending on where the culprit comes from:
 *   - an element written in the HTML: packages/source's static-HTML resolver
 *     (the element's structural path, looked up in the parsed file);
 *   - an element a script inserted: the JavaScript stack of the DOM call, which
 *     the hook captures when it is built with stack capture.
 *
 * packages/source belongs to another work stream and is loaded lazily: if it
 * cannot be loaded, the section reports itself as unavailable instead of failing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser } from '@playwright/test'
import { bundleBrowser, newPage, REPO_ROOT, startProxy, type FixtureHandle } from '../lib/index.ts'
import { measureLoad, navigate, type CorpusPage } from './corpus.ts'
import { hookScript } from './measure.ts'

export interface SourceRow {
  page: string
  culprit: string
  kind: 'opening-tag' | 'script-insert'
  expected: string
  got: string
  via: string
  ok: boolean
}

export interface SourceOutcome {
  unavailable?: string
  rows: SourceRow[]
}

/** `/delay/700/injected-content/x/consent.js` or `/injected-content/x/` to a path inside the corpus. */
function fileOfUrl(url: string): string {
  let path = new URL(url).pathname.replace(/^\/delay\/\d+/, '')
  if (path.endsWith('/')) path += 'index.html'
  return path.replace(/^\//, '')
}

/** File and line of the first frame of a V8 stack. */
function firstFrame(stack: string | undefined): { file: string; line: number } | undefined {
  const match = /(https?:\/\/[^\s)]+?):(\d+):\d+\)?\s*$/m.exec(stack ?? '')
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { file: fileOfUrl(match[1]), line: Number(match[2]) }
}

export async function resolveSources(browser: Browser, corpus: FixtureHandle, pages: CorpusPage[]): Promise<SourceOutcome> {
  let locateByPath: typeof import('../../packages/source/src/node/static-html.ts').locateByPath
  let probe: string
  try {
    ;({ locateByPath } = await import('../../packages/source/src/node/static-html.ts'))
    probe = await bundleBrowser(join(REPO_ROOT, 'spikes/s7-assets/source-probe.ts'))
  } catch (error) {
    return { unavailable: `packages/source could not be loaded: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, rows: [] }
  }

  const proxy = await startProxy(corpus, { headScripts: [hookScript({ stacks: true })] })
  const rows: SourceRow[] = []
  try {
    for (const page of pages) {
      const handle = await newPage(browser)
      try {
        await navigate(handle.page, { kind: 'goto', url: proxy.url + page.path })
        const load = await measureLoad(handle.page, page.expected, page.expected.shifts.map((shift) => shift.culpritSelector))
        await handle.page.addScriptTag({ content: probe })
        for (const [index, want] of page.expected.shifts.entries()) {
          const issue = load.scored[index]
          const row: SourceRow = { page: page.name, culprit: issue?.culprit?.node.selector ?? '-', kind: want.culpritLineKind, expected: `${want.culpritFile}:${want.culpritLine}`, got: '-', via: '-', ok: false }
          rows.push(row)
          if (issue?.culprit === undefined) continue
          if (want.culpritLineKind === 'script-insert') {
            const frame = firstFrame(issue.trigger?.stack)
            row.via = 'stack of the DOM call'
            if (frame !== undefined) row.got = `${frame.file}:${frame.line}`
          } else {
            const selector = issue.culprit.node.selector
            const context = await handle.page.evaluate((sel) => window.__s7Context?.(sel) ?? null, selector)
            row.via = 'static-HTML resolver'
            if (context === null) continue
            const file = fileOfUrl(proxy.url + context.pagePath)
            const located = locateByPath(readFileSync(join(corpus.sourceDir, file), 'utf8'), context.path, context)
            if (located !== undefined) {
              row.got = `${file}:${located.line}`
              row.via += located.exact ? ' (exact)' : ' (inexact)'
            }
          }
          row.ok = row.got === row.expected
        }
      } finally {
        await handle.close()
      }
    }
  } finally {
    await proxy.close()
  }
  return { rows }
}
