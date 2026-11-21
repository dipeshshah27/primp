/**
 * Colours as the browser serialises them in computed styles, and how far apart two of them look.
 *
 * Pure: no DOM, no Node.
 *
 * Parsed forms: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()` (comma or space
 * separated, numbers or percentages, optional alpha), `hsl()` / `hsla()`, `color(srgb ...)`,
 * `color(srgb-linear ...)`, `color(display-p3 ...)`, `oklab()`, `oklch()`, `lab()`, `lch()`
 * (Chromium keeps these last four as authored in computed values, and Tailwind v4's palette is
 * written in oklch), `transparent` and the 17 basic colour names. Anything else (`currentcolor`,
 * `color-mix()`, system colours, other predefined spaces) gives `null` and is compared as text.
 *
 * Distance is CIEDE2000 between the two colours converted to CIE Lab (D65), plus the alpha
 * difference in percentage points (so 1% of alpha counts like one unit of colour difference).
 * Two fully transparent colours are at distance 0 whatever their channels say.
 */

/** `r`, `g`, `b` in 0-255 (fractional, and outside that range for colours outside sRGB); `a` in 0-1. */
export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export interface Lab {
  l: number
  a: number
  b: number
}

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  orange: [255, 165, 0],
}

const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'color', 'oklab', 'oklch', 'lab', 'lch'])

/** Whether `name` (lower case) is a colour function this module can parse. */
export function isColorFunction(name: string): boolean {
  return COLOR_FUNCTIONS.has(name)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/

/** A channel written as a number or a percentage; `none` counts as 0. Null when it is neither. */
function channel(token: string, percentOf: number): number | null {
  if (token === 'none') return 0
  if (token.endsWith('%')) {
    const n = token.slice(0, -1)
    return NUMBER.test(n) ? (Number(n) / 100) * percentOf : null
  }
  return NUMBER.test(token) ? Number(token) : null
}

function hue(token: string): number | null {
  if (token === 'none') return 0
  const match = /^(.*?)(deg|rad|grad|turn)?$/.exec(token)
  if (match === null || !NUMBER.test(match[1] ?? '')) return null
  const n = Number(match[1])
  switch (match[2]) {
    case 'rad':
      return (n * 180) / Math.PI
    case 'grad':
      return n * 0.9
    case 'turn':
      return n * 360
    default:
      return n
  }
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

function srgbToLinear(v: number): number {
  const s = Math.abs(v)
  const out = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  return v < 0 ? -out : out
}

function linearToSrgb(v: number): number {
  const s = Math.abs(v)
  const out = s <= 0.0031308 ? s * 12.92 : 1.055 * s ** (1 / 2.4) - 0.055
  return v < 0 ? -out : out
}

type Triple = [number, number, number]

const fromLinear = (rgb: Triple, a: number): RGBA => ({
  r: linearToSrgb(rgb[0]) * 255,
  g: linearToSrgb(rgb[1]) * 255,
  b: linearToSrgb(rgb[2]) * 255,
  a,
})

function xyzD65ToLinear([x, y, z]: Triple): Triple {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ]
}

function linearToXyzD65([r, g, b]: Triple): Triple {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ]
}

function oklabToLinear(l: number, a: number, b: number): Triple {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const EPSILON = 216 / 24389
const KAPPA = 24389 / 27

/** CIE Lab with a D50 white (as CSS `lab()` defines it) to linear sRGB. */
function cssLabToLinear(l: number, a: number, b: number): Triple {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const x = fx ** 3 > EPSILON ? fx ** 3 : (116 * fx - 16) / KAPPA
  const y = l > KAPPA * EPSILON ? fy ** 3 : l / KAPPA
  const z = fz ** 3 > EPSILON ? fz ** 3 : (116 * fz - 16) / KAPPA
  const [xd, yd, zd] = [x * 0.96422, y, z * 0.82521]
  // Bradford adaptation, D50 to D65.
  return xyzD65ToLinear([
    0.9555766 * xd - 0.0230393 * yd + 0.0631636 * zd,
    -0.0282895 * xd + 1.0099416 * yd + 0.0210077 * zd,
    0.0122982 * xd - 0.020483 * yd + 1.3299098 * zd,
  ])
}

function hslToRgb(h: number, s: number, l: number): Triple {
  const hh = (((h % 360) + 360) % 360) / 30
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => {
    const k = (n + hh) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

function parseHex(hex: string): RGBA | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null
  const expand = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex
  if (expand.length !== 6 && expand.length !== 8) return null
  const byte = (i: number): number => Number.parseInt(expand.slice(i, i + 2), 16)
  return { r: byte(0), g: byte(2), b: byte(4), a: expand.length === 8 ? byte(6) / 255 : 1 }
}

/** Parses one colour. Returns null for anything that is not a colour this module understands. */
export function parseColor(input: string): RGBA | null {
  const text = input.trim().toLowerCase()
  if (text === '') return null
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (text.startsWith('#')) return parseHex(text.slice(1))
  const named = NAMED[text]
  if (named !== undefined) return { r: named[0], g: named[1], b: named[2], a: 1 }

  const open = text.indexOf('(')
  if (open <= 0 || !text.endsWith(')')) return null
  const name = text.slice(0, open)
  if (!COLOR_FUNCTIONS.has(name)) return null
  const body = text.slice(open + 1, -1).trim()
  if (body.includes('(')) return null

  // Alpha comes after a slash, or as the fourth value of the comma syntax.
  let alphaToken: string | undefined
  let main = body
  const slash = body.indexOf('/')
  if (slash >= 0) {
    alphaToken = body.slice(slash + 1).trim()
    main = body.slice(0, slash)
  }
  const parts = main.split(/[\s,]+/).filter((part) => part !== '')
  let space: string | undefined
  if (name === 'color') space = parts.shift()
  if (parts.length === 4 && alphaToken === undefined) alphaToken = parts.pop()
  if (parts.length !== 3) return null
  const [p0, p1, p2] = parts as [string, string, string]

  let a = 1
  if (alphaToken !== undefined) {
    const parsed = channel(alphaToken, 1)
    if (parsed === null) return null
    a = clamp01(parsed)
  }

  switch (name) {
    case 'rgb':
    case 'rgba': {
      const r = channel(p0, 255)
      const g = channel(p1, 255)
      const b = channel(p2, 255)
      if (r === null || g === null || b === null) return null
      return { r, g, b, a }
    }
    case 'hsl':
    case 'hsla': {
      const h = hue(p0)
      const s = channel(p1, 1)
      const l = channel(p2, 1)
      if (h === null || s === null || l === null) return null
      // Without a percent sign the modern syntax still means percent.
      const sat = p1.endsWith('%') ? s : s / 100
      const light = p2.endsWith('%') ? l : l / 100
      const [r, g, b] = hslToRgb(h, clamp01(sat), clamp01(light))
      return { r: r * 255, g: g * 255, b: b * 255, a }
    }
    case 'color': {
      const r = channel(p0, 1)
      const g = channel(p1, 1)
      const b = channel(p2, 1)
      if (r === null || g === null || b === null) return null
      if (space === 'srgb') return { r: r * 255, g: g * 255, b: b * 255, a }
      if (space === 'srgb-linear') return fromLinear([r, g, b], a)
      if (space === 'display-p3') {
        const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
        return fromLinear(
          xyzD65ToLinear([
            0.4865709 * lr + 0.2656677 * lg + 0.1982173 * lb,
            0.2289746 * lr + 0.6917385 * lg + 0.0792869 * lb,
            0.0451134 * lg + 1.0439444 * lb,
          ]),
          a,
        )
      }
      return null
    }
    case 'oklab':
    case 'oklch': {
      const l = channel(p0, 1)
      if (l === null) return null
      if (name === 'oklab') {
        const la = channel(p1, 0.4)
        const lb = channel(p2, 0.4)
        if (la === null || lb === null) return null
        return fromLinear(oklabToLinear(l, la, lb), a)
      }
      const c = channel(p1, 0.4)
      const h = hue(p2)
      if (c === null || h === null) return null
      const rad = (h * Math.PI) / 180
      return fromLinear(oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad)), a)
    }
    case 'lab':
    case 'lch': {
      const l = channel(p0, 100)
      if (l === null) return null
      if (name === 'lab') {
        const la = channel(p1, 125)
        const lb = channel(p2, 125)
        if (la === null || lb === null) return null
        return fromLinear(cssLabToLinear(l, la, lb), a)
      }
      const c = channel(p1, 150)
      const h = hue(p2)
      if (c === null || h === null) return null
      const rad = (h * Math.PI) / 180
      return fromLinear(cssLabToLinear(l, c * Math.cos(rad), c * Math.sin(rad)), a)
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** sRGB to CIE Lab with a D65 white. */
export function rgbaToLab(color: RGBA): Lab {
  const [x, y, z] = linearToXyzD65([srgbToLinear(color.r / 255), srgbToLinear(color.g / 255), srgbToLinear(color.b / 255)])
  const f = (t: number): number => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116)
  const fx = f(x / 0.95047)
  const fy = f(y)
  const fz = f(z / 1.08883)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

const RAD = Math.PI / 180

/** CIEDE2000 colour difference (Sharma, Wu, Dalal 2005), with all weighting factors at 1. */
export function deltaE2000(one: Lab, two: Lab): number {
  const c1 = Math.hypot(one.a, one.b)
  const c2 = Math.hypot(two.a, two.b)
  const cBar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1 = (1 + g) * one.a
  const a2 = (1 + g) * two.a
  const cp1 = Math.hypot(a1, one.b)
  const cp2 = Math.hypot(a2, two.b)
  const angle = (b: number, a: number): number => {
    if (b === 0 && a === 0) return 0
    const h = Math.atan2(b, a) / RAD
    return h < 0 ? h + 360 : h
  }
  const hp1 = angle(one.b, a1)
  const hp2 = angle(two.b, a2)

  const dL = two.l - one.l
  const dC = cp2 - cp1
  let dh = 0
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * RAD)

  const lBar = (one.l + two.l) / 2
  const cpBar = (cp1 + cp2) / 2
  let hBar = hp1 + hp2
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar = (hp1 + hp2) / 2
    else if (hp1 + hp2 < 360) hBar = (hp1 + hp2 + 360) / 2
    else hBar = (hp1 + hp2 - 360) / 2
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * RAD) +
    0.24 * Math.cos(2 * hBar * RAD) +
    0.32 * Math.cos((3 * hBar + 6) * RAD) -
    0.2 * Math.cos((4 * hBar - 63) * RAD)
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7))
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2)
  const sc = 1 + 0.045 * cpBar
  const sh = 1 + 0.015 * cpBar * t
  const rt = -Math.sin(2 * dTheta * RAD) * rc
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh))
}

/**
 * How different two colours look: 0 is identical, about 1 is the smallest difference a person
 * can see side by side, neighbouring steps of a design palette are typically 4 to 12 apart.
 */
export function colorDistance(one: RGBA, two: RGBA): number {
  if (one.a === 0 && two.a === 0) return 0
  return deltaE2000(rgbaToLab(one), rgbaToLab(two)) + Math.abs(one.a - two.a) * 100
}

/** `#rrggbb`, or `#rrggbbaa` when not opaque; channels clamped to sRGB. */
export function toHex(color: RGBA): string {
  const byte = (n: number): string =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  const alpha = color.a >= 1 ? '' : byte(color.a * 255)
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${alpha}`
}
