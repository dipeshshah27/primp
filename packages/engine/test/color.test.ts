import { describe, expect, it } from 'vitest'
import { colorDistance, deltaE2000, parseColor, rgbaToLab, toHex } from '../src/color.ts'
import type { RGBA } from '../src/color.ts'

const must = (text: string): RGBA => {
  const color = parseColor(text)
  if (color === null) throw new Error(`not a colour: ${text}`)
  return color
}

const close = (a: RGBA, b: RGBA, channel = 0.6): void => {
  expect(Math.abs(a.r - b.r)).toBeLessThan(channel)
  expect(Math.abs(a.g - b.g)).toBeLessThan(channel)
  expect(Math.abs(a.b - b.b)).toBeLessThan(channel)
  expect(Math.abs(a.a - b.a)).toBeLessThan(0.005)
}

describe('parseColor', () => {
  it.each<[string, RGBA]>([
    ['rgb(59, 130, 246)', { r: 59, g: 130, b: 246, a: 1 }],
    ['rgba(59, 130, 246, 0.5)', { r: 59, g: 130, b: 246, a: 0.5 }],
    ['rgb(59 130 246)', { r: 59, g: 130, b: 246, a: 1 }],
    ['rgb(59 130 246 / 0.5)', { r: 59, g: 130, b: 246, a: 0.5 }],
    ['rgb(59 130 246 / 50%)', { r: 59, g: 130, b: 246, a: 0.5 }],
    ['rgb(100%, 0%, 50%)', { r: 255, g: 0, b: 127.5, a: 1 }],
    ['RGBA(0, 0, 0, 0)', { r: 0, g: 0, b: 0, a: 0 }],
    ['#3b82f6', { r: 59, g: 130, b: 246, a: 1 }],
    ['#3B82F6', { r: 59, g: 130, b: 246, a: 1 }],
    ['#fff', { r: 255, g: 255, b: 255, a: 1 }],
    ['#0008', { r: 0, g: 0, b: 0, a: 136 / 255 }],
    ['#3b82f680', { r: 59, g: 130, b: 246, a: 128 / 255 }],
    ['transparent', { r: 0, g: 0, b: 0, a: 0 }],
    ['color(srgb 1 0.5 0)', { r: 255, g: 127.5, b: 0, a: 1 }],
    ['color(srgb 1 0.5 0 / 0.25)', { r: 255, g: 127.5, b: 0, a: 0.25 }],
    ['color(srgb 100% 50% 0%)', { r: 255, g: 127.5, b: 0, a: 1 }],
    ['white', { r: 255, g: 255, b: 255, a: 1 }],
  ])('%s', (text, expected) => {
    close(must(text), expected, 0.001)
  })

  it('hsl, comma and space syntax', () => {
    close(must('hsl(217, 91%, 60%)'), { r: 60, g: 131, b: 246, a: 1 }, 1)
    close(must('hsl(217deg 91% 60% / 0.5)'), { r: 60, g: 131, b: 246, a: 0.5 }, 1)
    close(must('hsl(0 100% 50%)'), { r: 255, g: 0, b: 0, a: 1 }, 0.001)
  })

  it('oklch and oklab: the sRGB primaries and white', () => {
    close(must('oklch(0.627955 0.257683 29.2339)'), { r: 255, g: 0, b: 0, a: 1 })
    close(must('oklch(0.86644 0.294827 142.4953)'), { r: 0, g: 255, b: 0, a: 1 })
    close(must('oklch(0.452014 0.313214 264.052)'), { r: 0, g: 0, b: 255, a: 1 })
    close(must('oklch(1 0 0)'), { r: 255, g: 255, b: 255, a: 1 })
    close(must('oklab(0.627955 0.224863 0.125846)'), { r: 255, g: 0, b: 0, a: 1 })
    close(must('oklch(62.7955% 0.257683 29.2339 / 0.4)'), { r: 255, g: 0, b: 0, a: 0.4 })
  })

  it('lab and lch (D50): red and mid grey', () => {
    close(must('lab(54.29 80.8 69.89)'), { r: 255, g: 0, b: 0, a: 1 }, 1)
    close(must('lch(54.29 106.84 40.86)'), { r: 255, g: 0, b: 0, a: 1 }, 1)
    close(must('lab(53.585 0 0)'), { r: 128, g: 128, b: 128, a: 1 }, 1)
  })

  it('color(srgb-linear) and color(display-p3)', () => {
    close(must('color(srgb-linear 1 0.214041 0)'), { r: 255, g: 127.5, b: 0, a: 1 }, 0.1)
    close(must('color(display-p3 1 1 1)'), { r: 255, g: 255, b: 255, a: 1 })
    // P3 red is outside sRGB: more red than 255 and a negative green.
    const p3red = must('color(display-p3 1 0 0)')
    expect(p3red.r).toBeGreaterThan(255)
    expect(p3red.g).toBeLessThan(0)
  })

  it.each(['', 'currentcolor', 'none', '12px', 'rgb(1, 2)', 'rgb(a, b, c)', '#12', '#ggg', 'color(rec2020 1 0 0)', 'color-mix(in srgb, red, blue)', 'var(--x)', 'solid'])(
    'not a colour: %j',
    (text) => {
      expect(parseColor(text)).toBeNull()
    },
  )

  it('toHex', () => {
    expect(toHex(must('rgb(59, 130, 246)'))).toBe('#3b82f6')
    expect(toHex(must('rgba(0, 0, 0, 0.5)'))).toBe('#00000080')
    expect(toHex(must('oklch(0.627955 0.257683 29.2339)'))).toBe('#ff0000')
  })
})

describe('deltaE2000', () => {
  // Pairs from the test data published with Sharma, Wu and Dalal (2005).
  it.each<[[number, number, number], [number, number, number], number]>([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ])('%j vs %j = %d', (one, two, expected) => {
    const a = { l: one[0], a: one[1], b: one[2] }
    const b = { l: two[0], a: two[1], b: two[2] }
    expect(deltaE2000(a, b)).toBeCloseTo(expected, 4)
    expect(deltaE2000(b, a)).toBeCloseTo(expected, 4)
  })
})

describe('colorDistance', () => {
  it('Lab of the sRGB corners', () => {
    const white = rgbaToLab(must('#ffffff'))
    expect(white.l).toBeCloseTo(100, 1)
    expect(Math.abs(white.a)).toBeLessThan(0.01)
    expect(Math.abs(white.b)).toBeLessThan(0.01)
    const red = rgbaToLab(must('#ff0000'))
    expect(red.l).toBeCloseTo(53.24, 1)
    expect(red.a).toBeCloseTo(80.09, 1)
    expect(red.b).toBeCloseTo(67.2, 1)
  })

  it('0 for the same colour in different notations', () => {
    expect(colorDistance(must('#3b82f6'), must('rgb(59, 130, 246)'))).toBe(0)
    expect(colorDistance(must('color(srgb 0.231373 0.509804 0.964706)'), must('rgb(59, 130, 246)'))).toBeLessThan(0.01)
    expect(colorDistance(must('oklch(0.627955 0.257683 29.2339)'), must('#ff0000'))).toBeLessThan(0.1)
  })

  it('a one-step channel change is below 1; black to white is 100', () => {
    expect(colorDistance(must('rgb(59, 130, 246)'), must('rgb(60, 130, 246)'))).toBeLessThan(1)
    expect(colorDistance(must('#000'), must('#fff'))).toBeCloseTo(100, 0)
  })

  it('neighbouring palette steps are several units apart, half a step is within 6', () => {
    const blue500 = must('#3b82f6')
    const blue600 = must('#2563eb')
    const step = colorDistance(blue500, blue600)
    expect(step).toBeGreaterThan(6)
    expect(step).toBeLessThan(15)
    const between = must('#3073f1')
    expect(colorDistance(between, blue500)).toBeLessThan(6)
    expect(colorDistance(between, blue600)).toBeLessThan(6)
  })

  it('alpha counts: one percentage point per unit', () => {
    expect(colorDistance(must('rgba(0, 0, 0, 0.5)'), must('rgba(0, 0, 0, 0.6)'))).toBeCloseTo(10, 5)
    expect(colorDistance(must('rgba(0, 0, 0, 0.5)'), must('rgba(0, 0, 0, 0.505)'))).toBeLessThan(1)
    expect(colorDistance(must('rgba(255, 0, 0, 0)'), must('transparent'))).toBe(0)
    expect(colorDistance(must('#000'), must('transparent'))).toBe(100)
  })

  it('is symmetric', () => {
    const a = must('#e2e8f0')
    const b = must('#cbd5e1')
    expect(colorDistance(a, b)).toBeCloseTo(colorDistance(b, a), 10)
  })
})
