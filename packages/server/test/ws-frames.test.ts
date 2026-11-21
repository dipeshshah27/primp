import { describe, expect, it } from 'vitest'
import { createWsTap, WsFrameParser, WsMessageAssembler, WS_OPCODE, type WsFrame, type WsMessage } from '../src/ws-frames.ts'

/** Byte sequences below are written out by hand; the first six are the examples of RFC 6455 section 5.7. */
const bytes = (...values: number[]): Buffer => Buffer.from(values)

function parse(chunks: Buffer[], maxPayload?: number): { frames: WsFrame[]; parser: WsFrameParser } {
  const frames: WsFrame[] = []
  const parser = new WsFrameParser((frame) => frames.push(frame), maxPayload === undefined ? {} : { maxPayload })
  for (const chunk of chunks) parser.push(chunk)
  return { frames, parser }
}

function messagesOf(chunks: Buffer[]): WsMessage[] {
  const messages: WsMessage[] = []
  const tap = createWsTap((message) => messages.push(message))
  for (const chunk of chunks) tap(chunk)
  return messages
}

const UNMASKED_HELLO = bytes(0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f)
const MASKED_HELLO = bytes(0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58)
const FRAGMENT_1 = bytes(0x01, 0x03, 0x48, 0x65, 0x6c)
const FRAGMENT_2 = bytes(0x80, 0x02, 0x6c, 0x6f)
const UNMASKED_PING = bytes(0x89, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f)
const MASKED_PONG = bytes(0x8a, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58)

describe('WsFrameParser', () => {
  it('parses a single unmasked text frame', () => {
    const { frames } = parse([UNMASKED_HELLO])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ fin: true, rsv1: false, opcode: WS_OPCODE.text, masked: false, length: 5 })
    expect(frames[0]?.payload.toString()).toBe('Hello')
  })

  it('unmasks a masked text frame without touching the input bytes', () => {
    const input = Buffer.from(MASKED_HELLO)
    const { frames } = parse([input])
    expect(frames[0]).toMatchObject({ fin: true, opcode: WS_OPCODE.text, masked: true, length: 5 })
    expect(frames[0]?.payload.toString()).toBe('Hello')
    expect(input.equals(MASKED_HELLO)).toBe(true)
  })

  it('parses fragmented frames and keeps their flags', () => {
    const { frames } = parse([FRAGMENT_1, FRAGMENT_2])
    expect(frames.map((frame) => [frame.fin, frame.opcode, frame.payload.toString()])).toEqual([
      [false, WS_OPCODE.text, 'Hel'],
      [true, WS_OPCODE.continuation, 'lo'],
    ])
  })

  it('parses ping, pong and close frames', () => {
    // Close: status 1000 (0x03e8) and the reason "bye".
    const close = bytes(0x88, 0x05, 0x03, 0xe8, 0x62, 0x79, 0x65)
    const { frames } = parse([UNMASKED_PING, MASKED_PONG, close])
    expect(frames.map((frame) => frame.opcode)).toEqual([WS_OPCODE.ping, WS_OPCODE.pong, WS_OPCODE.close])
    expect(frames[0]?.payload.toString()).toBe('Hello')
    expect(frames[1]?.payload.toString()).toBe('Hello')
    expect(frames[2]?.payload.readUInt16BE(0)).toBe(1000)
    expect(frames[2]?.payload.subarray(2).toString()).toBe('bye')
  })

  it('reads a 16-bit length (256 bytes, binary)', () => {
    const payload = Buffer.alloc(256, 0xab)
    const { frames } = parse([Buffer.concat([bytes(0x82, 0x7e, 0x01, 0x00), payload])])
    expect(frames[0]).toMatchObject({ opcode: WS_OPCODE.binary, length: 256, masked: false })
    expect(frames[0]?.payload.equals(payload)).toBe(true)
  })

  it('reads a 64-bit length (65536 bytes, binary)', () => {
    const payload = Buffer.alloc(65536)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const header = bytes(0x82, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00)
    const { frames } = parse([Buffer.concat([header, payload])])
    expect(frames[0]).toMatchObject({ opcode: WS_OPCODE.binary, length: 65536 })
    expect(frames[0]?.payload.equals(payload)).toBe(true)
  })

  it('reads a masked frame with a 16-bit length', () => {
    const mask = [0x11, 0x22, 0x33, 0x44]
    const plain = Buffer.from('x'.repeat(126) + 'tail')
    const masked = Buffer.from(plain.map((byte, index) => byte ^ (mask[index % 4] ?? 0)))
    const { frames } = parse([Buffer.concat([bytes(0x81, 0xfe, 0x00, 0x82, ...mask), masked])])
    expect(frames[0]).toMatchObject({ masked: true, length: 130 })
    expect(frames[0]?.payload.equals(plain)).toBe(true)
  })

  it('handles an empty payload', () => {
    const { frames } = parse([bytes(0x81, 0x00), bytes(0x81, 0x80, 0x01, 0x02, 0x03, 0x04)])
    expect(frames.map((frame) => [frame.length, frame.masked, frame.payload.length])).toEqual([
      [0, false, 0],
      [0, true, 0],
    ])
  })

  it('handles several frames in one chunk', () => {
    const { frames } = parse([Buffer.concat([UNMASKED_HELLO, MASKED_HELLO, UNMASKED_PING, FRAGMENT_1, FRAGMENT_2])])
    expect(frames.map((frame) => frame.opcode)).toEqual([
      WS_OPCODE.text,
      WS_OPCODE.text,
      WS_OPCODE.ping,
      WS_OPCODE.text,
      WS_OPCODE.continuation,
    ])
    expect(frames.map((frame) => frame.payload.toString())).toEqual(['Hello', 'Hello', 'Hello', 'Hel', 'lo'])
  })

  it('gives the same frames whatever the TCP chunking', () => {
    const big = Buffer.concat([bytes(0x82, 0x7e, 0x01, 0x2c), Buffer.alloc(300, 0x5a)])
    const wide = Buffer.concat([bytes(0x82, 0x7f, 0, 0, 0, 0, 0, 0, 0x00, 0x7f), Buffer.alloc(127, 0x33)])
    const stream = Buffer.concat([MASKED_HELLO, big, FRAGMENT_1, UNMASKED_PING, FRAGMENT_2, wide, MASKED_PONG])
    const summary = (frames: WsFrame[]): string[] =>
      frames.map((frame) => `${frame.opcode}:${frame.fin}:${frame.masked}:${frame.payload.toString('hex')}`)
    const whole = summary(parse([stream]).frames)
    expect(whole).toHaveLength(7)

    // Byte by byte: every header and payload boundary is split.
    const single = Array.from(stream, (byte) => bytes(byte))
    expect(summary(parse(single).frames)).toEqual(whole)

    // And every possible two-way split.
    for (let cut = 1; cut < stream.length; cut++) {
      const frames = parse([stream.subarray(0, cut), stream.subarray(cut)]).frames
      expect(summary(frames), `split at ${cut}`).toEqual(whole)
    }
  })

  it('reports RSV1 so compressed payloads are not mistaken for text', () => {
    const { frames } = parse([bytes(0xc1, 0x02, 0xaa, 0xbb)])
    expect(frames[0]).toMatchObject({ rsv1: true, opcode: WS_OPCODE.text })
  })

  it('skips payloads above the limit and stays in sync', () => {
    const big = Buffer.concat([bytes(0x82, 0x7e, 0x01, 0x00), Buffer.alloc(256, 1)])
    const { frames } = parse([big, UNMASKED_HELLO], 100)
    expect(frames[0]).toMatchObject({ truncated: true, length: 256 })
    expect(frames[0]?.payload.length).toBe(0)
    expect(frames[1]?.payload.toString()).toBe('Hello')
  })

  it('stops on a reserved opcode instead of inventing frames', () => {
    const { frames, parser } = parse([UNMASKED_HELLO, bytes(0x83, 0x01, 0x00), UNMASKED_HELLO])
    expect(frames).toHaveLength(1)
    expect(parser.failure).toMatch(/reserved opcode/)
  })

  it('stops on a fragmented or oversized control frame', () => {
    expect(parse([bytes(0x09, 0x00)]).parser.failure).toMatch(/control frame/)
    expect(parse([bytes(0x89, 0x7e, 0x00, 0x7e)]).parser.failure).toMatch(/control frame/)
  })

  it('stops on a length that does not fit a safe integer', () => {
    const { parser } = parse([bytes(0x82, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)])
    expect(parser.failure).toMatch(/length/)
  })
})

describe('WsMessageAssembler', () => {
  it('joins fragments into one text message', () => {
    const messages = messagesOf([FRAGMENT_1, FRAGMENT_2])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ opcode: WS_OPCODE.text, text: 'Hello' })
  })

  it('passes a control frame that arrives between fragments at once', () => {
    const messages = messagesOf([FRAGMENT_1, UNMASKED_PING, FRAGMENT_2])
    expect(messages.map((message) => [message.opcode, message.data.toString()])).toEqual([
      [WS_OPCODE.ping, 'Hello'],
      [WS_OPCODE.text, 'Hello'],
    ])
  })

  it('joins a masked message fragmented in three, split mid-character', () => {
    // "héllo" in UTF-8 is 68 c3 a9 6c 6c 6f; the fragments cut the two-byte character in half.
    const mask = [0xa1, 0xb2, 0xc3, 0xd4]
    const masked = (first: number, payload: number[]): Buffer =>
      bytes(first, 0x80 | payload.length, ...mask, ...payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)))
    const messages = messagesOf([masked(0x01, [0x68, 0xc3]), masked(0x00, [0xa9, 0x6c]), masked(0x80, [0x6c, 0x6f])])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('héllo')
  })

  it('gives binary messages no text', () => {
    const messages = messagesOf([bytes(0x82, 0x03, 0x00, 0xff, 0x7f)])
    expect(messages[0]?.opcode).toBe(WS_OPCODE.binary)
    expect(messages[0]?.text).toBeUndefined()
    expect([...(messages[0]?.data ?? [])]).toEqual([0x00, 0xff, 0x7f])
  })

  it('gives compressed text messages no text', () => {
    const messages = messagesOf([bytes(0xc1, 0x02, 0xaa, 0xbb)])
    expect(messages[0]?.text).toBeUndefined()
  })

  it('drops a message with a truncated fragment and recovers on the next', () => {
    const messages: WsMessage[] = []
    const assembler = new WsMessageAssembler((message) => messages.push(message))
    const parser = new WsFrameParser((frame) => assembler.push(frame), { maxPayload: 4 })
    parser.push(bytes(0x01, 0x03, 0x48, 0x65, 0x6c)) // "Hel", not final
    parser.push(bytes(0x80, 0x05, 0x6c, 0x6f, 0x6c, 0x6f, 0x6c)) // 5 bytes: over the limit
    parser.push(bytes(0x81, 0x02, 0x6f, 0x6b)) // "ok"
    expect(messages.map((message) => message.text)).toEqual(['ok'])
  })

  it('ignores a continuation with nothing to continue', () => {
    expect(messagesOf([FRAGMENT_2, UNMASKED_HELLO]).map((message) => message.text)).toEqual(['Hello'])
  })
})
