/**
 * Read-only WebSocket frame parser (RFC 6455, section 5.2).
 *
 * The upgrade tunnel copies bytes between the browser and the dev server and
 * shows the same bytes to this parser. The parser never produces bytes for the
 * wire; payloads it hands out are unmasked copies. When the byte stream stops
 * making sense it stops parsing and stays stopped, because a desynchronised
 * parser would only invent frames.
 */

export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

export interface WsFrame {
  fin: boolean
  /** Set when an extension (permessage-deflate) transformed the payload. */
  rsv1: boolean
  opcode: number
  masked: boolean
  /** Payload length declared in the frame header. */
  length: number
  /** Unmasked payload; empty when `truncated`. */
  payload: Buffer
  /** The payload was longer than `maxPayload` and was skipped, not kept. */
  truncated: boolean
}

export interface WsFrameParserOptions {
  /** Payloads above this many bytes are skipped and reported as truncated. Default 16 MiB. */
  maxPayload?: number
}

const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024
/** 2 bytes, up to 8 of extended length, 4 of masking key. */
const MAX_HEADER = 14
const NO_BYTES = Buffer.alloc(0)

export class WsFrameParser {
  /** Why parsing stopped, if it did. */
  failure: string | undefined

  private readonly maxPayload: number
  private readonly header = Buffer.alloc(MAX_HEADER)
  private headerFill = 0
  /** Frame whose payload is being read; undefined while reading a header. */
  private frame: WsFrame | undefined
  private mask: Buffer | undefined
  private remaining = 0
  private offset = 0

  constructor(
    private readonly onFrame: (frame: WsFrame) => void,
    options: WsFrameParserOptions = {},
  ) {
    this.maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD
  }

  /** Feeds the next bytes of the stream. The chunk is never modified. */
  push(chunk: Uint8Array): void {
    let position = 0
    while (position < chunk.length && this.failure === undefined) {
      position = this.frame === undefined ? this.readHeader(chunk, position) : this.readPayload(chunk, position)
    }
  }

  private readHeader(chunk: Uint8Array, start: number): number {
    let position = start
    for (;;) {
      const needed = this.headerNeeded()
      if (this.headerFill >= needed) break
      if (position >= chunk.length) return position
      const take = Math.min(needed - this.headerFill, chunk.length - position)
      this.header.set(chunk.subarray(position, position + take), this.headerFill)
      this.headerFill += take
      position += take
    }
    this.beginFrame()
    return position
  }

  /** Header bytes required, as far as the bytes read so far can tell. */
  private headerNeeded(): number {
    if (this.headerFill < 2) return 2
    const second = this.header[1] ?? 0
    const short = second & 0x7f
    const extended = short === 126 ? 2 : short === 127 ? 8 : 0
    return 2 + extended + ((second & 0x80) !== 0 ? 4 : 0)
  }

  private beginFrame(): void {
    const first = this.header[0] ?? 0
    const second = this.header[1] ?? 0
    const opcode = first & 0x0f
    const fin = (first & 0x80) !== 0
    const masked = (second & 0x80) !== 0
    const short = second & 0x7f

    let length = short
    let cursor = 2
    if (short === 126) {
      length = this.header.readUInt16BE(2)
      cursor = 4
    } else if (short === 127) {
      const wide = this.header.readBigUInt64BE(2)
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return this.fail('frame length exceeds 2^53')
      length = Number(wide)
      cursor = 10
    }

    const known = opcode <= WS_OPCODE.binary || (opcode >= WS_OPCODE.close && opcode <= WS_OPCODE.pong)
    if (!known) return this.fail(`reserved opcode 0x${opcode.toString(16)}`)
    if (opcode >= WS_OPCODE.close && (!fin || length > 125)) return this.fail('malformed control frame')

    this.mask = masked ? Buffer.from(this.header.subarray(cursor, cursor + 4)) : undefined
    const truncated = length > this.maxPayload
    this.frame = {
      fin,
      rsv1: (first & 0x40) !== 0,
      opcode,
      masked,
      length,
      payload: truncated || length === 0 ? NO_BYTES : Buffer.allocUnsafe(length),
      truncated,
    }
    this.remaining = length
    this.offset = 0
    this.headerFill = 0
    if (length === 0) this.finishFrame()
  }

  private readPayload(chunk: Uint8Array, start: number): number {
    const frame = this.frame
    if (frame === undefined) return start
    const take = Math.min(this.remaining, chunk.length - start)
    if (!frame.truncated) {
      const target = frame.payload
      const mask = this.mask
      if (mask === undefined) {
        target.set(chunk.subarray(start, start + take), this.offset)
      } else {
        for (let i = 0; i < take; i++) {
          target[this.offset + i] = (chunk[start + i] ?? 0) ^ (mask[(this.offset + i) & 3] ?? 0)
        }
      }
    }
    this.offset += take
    this.remaining -= take
    if (this.remaining === 0) this.finishFrame()
    return start + take
  }

  private finishFrame(): void {
    const frame = this.frame
    this.frame = undefined
    this.mask = undefined
    if (frame !== undefined) this.onFrame(frame)
  }

  private fail(reason: string): void {
    this.failure = reason
    this.frame = undefined
  }
}

export interface WsMessage {
  /** Opcode of the message: text or binary for data, close/ping/pong for control frames. */
  opcode: number
  /** Whole payload, fragments joined. For a close frame: status code and reason. */
  data: Buffer
  /** Present for text messages that were not transformed by an extension. */
  text?: string
}

export interface WsMessageAssemblerOptions {
  /** Messages above this many bytes are dropped. Default 32 MiB. */
  maxMessage?: number
}

const DEFAULT_MAX_MESSAGE = 32 * 1024 * 1024

/**
 * Joins fragmented data frames into messages. Control frames may arrive
 * between the fragments of a message and are passed on at once.
 */
export class WsMessageAssembler {
  private readonly maxMessage: number
  private parts: Buffer[] | undefined
  private opcode = 0
  private size = 0
  private compressed = false
  private dropped = false

  constructor(
    private readonly onMessage: (message: WsMessage) => void,
    options: WsMessageAssemblerOptions = {},
  ) {
    this.maxMessage = options.maxMessage ?? DEFAULT_MAX_MESSAGE
  }

  push(frame: WsFrame): void {
    if (frame.opcode >= WS_OPCODE.close) {
      if (!frame.truncated) this.onMessage({ opcode: frame.opcode, data: frame.payload })
      return
    }
    if (frame.opcode === WS_OPCODE.continuation) {
      // A continuation with nothing to continue: the tap joined mid-message.
      if (this.parts === undefined) return
    } else {
      this.parts = []
      this.opcode = frame.opcode
      this.size = 0
      this.compressed = frame.rsv1
      this.dropped = false
    }
    this.size += frame.length
    if (frame.truncated || this.size > this.maxMessage) this.dropped = true
    if (this.dropped) this.parts = []
    else this.parts.push(frame.payload)
    if (!frame.fin) return

    const parts = this.parts
    this.parts = undefined
    if (this.dropped) return
    const data = parts.length === 1 && parts[0] !== undefined ? parts[0] : Buffer.concat(parts)
    const message: WsMessage = { opcode: this.opcode, data }
    if (this.opcode === WS_OPCODE.text && !this.compressed) message.text = data.toString('utf8')
    this.onMessage(message)
  }
}

/** A function to feed stream bytes to; it calls `onMessage` for every whole message. */
export interface WsTap {
  (chunk: Uint8Array): void
  /** Why the tap stopped reporting, if it did. */
  readonly failure: string | undefined
}

export function createWsTap(
  onMessage: (message: WsMessage) => void,
  options: WsFrameParserOptions & WsMessageAssemblerOptions = {},
): WsTap {
  const assembler = new WsMessageAssembler(onMessage, options)
  const parser = new WsFrameParser((frame) => assembler.push(frame), options)
  const tap = (chunk: Uint8Array): void => parser.push(chunk)
  Object.defineProperty(tap, 'failure', { get: () => parser.failure })
  return tap as WsTap
}
