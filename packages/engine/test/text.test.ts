import { describe, expect, it } from 'vitest'
import { code, num, oneLine, plural, quoted, signedPx, truncate } from '../src/text.ts'

describe('text helpers', () => {
  it('oneLine: line breaks, tabs, control characters and Unicode separators become single spaces', () => {
    expect(oneLine('  a\n\nb\tc\r\nd  ')).toBe('a b c d')
    expect(oneLine('a\u0000b\u001fc\u007fd')).toBe('a b c d')
    const separators = [0x2028, 0x2029, 0x85].map((point) => String.fromCharCode(point))
    expect(oneLine(`a${separators[0]}b${separators[1]}c${separators[2]}d`)).toBe('a b c d')
    expect(oneLine('')).toBe('')
  })

  it('truncate: at most max characters, ending in an ellipsis when cut', () => {
    expect(truncate('abcdef', 6)).toBe('abcdef')
    expect(truncate('abcdefg', 6)).toBe('abc...')
    expect(truncate('ab cdefg', 6)).toBe('ab...')
    expect(truncate('x'.repeat(500), 120)).toHaveLength(120)
  })

  it('code: one line, no backticks inside, never empty, bounded', () => {
    expect(code('button.btn "Sign in"')).toBe('`button.btn "Sign in"`')
    expect(code('a`b``c')).toBe("`a'b''c`")
    expect(code('```\n# Heading\n- item')).toBe("`''' # Heading - item`")
    expect(code('')).toBe('`(empty)`')
    expect(code(' \n ')).toBe('`(empty)`')
    expect(code('x'.repeat(500), 20)).toBe(`\`${'x'.repeat(17)}...\``)
    for (const hostile of ['`', '``', 'a`', '`a', '\n`\n', '\\`']) {
      const span = code(hostile)
      expect(span.startsWith('`') && span.endsWith('`')).toBe(true)
      expect(span.slice(1, -1)).not.toContain('`')
      expect(span).not.toContain('\n')
    }
  })

  it('quoted: one line in double quotes', () => {
    expect(quoted('make it blue\n\n# not a heading `x`')).toBe('"make it blue # not a heading \'x\'"')
    expect(quoted('y'.repeat(700))).toHaveLength(602)
  })

  it('num, signedPx, plural', () => {
    expect(num(266.66)).toBe('266.66')
    expect(num(0.1 + 0.2)).toBe('0.3')
    expect(num(-0.0001)).toBe('0')
    expect(num(12)).toBe('12')
    expect(signedPx(-3)).toBe('-3px')
    expect(signedPx(1.5)).toBe('+1.5px')
    expect(signedPx(0)).toBe('0px')
    expect(plural(1, 'change')).toBe('1 change')
    expect(plural(3, 'change')).toBe('3 changes')
    expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })
})
