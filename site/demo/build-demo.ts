/**
 * Builds `dist/demo/`: the demo site of `npx primp demo`, copied from packages/cli/demo-site at
 * build time, with the real dock and an in-page stand-in for primp's server.
 *
 *   demo/index.html        the demo's index.html, with same-line additions so every line number
 *                          stays what it is in the original: on the viewport-meta line the
 *                          first-visit bootstrap (bootstrap.ts, inline), the banner's style, the
 *                          stand-in (fake-session.js) and primp's head script;
 *                          before `</body>` the banner. Root-relative URLs (`/css/site.css`) become
 *                          relative, so the demo works below any sub-path.
 *   demo/css, demo/img     copied unchanged
 *   demo/primp/hook.js     \ built from packages/overlay/src/entry/*.ts by the server's own
 *   demo/primp/overlay.js  / buildOverlayAssets (same esbuild options and defines as the CLI)
 *   demo/fake-session.js   site/demo/fake-session.ts and the banner, bundled for the browser
 *   demo/sw.js             site/demo/sw.ts: holds `?delay=` responses back, as the demo server does
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { buildOverlayAssets } from '../../packages/server/src/assets.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
export const DEMO_SITE = join(REPO, 'packages/cli/demo-site')

/**
 * The stand-in imports two pure functions from server and source modules whose other exports
 * read files. Those Node built-ins are replaced by stubs that throw if anything ever called them.
 */
const NODE_NAMES = [
  'readFileSync', 'readdirSync', 'realpathSync', 'statSync', 'existsSync', 'isAbsolute', 'join', 'relative', 'resolve',
  'sep', 'dirname', 'basename', 'extname', 'normalize', 'fileURLToPath', 'pathToFileURL', 'createHash', 'randomBytes',
]
const nodeStubs: Plugin = {
  name: 'node-stubs',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({
      contents: [
        `const fail = () => { throw new Error('${args.path} is not available in the browser demo') }`,
        ...NODE_NAMES.map((name) => (name === 'sep' ? `export const sep = '/'` : `export const ${name} = fail`)),
        'export default {}',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

/**
 * The protocol modules build their zod schemas when they load, which would put all of zod
 * (450 kB minified) into the demo for constants and types. In this bundle `zod` is a stub on
 * which every schema call chains and `safeParse` accepts its input as it is. The only schema use
 * left on this path is the output check of the server's `toSourceLoc`, whose input is the
 * resolver's own result.
 */
const zodStub: Plugin = {
  name: 'zod-stub',
  setup(b) {
    b.onResolve({ filter: /^zod$/ }, () => ({ path: 'zod', namespace: 'zod-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'zod-stub' }, () => ({
      contents: [
        'const accept = (value) => ({ success: true, data: value })',
        'const handler = { get: (_, key) => (key === "safeParse" ? accept : key === "parse" ? (value) => value : schema), apply: () => schema }',
        'const schema = new Proxy(function () {}, handler)',
        'export const z = schema',
        'export default schema',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

const BANNER_STYLE = `<style data-primp-demo>
.pd-banner{position:fixed;left:16px;bottom:16px;z-index:2147483000;box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:14px 16px;border:1px solid #cdd2db;border-radius:12px;background:#fff;color:#171a21;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 6px 24px rgba(23,26,33,.14)}
.pd-banner *{box-sizing:border-box}
.pd-banner p,.pd-banner ol{margin:0}
.pd-banner p+p,.pd-banner p+ol,.pd-banner ol+p{margin-top:8px}
.pd-banner ol{padding-left:20px}
.pd-banner li+li{margin-top:4px}
.pd-banner code,.pd-banner pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px}
.pd-banner code{padding:1px 4px;border-radius:4px;background:#eef0f3}
.pd-banner strong{font-weight:650}
.pd-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}
.pd-banner button,.pd-banner a.pd-link{display:inline-flex;align-items:center;min-height:32px;padding:4px 10px;border:1px solid #cdd2db;border-radius:8px;background:#fff;color:#171a21;font:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer}
.pd-banner button:hover,.pd-banner a.pd-link:hover{background:#f5f6f8}
.pd-banner button:focus-visible,.pd-banner a:focus-visible{outline:2px solid #2456d6;outline-offset:2px}
.pd-banner .pd-close{margin-left:auto}
.pd-more{margin-top:12px;padding-top:12px;border-top:1px solid #e1e4ea}
.pd-more[hidden],.pd-prompt[hidden],.pd-banner[hidden],.pd-pill[hidden]{display:none}
.pd-prompt{margin-top:12px;padding-top:12px;border-top:1px solid #e1e4ea}
.pd-prompt pre{max-height:240px;margin:8px 0 0;padding:10px;overflow:auto;border-radius:8px;background:#f5f6f8;white-space:pre-wrap;word-break:break-word}
.pd-note{color:#5b6472}
.pd-pill{position:fixed;left:16px;bottom:16px;z-index:2147483000;min-height:36px;padding:6px 12px;border:1px solid #cdd2db;border-radius:18px;background:#fff;color:#171a21;font:600 13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(23,26,33,.12)}
.pd-pill:focus-visible{outline:2px solid #2456d6;outline-offset:2px}
@media (max-width:560px){.pd-banner{top:8px;bottom:auto;left:8px;width:calc(100vw - 16px);max-height:calc(100vh - 16px);padding:10px 12px;font-size:13px}.pd-row{margin-top:8px}.pd-pill{top:8px;bottom:auto;left:8px}}
@media (prefers-color-scheme:dark){.pd-banner,.pd-pill{border-color:#444a56;background:#1a1c21;color:#e9ebef}.pd-banner code,.pd-prompt pre{background:#23262d}.pd-banner button,.pd-banner a.pd-link{border-color:#444a56;background:#23262d;color:#e9ebef}.pd-banner button:hover,.pd-banner a.pd-link:hover{background:#30343d}.pd-note{color:#a2abb9}.pd-more,.pd-prompt{border-color:#30343d}.pd-banner button:focus-visible,.pd-banner a:focus-visible,.pd-pill:focus-visible{outline-color:#8fb0ff}}
</style>`

/** The banner. One line: it goes on the line of `</body>`. Carries `data-primp-root`, so the dock, its measurements and the shift recorder leave it out. */
const BANNER = [
  '<aside class="pd-banner" id="pd-banner" data-primp-root aria-labelledby="pd-heading">',
  '<p id="pd-heading"><strong>Live demo.</strong> This runs entirely in your browser: the dock is primp\'s own, and a small stand-in replaces its server. With <code>npx primp</code> it runs on your own app and your agent implements the changes.</p>',
  '<div class="pd-row"><button type="button" id="pd-toggle" aria-expanded="false" aria-controls="pd-more">What to try</button><a class="pd-link" href="../">primp home</a><a class="pd-link" href="../docs/">Docs</a><button type="button" class="pd-close" id="pd-close" aria-label="Hide this note">Hide</button></div>',
  '<div class="pd-more" id="pd-more" hidden>',
  '<ol>',
  '<li>Open the dock\'s <strong>Shifts</strong> tab. The picture under the headline has no reserved space, so everything below it jumps when it loads. primp names the element, the cause and its line in <code>index.html</code>. (Its note that one resource &ldquo;came from a cache&rdquo; is about this demo: the picture is handed over by a service worker that holds it back. With <code>npx primp</code> every response comes from the proxy, uncached.)</li>',
  '<li>In <strong>Edits</strong>, pick the &ldquo;Start a subscription&rdquo; button and change its padding. The dock lists what else on the page moved, and the other button that shares the rule.</li>',
  '<li>Try the <code>:hover</code> state, drag the edge of a bean card, or move a card to another place in the grid.</li>',
  '<li>Press <strong>Send</strong>. The prompt your agent would get appears below, and is copied to your clipboard.</li>',
  '</ol>',
  '<p class="pd-note">Real here: the dock, its measurements, the source lookup, the prompt and the layout-shift attribution, all primp\'s own code. Not here: an agent, and so verification. With <code>npx primp</code>, after your agent edits the source, primp waits for the page to update, measures it again and reports pass, drift or fail for each change. It never reports a pass for something it did not measure.</p>',
  '<p class="pd-note" id="pd-delay" hidden></p>',
  '</div>',
  '<div class="pd-prompt" id="pd-prompt" hidden><p><strong>Send produced this prompt</strong> <span class="pd-note" id="pd-prompt-size"></span></p><pre id="pd-prompt-text" tabindex="0"></pre></div>',
  '</aside>',
  '<button type="button" class="pd-pill" id="pd-pill" data-primp-root hidden>About this demo</button>',
].join('')

/** Root-relative `href`/`src` values made relative, so the page works below a sub-path. */
function relativize(html: string): string {
  return html.replace(/\b(href|src)="\/(?!\/)/g, '$1="./')
}

export function transformDemoHtml(original: string, scripts: { bootstrap: string; fakeSession: string; hook: string }): string {
  let html = relativize(original)
  // After the charset and viewport metas (the charset must stay in the first 1024 bytes), before anything that loads.
  const anchor = html.match(/<meta name="viewport"[^\n]*/)
  if (anchor === null) throw new Error('the demo index.html has no viewport meta line')
  // A data: icon, or Chromium asks the host root for /favicon.ico.
  const additions = `<script>${scripts.bootstrap.trim()}</script><link rel="icon" href="data:,">${BANNER_STYLE.replace(/\n/g, '')}<script src="${scripts.fakeSession}"></script><script src="${scripts.hook}"></script>`
  html = html.replace(anchor[0], `${anchor[0]}${additions}`)
  const bodyEnd = html.lastIndexOf('</body>')
  if (bodyEnd < 0) throw new Error('the demo index.html has no </body>')
  html = `${html.slice(0, bodyEnd)}${BANNER}${html.slice(bodyEnd)}`
  if (html.split('\n').length !== original.split('\n').length) throw new Error('the demo transform changed the number of lines')
  return html
}

export interface DemoBuild {
  files: string[]
  bytes: Record<string, number>
}

export async function buildDemo(outDir: string, version: string): Promise<DemoBuild> {
  const demoOut = join(outDir, 'demo')
  mkdirSync(join(demoOut, 'primp'), { recursive: true })
  for (const dir of ['css', 'img']) cpSync(join(DEMO_SITE, dir), join(demoOut, dir), { recursive: true })

  const assets = await buildOverlayAssets({ prebuiltDir: false })
  writeFileSync(join(demoOut, 'primp/hook.js'), assets.hook.code)
  writeFileSync(join(demoOut, 'primp/overlay.js'), assets.overlay.code)

  const common = { bundle: true, platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', write: false, logLevel: 'silent' } as const
  const session = await build({
    ...common,
    entryPoints: [join(HERE, 'fake-session.ts')],
    format: 'iife',
    plugins: [nodeStubs, zodStub],
    define: { __OVERLAY_URL__: JSON.stringify('primp/overlay.js'), __PRIMP_VERSION__: JSON.stringify(version) },
  })
  const banner = await build({ ...common, entryPoints: [join(HERE, 'banner.ts')], format: 'iife' })
  const worker = await build({ ...common, entryPoints: [join(HERE, 'sw.ts')], format: 'iife' })
  const bootstrap = await build({ ...common, entryPoints: [join(HERE, 'bootstrap.ts')], format: 'iife' })
  const sessionCode = session.outputFiles[0]?.text ?? ''
  const bannerCode = banner.outputFiles[0]?.text ?? ''
  writeFileSync(join(demoOut, 'fake-session.js'), `${sessionCode}\n${bannerCode}`)
  writeFileSync(join(demoOut, 'sw.js'), worker.outputFiles[0]?.text ?? '')

  const html = transformDemoHtml(readFileSync(join(DEMO_SITE, 'index.html'), 'utf8'), { bootstrap: bootstrap.outputFiles[0]?.text ?? '', fakeSession: 'fake-session.js', hook: 'primp/hook.js' })
  writeFileSync(join(demoOut, 'index.html'), html)

  const bytes: Record<string, number> = {
    'demo/primp/hook.js': assets.hook.bytes,
    'demo/primp/overlay.js': assets.overlay.bytes,
    'demo/fake-session.js': Buffer.byteLength(sessionCode) + Buffer.byteLength(bannerCode),
  }
  return { files: ['demo/index.html', 'demo/sw.js', ...Object.keys(bytes)], bytes }
}
