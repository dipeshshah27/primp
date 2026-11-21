import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createHeadInjectStream, HeadInjector, HEAD_SCAN_LIMIT, type InjectionPlacement } from '../src/html-inject.ts'

const TAG = '<script src="/__primp/hook.js"></script>'

function run(chunks: (string | Buffer)[], limit?: number): { html: string; placement: InjectionPlacement | undefined; perChunk: string[] } {
  const injector = new HeadInjector(Buffer.from(TAG), limit)
  const perChunk: string[] = []
  for (const chunk of chunks) {
    perChunk.push(Buffer.concat(injector.push(Buffer.from(chunk))).toString('latin1'))
  }
  const tail = Buffer.concat(injector.end()).toString('latin1')
  return { html: perChunk.join('') + tail, placement: injector.placement, perChunk }
}

describe('HeadInjector', () => {
  it('injects right after <head>', () => {
    const { html, placement } = run(['<!doctype html><html><head><title>t</title></head><body>x</body></html>'])
    expect(html).toBe(`<!doctype html><html><head>${TAG}<title>t</title></head><body>x</body></html>`)
    expect(placement).toBe('head')
  })

  it('handles attributes, upper case and a ">" inside a quoted attribute', () => {
    expect(run(['<HTML LANG="en"><HEAD data-x="a>b" class=\'c>d\'><meta charset="utf-8">']).html).toBe(
      `<HTML LANG="en"><HEAD data-x="a>b" class='c>d'>${TAG}<meta charset="utf-8">`,
    )
  })

  it('finds a <head that is split at every possible offset', () => {
    const page = '<!-- build 1 -->\n<!DOCTYPE html>\n<html lang="en">\n  <head data-a="1">\n<meta charset="utf-8"><title>x</title></head><body><header>h</header></body></html>'
    const expected = page.replace('<head data-a="1">', `<head data-a="1">${TAG}`)
    for (let cut = 1; cut < page.length; cut++) {
      const result = run([page.slice(0, cut), page.slice(cut)])
      expect(result.html, `split at ${cut}`).toBe(expected)
      expect(result.placement).toBe('head')
    }
    expect(run(Array.from(page)).html).toBe(expected)
  })

  it('forwards everything it has settled without waiting for more', () => {
    const { perChunk } = run(['<!doctype html><html lang="en"><he', 'ad><title>t</title>', '</head><body>later</body>'])
    // The doctype and <html> are out before the rest of the tag arrives.
    expect(perChunk[0]).toBe('<!doctype html><html lang="en">')
    expect(perChunk[1]).toBe(`<head>${TAG}<title>t</title>`)
    expect(perChunk[2]).toBe('</head><body>later</body>')
  })

  it('passes later chunks through as the same buffers', () => {
    const injector = new HeadInjector(Buffer.from(TAG))
    injector.push(Buffer.from('<head>'))
    const later = Buffer.from('<p>anything <head> at all</p>')
    const out = injector.push(later)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(later)
  })

  it('does not take <header> for <head>', () => {
    const { html, placement } = run(['<!doctype html><html><header>h</header>'])
    expect(html).toBe(`<!doctype html><html>${TAG}<header>h</header>`)
    expect(placement).toBe('html')
  })

  it('ignores a <head> mentioned in a leading comment', () => {
    expect(run(['<!-- <head> --><html><head><title>t</title>']).html).toBe(`<!-- <head> --><html><head>${TAG}<title>t</title>`)
  })

  it('falls back to after <html> when there is no head', () => {
    const { html, placement } = run(['<!doctype html>\n<html lang="en">\n<body><p>x</p></body></html>'])
    expect(html).toBe(`<!doctype html>\n<html lang="en">\n${TAG}<body><p>x</p></body></html>`)
    expect(placement).toBe('html')
  })

  it('falls back to before <body> when there is no html or head tag', () => {
    const { html, placement } = run(['<!doctype html><body><p>x</p></body>'])
    expect(html).toBe(`<!doctype html>${TAG}<body><p>x</p></body>`)
    expect(placement).toBe('start')
  })

  it('falls back to the start, after the doctype, never before it', () => {
    expect(run(['<!doctype html><title>t</title><p>x</p>']).html).toBe(`<!doctype html>${TAG}<title>t</title><p>x</p>`)
    expect(run(['<p>fragment</p>']).html).toBe(`${TAG}<p>fragment</p>`)
    expect(run(['just text']).html).toBe(`${TAG}just text`)
  })

  it('stays ahead of a meta CSP, with or without a head tag', () => {
    const meta = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">'
    const withHead = run([`<!doctype html><html><head>${meta}<title>t</title></head>`]).html
    expect(withHead.indexOf(TAG)).toBeGreaterThan(-1)
    expect(withHead.indexOf(TAG)).toBeLessThan(withHead.indexOf('<meta'))
    const withoutHead = run([`<!doctype html>${meta}<p>x</p>`]).html
    expect(withoutHead).toBe(`<!doctype html>${TAG}${meta}<p>x</p>`)
  })

  it('keeps a byte-order mark first', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const result = run([bom.subarray(0, 2), Buffer.concat([bom.subarray(2), Buffer.from('<p>x</p>')])])
    expect(Buffer.from(result.html, 'latin1').subarray(0, 3).equals(bom)).toBe(true)
    expect(result.html.slice(3)).toBe(`${TAG}<p>x</p>`)
  })

  it('does not corrupt multi-byte characters split across chunks', () => {
    const page = Buffer.from('<!doctype html><html><head><title>café 日本語</title></head><body>ü</body></html>', 'utf8')
    const expected = page.toString('utf8').replace('<head>', `<head>${TAG}`)
    for (let cut = 1; cut < page.length; cut++) {
      const injector = new HeadInjector(Buffer.from(TAG))
      const out = [...injector.push(page.subarray(0, cut)), ...injector.push(page.subarray(cut)), ...injector.end()]
      expect(Buffer.concat(out).toString('utf8'), `split at ${cut}`).toBe(expected)
    }
  })

  it('gives up on a token longer than the limit and injects in front of it', () => {
    const start = '<!doctype html><html>'
    const comment = `<!--${'x'.repeat(HEAD_SCAN_LIMIT + 10)}`
    const injector = new HeadInjector(Buffer.from(TAG))
    const first = Buffer.concat(injector.push(Buffer.from(start + comment))).toString()
    expect(first).toBe(`${start}${TAG}${comment}`)
    expect(injector.placement).toBe('html')
    // Scanning is over: a head tag later on is left alone.
    expect(Buffer.concat(injector.push(Buffer.from('--><head>'))).toString()).toBe('--><head>')
  })

  it('holds at most the limit while a token is incomplete', () => {
    const injector = new HeadInjector(Buffer.from(TAG), 1024)
    let forwarded = 0
    let fed = 0
    const piece = Buffer.from('y'.repeat(100))
    forwarded += Buffer.concat(injector.push(Buffer.from('<!--'))).length
    fed += 4
    while (injector.placement === undefined) {
      forwarded += Buffer.concat(injector.push(piece)).length
      fed += piece.length
      expect(fed - forwarded).toBeLessThanOrEqual(1024)
    }
    expect(fed).toBeLessThanOrEqual(1024 + 100 + 4)
    expect(forwarded).toBe(fed + TAG.length)
  })

  it('injects at the end of a document that ends inside a token', () => {
    expect(run(['<!doctype html><html><hea']).html).toBe(`<!doctype html><html>${TAG}<hea`)
  })

  it('leaves an empty body empty', () => {
    const result = run([])
    expect(result.html).toBe('')
    expect(result.placement).toBe('none')
  })
})

describe('createHeadInjectStream', () => {
  it('transforms a stream and reports the placement once', async () => {
    const placements: InjectionPlacement[] = []
    const stream = Readable.from([Buffer.from('<html><he'), Buffer.from('ad><title>t</title></head>')]).pipe(
      createHeadInjectStream(TAG, (placement) => placements.push(placement)),
    )
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe(`<html><head>${TAG}<title>t</title></head>`)
    expect(placements).toEqual(['head'])
  })
})
