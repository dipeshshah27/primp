import { Transform, type TransformCallback } from 'node:stream'

/**
 * Streaming `<head>` injection.
 *
 * The injector reads the start of an HTML document token by token and places
 * a snippet as the first thing inside `<head>`. It works on bytes, so any
 * ASCII-compatible encoding passes through intact, and it never holds back
 * more than the one token it is still reading:
 *
 *   - whitespace, comments, the doctype and the `<html ...>` tag are forwarded
 *     as soon as they are complete;
 *   - `<head ...>` is forwarded followed by the snippet;
 *   - anything else (a `<body>`, a `<script>`, a `<meta>`, text) means the
 *     document has no explicit head, because the HTML parser would open one
 *     implicitly right there. The snippet goes immediately before it, which is
 *     after `<html ...>` and the doctype when they exist. It is never put in
 *     front of the doctype: that would switch the page to quirks mode.
 *
 * After the snippet is placed every later chunk is forwarded untouched. If a
 * single token (an unterminated comment or tag) grows past `limit` bytes the
 * snippet is placed in front of it and the injector gives up scanning.
 *
 * Because the snippet always precedes the head's own content, it also
 * precedes any `<meta http-equiv="Content-Security-Policy">` in the page.
 */

export const HEAD_SCAN_LIMIT = 64 * 1024

export type InjectionPlacement = 'head' | 'html' | 'start' | 'none'

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** Index of the `>` that closes the tag opened before `from`, ignoring `>` inside quoted values. */
function findTagEnd(text: string, from: number): number {
  let quote = ''
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return i
    }
  }
  return -1
}

type Scan =
  /** Everything before `flush` is settled; the rest is an incomplete token. */
  | { kind: 'more'; flush: number }
  | { kind: 'inject'; at: number }

export class HeadInjector {
  /** Where the snippet went; undefined until that is decided. */
  placement: InjectionPlacement | undefined

  private held: Buffer = Buffer.alloc(0)
  private sawHtml = false
  private sawBytes = false

  constructor(
    private readonly snippet: Buffer,
    private readonly limit: number = HEAD_SCAN_LIMIT,
  ) {}

  /** Returns the buffers to forward for this chunk, in order. */
  push(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) return []
    if (this.placement !== undefined) return [chunk]

    let data = this.held.length === 0 ? chunk : Buffer.concat([this.held, chunk])
    const out: Buffer[] = []
    if (!this.sawBytes) {
      // A byte-order mark has to stay the first thing in the document.
      if (data.length < UTF8_BOM.length && UTF8_BOM.subarray(0, data.length).equals(data)) {
        this.held = data
        return out
      }
      this.sawBytes = true
      if (data.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
        out.push(data.subarray(0, UTF8_BOM.length))
        data = data.subarray(UTF8_BOM.length)
      }
    }

    const scan = this.scan(data.toString('latin1'))
    if (scan.kind === 'inject') {
      this.place(out, data, scan.at)
    } else if (data.length - scan.flush > this.limit) {
      this.place(out, data, scan.flush)
    } else {
      if (scan.flush > 0) out.push(data.subarray(0, scan.flush))
      this.held = data.subarray(scan.flush)
    }
    return out
  }

  /** Returns what is left to forward once the document has ended. */
  end(): Buffer[] {
    if (this.placement !== undefined) return []
    if (!this.sawBytes && this.held.length === 0) {
      this.placement = 'none'
      return []
    }
    const out: Buffer[] = []
    this.place(out, this.held, 0)
    return out
  }

  private place(out: Buffer[], data: Buffer, at: number): void {
    // One buffer, so the tags travel in the same write as the bytes around them.
    out.push(Buffer.concat([data.subarray(0, at), this.snippet, data.subarray(at)]))
    this.held = Buffer.alloc(0)
    this.placement ??= this.sawHtml ? 'html' : 'start'
  }

  private scan(text: string): Scan {
    let position = 0
    for (;;) {
      while (position < text.length && WHITESPACE.has(text[position] ?? '')) position++
      if (position >= text.length) return { kind: 'more', flush: position }
      if (text[position] !== '<') return { kind: 'inject', at: position }

      const next = text[position + 1]
      if (next === undefined) return { kind: 'more', flush: position }

      if (next === '!' || next === '?') {
        const marker = text.slice(position, position + 4)
        if (marker.length < 4 && '<!--'.startsWith(marker)) return { kind: 'more', flush: position }
        // A comment ends at `-->` (`<!-->` is an empty one); a doctype or a
        // processing instruction ends at the first `>`.
        const close = marker === '<!--' ? text.indexOf('-->', position + 2) : text.indexOf('>', position + 2)
        if (close === -1) return { kind: 'more', flush: position }
        position = close + (marker === '<!--' ? 3 : 1)
        continue
      }

      if (!/[a-z]/i.test(next)) return { kind: 'inject', at: position }

      let nameEnd = position + 1
      while (nameEnd < text.length && !WHITESPACE.has(text[nameEnd] ?? '') && text[nameEnd] !== '>' && text[nameEnd] !== '/') {
        nameEnd++
      }
      const name = text.slice(position + 1, nameEnd).toLowerCase()
      if (nameEnd >= text.length) {
        // The name may still grow; wait only while it could become one we handle.
        if ('html'.startsWith(name) || 'head'.startsWith(name)) return { kind: 'more', flush: position }
        return { kind: 'inject', at: position }
      }
      if (name !== 'html' && name !== 'head') return { kind: 'inject', at: position }

      const tagStart = position
      const close = findTagEnd(text, nameEnd)
      if (close === -1) return { kind: 'more', flush: tagStart }
      position = close + 1
      if (name === 'head') {
        this.placement = 'head'
        return { kind: 'inject', at: position }
      }
      // A second `<html>` is not a document start; treat it as content.
      if (this.sawHtml) return { kind: 'inject', at: tagStart }
      this.sawHtml = true
    }
  }
}

/** A Transform that applies `HeadInjector` to a byte stream. */
export function createHeadInjectStream(
  snippet: string | Buffer,
  onPlaced?: (placement: InjectionPlacement) => void,
): Transform {
  const injector = new HeadInjector(typeof snippet === 'string' ? Buffer.from(snippet, 'utf8') : snippet)
  let reported = false
  const report = (): void => {
    if (reported || injector.placement === undefined) return
    reported = true
    onPlaced?.(injector.placement)
  }
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      for (const buffer of injector.push(chunk)) this.push(buffer)
      report()
      callback()
    },
    flush(callback: TransformCallback): void {
      for (const buffer of injector.end()) this.push(buffer)
      report()
      callback()
    },
  })
}
