import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The screenshots in public/shots/ and the facts site/capture.ts recorded with them. Everything
 * here is read at build time; sizes come from the files, so a recapture can change them freely.
 */

const SHOTS = join(process.cwd(), 'public/shots')

export interface Shot {
  src: string
  width: number
  height: number
}

/** Width and height of a baseline or progressive JPEG, from its SOF marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('not a JPEG marker')
    const marker = bytes[offset + 1] as number
    const length = bytes.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  throw new Error('no SOF marker')
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export function shot(name: string): Shot {
  const file = join(SHOTS, name)
  const bytes = readFileSync(file)
  const size = name.endsWith('.png') ? pngSize(bytes) : jpegSize(bytes)
  return { src: `/shots/${name}`, ...size }
}

/** The light and dark captures of one screen. */
export function shotPair(name: string): { light: Shot; dark: Shot } {
  return { light: shot(`${name}-light.jpg`), dark: shot(`${name}-dark.jpg`) }
}

export interface Facts {
  capturedAt: string
  shift: { cause: string; value: number; culprit: string; confidence: number; evidence: string[]; source: string | null; level: string | null }
  edit: { id?: string; label: string; summary: string; source: string; bystanders: string[]; change?: { property: string; before: string; after: string } }
  verify: { summary: string; results: { id: string; status: string; hint: string }[] }
}

export function facts(): Facts {
  const read = JSON.parse(readFileSync(join(SHOTS, 'facts.json'), 'utf8')) as Facts
  if (read.shift?.source == null || read.edit?.summary === undefined || read.verify?.results === undefined) {
    throw new Error('public/shots/facts.json is incomplete: run `pnpm site:capture` at the repository root')
  }
  return read
}

/** The prompt Send produced in the capture, as the agent received it. */
export function capturedPrompt(): string {
  return readFileSync(join(SHOTS, 'prompt.txt'), 'utf8').trim()
}

export interface RecordedChange {
  property: string
  before: string
  after: string
}

/** The property change of item `id`, as the captured prompt states it: `### \`id\` \`padding\`: \`10px 18px\` -> \`14px 26px\``. */
export function capturedChange(id: string): RecordedChange | undefined {
  const line = capturedPrompt()
    .split('\n')
    .find((text) => text.startsWith(`### \`${id}\``))
  const match = line === undefined ? null : /`([^`]+)`: `([^`]+)`(?: \(computed `[^`]+`\))? -> `([^`]+)`/.exec(line)
  if (match === null) return undefined
  return { property: match[1] as string, before: match[2] as string, after: match[3] as string }
}
