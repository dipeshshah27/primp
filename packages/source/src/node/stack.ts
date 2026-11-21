/**
 * Stack-trace parsing. Pure: no I/O.
 *
 * The input is `Error.prototype.stack` as the browser formatted it. V8 writes
 * `    at fn (url:line:col)` or `    at url:line:col`; Firefox and Safari write
 * `fn@url:line:col`. Columns are 1-based in all three.
 */

export interface StackFrame {
  /** Function name as printed, without `async ` / `new `. */
  fn?: string
  /** Script URL as printed. Empty for native and anonymous frames. */
  url: string
  /** 1-based; 0 when the frame has no position. */
  line: number
  /** 1-based; 0 when the frame has no position. */
  col: number
  /** The untouched line, for messages. */
  raw: string
}

function parseLocation(text: string): { url: string; line: number; col: number } | undefined {
  // Greedy on purpose: URLs contain colons (ports, about://React/Server/file:///...).
  const match = /^(.*):(\d+):(\d+)$/.exec(text)
  if (!match) return undefined
  return { url: match[1] ?? '', line: Number(match[2]), col: Number(match[3]) }
}

const isAnonymous = (url: string): boolean => url === '' || url === '<anonymous>' || url === 'native' || url.startsWith('eval at ')

function frameFrom(fn: string | undefined, where: string, raw: string): StackFrame {
  const location = parseLocation(where)
  const frame: StackFrame =
    location && !isAnonymous(location.url)
      ? { url: location.url, line: location.line, col: location.col, raw }
      : { url: '', line: 0, col: 0, raw }
  const name = fn?.replace(/^(?:async |new )+/, '').trim()
  if (name) frame.fn = name
  return frame
}

/** Parses every frame line; the `Error: message` line and anything unrecognised are dropped. */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('at ')) {
      const body = line.slice(3)
      // `fn (where)`: the location is the last parenthesised group, and may itself contain parentheses.
      const open = body.endsWith(')') ? body.indexOf(' (') : -1
      if (open !== -1) frames.push(frameFrom(body.slice(0, open), body.slice(open + 2, -1), raw))
      else frames.push(frameFrom(undefined, body, raw))
      continue
    }
    const at = line.lastIndexOf('@')
    if (at !== -1 && parseLocation(line.slice(at + 1))) {
      frames.push(frameFrom(line.slice(0, at), line.slice(at + 1), raw))
    } else if (/^[a-z][\w+.-]*:\/\//i.test(line) && parseLocation(line)) {
      frames.push(frameFrom(undefined, line, raw))
    }
  }
  return frames
}

export interface ScriptRef {
  /** The real script URL: `http://...`, `file:///...`, or whatever the bundler printed. */
  url: string
  /** RSC environment (`Server`, `Prerender`, ...) when the frame was replayed from a Server Component. */
  serverEnv?: string
}

/**
 * React replays Server Component frames on the client under a virtual URL:
 * `about://React/<Env>/<real url>?<counter>` (React 19.1+; `rsc://React/...` before that).
 * The real URL is percent-encoded once more by the browser.
 */
export function scriptRefOf(url: string): ScriptRef {
  const match = /^(?:about|rsc):\/\/React\/([^/]+)\/(.*)$/.exec(url)
  if (!match) return { url }
  const inner = (match[2] ?? '').replace(/\?\d+$/, '')
  let decoded = inner
  try {
    decoded = decodeURI(inner)
  } catch {
    // Keep the encoded form.
  }
  return { url: decoded, serverEnv: decodeURIComponent(match[1] ?? '') }
}
