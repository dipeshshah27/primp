import { describe, expect, it } from 'vitest'
import {
  compareComputed,
  computedEqual,
  flattenValue,
  normalizeValue,
  parseFontFamily,
  parseLength,
  parseMatrix,
  parseNumber,
  parsePercent,
  splitTopLevel,
} from '../src/units.ts'

describe('scalar parsers', () => {
  it('parseLength: px only, and a bare zero', () => {
    expect(parseLength('12px')).toBe(12)
    expect(parseLength(' 15.9844px ')).toBe(15.9844)
    expect(parseLength('-4px')).toBe(-4)
    expect(parseLength('.5px')).toBe(0.5)
    expect(parseLength('1e2px')).toBe(100)
    expect(parseLength('0')).toBe(0)
    expect(parseLength('12PX')).toBe(12)
    expect(parseLength('12')).toBeNull()
    expect(parseLength('1rem')).toBeNull()
    expect(parseLength('50%')).toBeNull()
    expect(parseLength('auto')).toBeNull()
    expect(parseLength('normal')).toBeNull()
    expect(parseLength('4px 8px')).toBeNull()
  })

  it('parseNumber and parsePercent', () => {
    expect(parseNumber('1.5')).toBe(1.5)
    expect(parseNumber('400')).toBe(400)
    expect(parseNumber('-0.25')).toBe(-0.25)
    expect(parseNumber('1.5px')).toBeNull()
    expect(parseNumber('normal')).toBeNull()
    expect(parsePercent('50%')).toBe(50)
    expect(parsePercent('33.3333%')).toBe(33.3333)
    expect(parsePercent('50')).toBeNull()
    expect(parsePercent('50px')).toBeNull()
  })

  it('normalizeValue', () => {
    expect(normalizeValue('  4px \n  8px ')).toBe('4px 8px')
  })
})

describe('splitTopLevel', () => {
  it('commas outside parentheses and quotes', () => {
    expect(splitTopLevel('rgba(0, 0, 0, 0.1) 0px 1px 2px, rgb(1, 2, 3) 0px 0px 0px 1px inset', ',')).toEqual([
      'rgba(0, 0, 0, 0.1) 0px 1px 2px',
      'rgb(1, 2, 3) 0px 0px 0px 1px inset',
    ])
    expect(splitTopLevel('"Helvetica, Neue", Arial', ',')).toEqual(['"Helvetica, Neue"', 'Arial'])
  })

  it('whitespace outside parentheses and quotes', () => {
    expect(splitTopLevel('1px  solid rgb(0, 0, 0)', ' ')).toEqual(['1px', 'solid', 'rgb(0, 0, 0)'])
    expect(splitTopLevel('"a b" c', ' ')).toEqual(['"a b"', 'c'])
    expect(splitTopLevel('', ' ')).toEqual([])
  })
})

describe('parseFontFamily', () => {
  it('drops quotes and case', () => {
    expect(parseFontFamily('"Inter Variable", Inter, system-ui, sans-serif')).toEqual(['inter variable', 'inter', 'system-ui', 'sans-serif'])
    expect(parseFontFamily("'Press Start 2P',  MONOSPACE")).toEqual(['press start 2p', 'monospace'])
  })
})

describe('parseMatrix', () => {
  it('none, matrix and matrix3d as 4x4', () => {
    expect(parseMatrix('none')).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    expect(parseMatrix('matrix(1, 0, 0, 1, 10, 20)')).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1])
    expect(parseMatrix('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1)')).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1])
    expect(parseMatrix('translateX(10px)')).toBeNull()
    expect(parseMatrix('matrix(1, 0, 0, 1, 10)')).toBeNull()
  })
})

describe('flattenValue', () => {
  it('kinds', () => {
    expect(flattenValue('4px 8px').map((leaf) => leaf.kind)).toEqual(['length', 'length'])
    expect(flattenValue('1.5').map((leaf) => leaf.kind)).toEqual(['number'])
    expect(flattenValue('50%').map((leaf) => leaf.kind)).toEqual(['percent'])
    expect(flattenValue('normal').map((leaf) => leaf.kind)).toEqual(['keyword'])
    expect(flattenValue('rgb(0, 0, 0)').map((leaf) => leaf.kind)).toEqual(['color'])
    expect(flattenValue('0.3s').map((leaf) => [leaf.kind, leaf.num, leaf.unit])).toEqual([['dimension', 0.3, 's']])
    expect(flattenValue('300ms').map((leaf) => [leaf.kind, leaf.num, leaf.unit])).toEqual([['dimension', 0.3, 's']])
  })

  it('a shadow list keeps its structure as keyword leaves', () => {
    expect(flattenValue('rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px').map((leaf) => leaf.text)).toEqual([
      'rgba(0, 0, 0, 0.1)',
      '0px',
      '4px',
      '6px',
      '-1px',
      ',',
      'rgba(0, 0, 0, 0.1)',
      '0px',
      '2px',
      '4px',
      '-2px',
    ])
  })

  it('functions are opened, urls and strings are kept whole', () => {
    expect(flattenValue('cubic-bezier(0.4, 0, 0.2, 1)').map((leaf) => leaf.text)).toEqual(['cubic-bezier(', '0.4', ',', '0', ',', '0.2', ',', '1', ')'])
    expect(flattenValue('url("a b.png") no-repeat').map((leaf) => leaf.kind)).toEqual(['string', 'keyword'])
    expect(flattenValue('"Hello, World"').map((leaf) => [leaf.kind, leaf.text])).toEqual([['string', 'Hello, World']])
    expect(flattenValue('16px / 24px').map((leaf) => leaf.text)).toEqual(['16px', '/', '24px'])
    expect(flattenValue('16px/24px').map((leaf) => leaf.text)).toEqual(['16px', '/', '24px'])
  })

  it('font-family is one leaf', () => {
    expect(flattenValue('"Inter", sans-serif', 'font-family')).toEqual([{ kind: 'font-family', text: '"Inter", sans-serif', families: ['inter', 'sans-serif'] }])
  })
})

describe('compareComputed', () => {
  it.each<[string, string, boolean]>([
    // lengths: 0.5px
    ['16px', '16px', true],
    ['16px', '16.4px', true],
    ['16px', '15.5px', true],
    ['16px', '16.6px', false],
    ['15.9844px', '16px', true],
    ['0px', '0', true],
    ['0', '0px', true],
    ['4px 8px', '4px 8px', true],
    ['4px 8px', '4px  8.3px', true],
    ['4px 8px', '4px 9px', false],
    ['4px 8px', '4px', false],
    // numbers: 0.01
    ['1.5', '1.5', true],
    ['1.5', '1.505', true],
    ['1.5', '1.52', false],
    ['400', '400', true],
    ['400', '500', false],
    ['0.5', '.5', true],
    // percentages
    ['50%', '50%', true],
    ['33.3333%', '33.33%', true],
    ['50%', '51%', false],
    ['50%', '50px', false],
    // keywords are exact, case does not matter
    ['normal', 'normal', true],
    ['auto', 'AUTO', true],
    ['normal', '24px', false],
    ['auto', 'none', false],
    ['flex', 'inline-flex', false],
    ['24px', 'normal', false],
    // colours: distance below 1
    ['rgb(59, 130, 246)', 'rgb(59, 130, 246)', true],
    ['rgb(59, 130, 246)', 'rgb(60, 130, 246)', true],
    ['rgb(59, 130, 246)', 'rgba(59, 130, 246, 1)', true],
    ['rgb(59, 130, 246)', 'color(srgb 0.231373 0.509804 0.964706)', true],
    ['rgb(255, 0, 0)', 'oklch(0.627955 0.257683 29.2339)', true],
    ['rgb(59, 130, 246)', 'rgb(37, 99, 235)', false],
    ['rgba(0, 0, 0, 0)', 'transparent', true],
    ['rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.6)', false],
    // mixed lists
    ['1px solid rgb(0, 0, 0)', '1px solid rgb(0, 0, 0)', true],
    ['1px solid rgb(0, 0, 0)', '1px dashed rgb(0, 0, 0)', false],
    ['1px solid rgb(0, 0, 0)', '2px solid rgb(0, 0, 0)', false],
    ['rgba(0, 0, 0, 0.1) 0px 4px 6px -1px', 'rgba(0, 0, 0, 0.1) 0px 4px 6px -1px', true],
    ['rgba(0, 0, 0, 0.1) 0px 4px 6px -1px', 'rgba(0, 0, 0, 0.1) 0px 4.2px 6px -1px', true],
    ['rgba(0, 0, 0, 0.1) 0px 4px 6px -1px', 'rgba(0, 0, 0, 0.1) 0px 8px 6px -1px', false],
    ['rgba(0, 0, 0, 0.1) 0px 4px 6px -1px', 'rgba(0, 0, 0, 0.1) 0px 4px 6px -1px inset', false],
    ['rgba(0, 0, 0, 0.1) 0px 4px 6px -1px', 'none', false],
    // time and functions
    ['0.3s', '300ms', true],
    ['0.3s', '0.2s', false],
    ['opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1)', 'opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1)', true],
    ['opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1)', 'opacity 0.15s cubic-bezier(0.4, 0, 1, 1)', false],
    ['blur(4px)', 'blur(4px)', true],
    ['blur(4px)', 'brightness(4px)', false],
    ['repeat(2, 100px)', 'repeat(3, 100px)', false],
    ['url("a.png")', 'url("b.png")', false],
    ['"A"', '"a"', false],
  ])('%j vs %j: equal %j', (expected, actual, equal) => {
    expect(computedEqual(expected, actual)).toBe(equal)
    expect(computedEqual(actual, expected)).toBe(equal)
  })

  it('font-family: case and quotes do not matter, order and members do', () => {
    expect(computedEqual('"Inter", system-ui, sans-serif', "inter, 'System-UI', Sans-Serif", 'font-family')).toBe(true)
    expect(computedEqual('Inter, sans-serif', 'Inter, serif', 'font-family')).toBe(false)
    expect(computedEqual('Inter, sans-serif', 'sans-serif, Inter', 'font-family')).toBe(false)
    expect(computedEqual('Inter, sans-serif', 'Inter', 'font-family')).toBe(false)
  })

  it('transform matrices are compared numerically', () => {
    expect(computedEqual('matrix(1, 0, 0, 1, 10, 20)', 'matrix(1, 0, 0, 1, 10.3, 20)')).toBe(true)
    expect(computedEqual('matrix(1, 0, 0, 1, 10, 20)', 'matrix(1, 0, 0, 1, 12, 20)')).toBe(false)
    expect(computedEqual('matrix(1.05, 0, 0, 1.05, 0, 0)', 'matrix(1.055, 0, 0, 1.05, 0, 0)')).toBe(true)
    expect(computedEqual('matrix(1.05, 0, 0, 1.05, 0, 0)', 'matrix(1.1, 0, 0, 1.1, 0, 0)')).toBe(false)
    expect(computedEqual('none', 'matrix(1, 0, 0, 1, 0, 0)')).toBe(true)
    expect(computedEqual('matrix(1, 0, 0, 1, 0, 0)', 'none')).toBe(true)
    expect(computedEqual('none', 'matrix(1, 0, 0, 1, 0, 8)')).toBe(false)
    expect(computedEqual('matrix(1, 0, 0, 1, 10, 20)', 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)')).toBe(true)
    expect(computedEqual('none', 'none')).toBe(true)
  })

  it('reports leaves with deltas, or a shape mismatch', () => {
    const one = compareComputed('16px', '13px')
    expect(one.sameShape).toBe(true)
    expect(one.leaves).toHaveLength(1)
    expect(one.leaves[0]?.delta).toBe(-3)
    expect(one.leaves[0]?.kind).toBe('length')

    const colour = compareComputed('rgb(59, 130, 246)', 'rgb(37, 99, 235)')
    expect(colour.leaves[0]?.kind).toBe('color')
    expect(colour.leaves[0]?.delta).toBeGreaterThan(6)

    const translate = compareComputed('matrix(1, 0, 0, 1, 10, 20)', 'matrix(1, 0, 0, 1, 12, 20)')
    expect(translate.leaves.filter((leaf) => !leaf.equal).map((leaf) => [leaf.kind, leaf.delta])).toEqual([['length', 2]])

    expect(compareComputed('4px 8px', '4px')).toEqual({ equal: false, sameShape: false, leaves: [] })
    expect(compareComputed('normal', '24px')).toEqual({ equal: false, sameShape: false, leaves: [] })
  })
})
