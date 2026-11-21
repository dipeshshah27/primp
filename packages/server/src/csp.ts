import { randomBytes } from 'node:crypto'

/**
 * Content-Security-Policy handling for injected documents.
 *
 * What the overlay needs from a page's policy. Each point was read in CSP
 * Level 3 and MDN (2026-11) and is exercised in Chromium by
 * `test/proxy-browser.test.ts`:
 *
 *   - Script elements. The injected `<script src>` tags are same-origin. A
 *     policy lets them run when its script directive (`script-src-elem`, else
 *     `script-src`, else `default-src`) lists `'self'` or the proxy origin,
 *     or when the tag carries a nonce the directive lists. With
 *     `'strict-dynamic'` host sources and `'self'` are ignored and only the
 *     nonce counts. Scripts the hook adds later must copy the nonce from
 *     `document.currentScript.nonce`, or rely on `'strict-dynamic'`.
 *   - The overlay WebSocket. CSP 3 says `'self'` covers `ws:` on the page's
 *     host and port, and Chromium does that, but MDN notes that not every
 *     browser does. An explicit `ws://host:port` source is therefore added
 *     whenever a policy restricts connections and does not already name it.
 *   - Styles. `style-src` blocks inline `<style>` elements and `style`
 *     attributes (including `setAttribute('style', ...)`), and governs
 *     stylesheet loads. It does not apply to CSSOM calls: constructable
 *     stylesheets (`new CSSStyleSheet()`, `replaceSync`, `insertRule`,
 *     `adoptedStyleSheets`) and `element.style.setProperty` work even under
 *     `style-src 'none'`. The spec reserves `'unsafe-eval'` for gating them
 *     and MDN records that no browser enforces it. Nothing is added for
 *     styles: the overlay must style through constructable stylesheets only.
 *     (`style.cssText` is listed as blocked by MDN but is not blocked by
 *     Chromium; do not depend on it either way.)
 *
 * Modes:
 *
 *   - `nonce`: read the page's own nonce from the header and put it on the
 *     injected tags, leaving the script directive alone. When that cannot
 *     satisfy every policy, fall back to the additions of `rewrite` and
 *     report a warning.
 *   - `rewrite`: do not rely on the page's nonce; add `'self'` to script
 *     directives that would block the proxy origin, or a proxy-generated
 *     nonce where `'strict-dynamic'` makes `'self'` useless. `'self'` is
 *     preferred because adding a nonce would switch off a page's
 *     `'unsafe-inline'`.
 *   - `strip`: remove the CSP headers from injected documents.
 *
 * A `<meta http-equiv="Content-Security-Policy">` cannot be edited without
 * buffering the page. The scripts are injected ahead of it, so they run, and
 * so does whatever they start synchronously (a socket, a further script
 * element): the policy takes effect only when the parser reaches the meta.
 * Anything the overlay starts after that point is bound by it.
 */

export type CspMode = 'nonce' | 'rewrite' | 'strip'

export interface CspContext {
  /** `host:port` of the proxy as the browser addressed it. */
  publicHost: string
  /** Supplies a nonce when one must be generated. Defaults to 128 random bits. */
  makeNonce?: () => string
}

export interface CspPlan {
  /** Header values to send, in the order given; `undefined` removes that header. */
  values: (string | undefined)[]
  /** Nonce for the injected script tags, when one is needed or available. */
  nonce: string | undefined
  /** A script directive had to be changed in `nonce` mode. */
  warning: string | undefined
}

interface Directive {
  name: string
  values: string[]
}

interface Policy {
  source: string
  directives: Directive[]
  changed: boolean
}

function parsePolicy(source: string): Policy {
  const directives: Directive[] = []
  const seen = new Set<string>()
  for (const part of source.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    const name = tokens.shift()?.toLowerCase()
    // The first occurrence of a directive wins; later ones are ignored by browsers.
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    directives.push({ name, values: tokens })
  }
  return { source, directives, changed: false }
}

function serialize(policy: Policy): string {
  if (!policy.changed) return policy.source.trim()
  return policy.directives.map((directive) => [directive.name, ...directive.values].join(' ')).join('; ')
}

function find(policy: Policy, ...names: string[]): Directive | undefined {
  for (const name of names) {
    const directive = policy.directives.find((candidate) => candidate.name === name)
    if (directive) return directive
  }
  return undefined
}

function has(directive: Directive, keyword: string): boolean {
  return directive.values.some((value) => value.toLowerCase() === keyword)
}

function nonces(directive: Directive): string[] {
  const found: string[] = []
  for (const value of directive.values) {
    const match = /^'nonce-(.+)'$/i.exec(value)
    if (match?.[1] !== undefined) found.push(match[1])
  }
  return found
}

/** Whether a scheme or host source expression covers `scheme://publicHost`. */
function sourceCovers(expression: string, scheme: string, publicHost: string): boolean {
  const value = expression.toLowerCase()
  if (value === `${scheme}:`) return true
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]+)(?:\/.*)?$/.exec(value)
  if (!match || match[2] === undefined) return false
  if (match[1] !== undefined && match[1] !== scheme) return false
  // A host source without a scheme takes the page's scheme, which is http.
  if (match[1] === undefined && scheme !== 'http') return false
  const authority = match[2]
  const colon = authority.lastIndexOf(':')
  const closingBracket = authority.lastIndexOf(']')
  const hasPort = colon > closingBracket
  const host = hasPort ? authority.slice(0, colon) : authority
  const port = hasPort ? authority.slice(colon + 1) : '80'
  const target = publicHost.toLowerCase()
  const targetColon = target.lastIndexOf(':')
  const targetHasPort = targetColon > target.lastIndexOf(']')
  const targetHost = targetHasPort ? target.slice(0, targetColon) : target
  const targetPort = targetHasPort ? target.slice(targetColon + 1) : '80'
  return host === targetHost && (port === '*' || port === targetPort)
}

/** Whether a same-origin script without a nonce passes this script directive. */
function allowsSameOriginScript(directive: Directive, publicHost: string): boolean {
  if (has(directive, "'strict-dynamic'")) return false
  return directive.values.some(
    (value) => value === '*' || value.toLowerCase() === "'self'" || sourceCovers(value, 'http', publicHost),
  )
}

function add(policy: Policy, directive: Directive, value: string): void {
  directive.values = directive.values.filter((existing) => existing.toLowerCase() !== "'none'")
  directive.values.push(value)
  policy.changed = true
}

/**
 * The directive to change. When the policy only has `default-src`, a specific
 * directive is created from a copy of it so nothing else is loosened.
 */
function ownDirective(policy: Policy, effective: Directive, name: string): Directive {
  if (effective.name !== 'default-src') return effective
  const created: Directive = { name, values: [...effective.values] }
  policy.directives.push(created)
  policy.changed = true
  return created
}

function scriptDirective(policy: Policy): Directive | undefined {
  return find(policy, 'script-src-elem', 'script-src', 'default-src')
}

function allowConnect(policy: Policy, publicHost: string): void {
  const effective = find(policy, 'connect-src', 'default-src')
  if (effective === undefined) return
  if (effective.values.some((value) => sourceCovers(value, 'ws', publicHost))) return
  add(policy, ownDirective(policy, effective, 'connect-src'), `ws://${publicHost}`)
}

export function generateNonce(): string {
  return randomBytes(16).toString('base64')
}

/**
 * Decides what to do with the CSP headers of one document response.
 *
 * `headers` holds the values of every `Content-Security-Policy` and
 * `Content-Security-Policy-Report-Only` header, in order. Report-only
 * policies are treated like enforced ones so the overlay does not fill the
 * app's violation reports.
 */
export function planCsp(mode: CspMode, headers: readonly string[], context: CspContext): CspPlan {
  if (mode === 'strip') return { values: headers.map(() => undefined), nonce: undefined, warning: undefined }

  // One header can carry several comma-separated policies; all must pass.
  const parsed = headers.map((value) => value.split(',').map(parsePolicy))
  const policies = parsed.flat()
  const restricting = policies.flatMap((policy) => {
    const directive = scriptDirective(policy)
    return directive === undefined ? [] : [{ policy, directive }]
  })

  const passes = (nonce: string | undefined): boolean =>
    restricting.every(
      ({ directive }) =>
        (nonce !== undefined && nonces(directive).includes(nonce)) ||
        allowsSameOriginScript(directive, context.publicHost),
    )

  let nonce: string | undefined
  let warning: string | undefined
  let satisfied = false
  if (mode === 'nonce') {
    const candidates: (string | undefined)[] = [...new Set(restricting.flatMap(({ directive }) => nonces(directive)))]
    candidates.push(undefined)
    for (const candidate of candidates) {
      if (!passes(candidate)) continue
      nonce = candidate
      satisfied = true
      break
    }
  }

  if (!satisfied) {
    const strict = restricting.filter(({ directive }) => has(directive, "'strict-dynamic'"))
    if (strict.length > 0) {
      // Under 'strict-dynamic' only a nonce works. Keep the page's own when
      // every such policy shares one; otherwise bring one.
      const shared = nonces(strict[0]?.directive ?? { name: '', values: [] }).find((candidate) =>
        strict.every(({ directive }) => nonces(directive).includes(candidate)),
      )
      nonce = mode === 'nonce' && shared !== undefined ? shared : (context.makeNonce ?? generateNonce)()
    }
    const changed: string[] = []
    for (const { policy, directive } of restricting) {
      if (has(directive, "'strict-dynamic'")) {
        if (nonce !== undefined && !nonces(directive).includes(nonce)) {
          add(policy, ownDirective(policy, directive, 'script-src'), `'nonce-${nonce}'`)
          changed.push(directive.name)
        }
      } else if (!allowsSameOriginScript(directive, context.publicHost)) {
        add(policy, ownDirective(policy, directive, 'script-src'), "'self'")
        changed.push(directive.name)
      }
    }
    if (mode === 'nonce' && changed.length > 0) {
      warning =
        `the page's Content-Security-Policy has no nonce or 'self' that lets primp's script run; ` +
        `added a source to ${[...new Set(changed)].join(', ')}`
    }
  }

  for (const policy of policies) allowConnect(policy, context.publicHost)

  const values = parsed.map((list, index) =>
    // An untouched header is returned exactly as it was received.
    list.some((policy) => policy.changed) ? list.map(serialize).join(', ') : headers[index],
  )
  return { values, nonce, warning }
}
