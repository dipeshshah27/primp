/**
 * The colour input of the browser picks opaque colours only (`#rrggbb`). A colour that had
 * transparency keeps it when a new colour is picked: the picked colour with the old alpha.
 */

/** The alpha of a colour as authored or computed (`rgba(…, 0.5)`, `rgb(… / 50%)`, `#rrggbbaa`); 1 when it has none or it cannot be read. */
export function alphaOf(color: string): number {
  const value = color.trim().toLowerCase()
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(value)
  if (hex !== null) {
    const digits = hex[1]!
    const a = digits.length === 4 ? digits[3]! + digits[3]! : digits.slice(6, 8)
    return Number.parseInt(a, 16) / 255
  }
  const fn = /^(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\((.*)\)$/.exec(value)
  if (fn === null) return 1
  const inside = fn[1]!
  const slash = /\/\s*([\d.]+)(%?)\s*$/.exec(inside)
  if (slash !== null) return clamp(slash[2] === '%' ? Number(slash[1]) / 100 : Number(slash[1]))
  const parts = inside.split(',').map((part) => part.trim())
  if (parts.length === 4) return clamp(parts[3]!.endsWith('%') ? Number.parseFloat(parts[3]!) / 100 : Number(parts[3]))
  return 1
}

const clamp = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1)

/** `picked` (`#rrggbb`) with the alpha of `current`: `#rrggbbaa` when that is below 1, else `picked` as it is. */
export function keepAlpha(picked: string, current: string): string {
  const alpha = alphaOf(current)
  // Fully transparent (no background at all): a picked colour is meant to be seen.
  if (alpha >= 1 || alpha <= 0 || !/^#[0-9a-f]{6}$/i.test(picked)) return picked
  return `${picked}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
}
