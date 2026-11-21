import { randomBytes } from 'node:crypto'
import type http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { getFreePort, WS_OPCODE, type FrameDirection, type TunnelInfo, type WsMessage } from '../src/index.ts'
import { onCleanup, runCleanups, sleep, startProxy, startUpstream, type TestUpstream } from './helpers.ts'

afterEach(runCleanups)

interface Tapped {
  direction: FrameDirection
  info: TunnelInfo
  message: WsMessage
}

function recorder(): { tapped: Tapped[]; onUpgradeFrame: (direction: FrameDirection, info: TunnelInfo, message: WsMessage) => void } {
  const tapped: Tapped[] = []
  return { tapped, onUpgradeFrame: (direction, info, message) => tapped.push({ direction, info, message }) }
}

/** An echo server with compression enabled, as a dev server would have it. */
async function startEcho(): Promise<TestUpstream & { upgrades: http.IncomingMessage[]; sockets: WebSocketServer }> {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('upgrade required')
  })
  const upgrades: http.IncomingMessage[] = []
  const sockets = new WebSocketServer({
    server: upstream.server,
    perMessageDeflate: true,
    handleProtocols: (protocols) => (protocols.has('vite-hmr') ? 'vite-hmr' : false),
  })
  sockets.on('connection', (socket, request) => {
    upgrades.push(request)
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) socket.send(data, { binary: true })
      else socket.send(`echo:${data.toString()}`)
    })
  })
  onCleanup(() => {
    for (const client of sockets.clients) client.terminate()
    sockets.close()
  })
  return Object.assign(upstream, { upgrades, sockets })
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)))
  })
}

function nextMessage(socket: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data: RawData, isBinary: boolean) => resolve({ data: Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]), isBinary }))
    socket.once('error', reject)
  })
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)))
}

function connect(url: string, options: ConstructorParameters<typeof WebSocket>[2] = {}, protocols: string[] = []): WebSocket {
  const socket = new WebSocket(url, protocols, options)
  socket.on('error', () => {})
  onCleanup(() => socket.terminate())
  return socket
}

/** Opens a raw TCP connection and returns everything received on it. */
function rawConnect(port: number): Promise<{ socket: net.Socket; received: () => Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.connect({ host: '127.0.0.1', port }, () => resolve({ socket, received: () => Buffer.concat(chunks) }))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    onCleanup(() => {
      socket.destroy()
    })
  })
}

async function until(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

describe('5. websocket tunnel', () => {
  it('tunnels to a ws echo upstream and reports every message in both directions', async () => {
    const echo = await startEcho()
    const { tapped, onUpgradeFrame } = recorder()
    const proxy = await startProxy(echo.port, { onUpgradeFrame })
    const socket = connect(`ws://localhost:${proxy.port}/hmr?token=t0k`, { perMessageDeflate: true, origin: `http://localhost:${proxy.port}` }, ['vite-hmr'])
    await opened(socket)

    // The handshake reached the upstream with the proxy's header policy.
    const upgrade = echo.upgrades[0]
    expect(upgrade?.url).toBe('/hmr?token=t0k')
    expect(upgrade?.headers.host).toBe(`localhost:${proxy.port}`)
    expect(upgrade?.headers['x-forwarded-host']).toBe(`localhost:${proxy.port}`)
    expect(upgrade?.headers.origin).toBe(`http://localhost:${proxy.port}`)
    expect(upgrade?.headers['sec-websocket-protocol']).toBe('vite-hmr')
    // The extension offer was removed, so nothing is compressed although both ends support it.
    expect(upgrade?.headers['sec-websocket-extensions']).toBeUndefined()
    expect(socket.extensions).toBe('')
    expect(socket.protocol).toBe('vite-hmr')

    socket.send('{"type":"ping"}')
    expect((await nextMessage(socket)).data.toString()).toBe('echo:{"type":"ping"}')

    // 70 kB needs the 64-bit length form; 300 bytes the 16-bit form.
    const big = randomBytes(70_000)
    socket.send(big)
    const echoedBig = await nextMessage(socket)
    expect(echoedBig.isBinary).toBe(true)
    expect(echoedBig.data.equals(big)).toBe(true)
    const medium = 'm'.repeat(300)
    socket.send(medium)
    expect((await nextMessage(socket)).data.toString()).toBe(`echo:${medium}`)

    const up = tapped.filter((entry) => entry.direction === 'client-to-upstream').map((entry) => entry.message)
    const down = tapped.filter((entry) => entry.direction === 'upstream-to-client').map((entry) => entry.message)
    expect(up.map((message) => message.opcode)).toEqual([WS_OPCODE.text, WS_OPCODE.binary, WS_OPCODE.text])
    expect(up[0]?.text).toBe('{"type":"ping"}')
    expect(up[1]?.data.equals(big)).toBe(true)
    expect(up[1]?.text).toBeUndefined()
    expect(up[2]?.text).toBe(medium)
    expect(down.map((message) => message.opcode)).toEqual([WS_OPCODE.text, WS_OPCODE.binary, WS_OPCODE.text])
    expect(down[0]?.text).toBe('echo:{"type":"ping"}')
    expect(down[1]?.data.equals(big)).toBe(true)
    expect(down[2]?.text).toBe(`echo:${medium}`)
    expect(tapped[0]?.info).toMatchObject({ path: '/hmr?token=t0k', protocols: ['vite-hmr'] })

    // Control frames and the closing handshake pass through too.
    const pong = new Promise<string>((resolve) => socket.once('pong', (data) => resolve(data.toString())))
    socket.ping('are-you-there')
    expect(await pong).toBe('are-you-there')
    const code = closed(socket)
    socket.close(4001, 'done')
    expect(await code).toBe(4001)
    await until(() => tapped.some((entry) => entry.direction === 'upstream-to-client' && entry.message.opcode === WS_OPCODE.close), 'close frame')
    const opcodes = (direction: FrameDirection): number[] => tapped.filter((entry) => entry.direction === direction).map((entry) => entry.message.opcode)
    expect(opcodes('client-to-upstream').slice(3)).toEqual([WS_OPCODE.ping, WS_OPCODE.close])
    expect(opcodes('upstream-to-client').slice(3)).toEqual([WS_OPCODE.pong, WS_OPCODE.close])
    const closeFrame = tapped.find((entry) => entry.direction === 'client-to-upstream' && entry.message.opcode === WS_OPCODE.close)?.message
    expect(closeFrame?.data.readUInt16BE(0)).toBe(4001)
    expect(closeFrame?.data.subarray(2).toString()).toBe('done')
  })

  it('reports server pushes of mixed JSON and binary messages', async () => {
    const echo = await startEcho()
    const { tapped, onUpgradeFrame } = recorder()
    const proxy = await startProxy(echo.port, { onUpgradeFrame })
    echo.sockets.on('connection', (socket) => {
      socket.send(JSON.stringify({ action: 'building' }))
      socket.send(Buffer.from([0x00, 0x01, 0xfe, 0xff]), { binary: true })
      // Sent as three fragments.
      socket.send('{"action":', { fin: false })
      socket.send('"built",', { fin: false })
      socket.send('"hash":"abc"}', { fin: true })
    })
    const socket = connect(`ws://localhost:${proxy.port}/_next/webpack-hmr`)
    const received: string[] = []
    socket.on('message', (data: RawData, isBinary: boolean) => received.push(isBinary ? 'binary' : data.toString()))
    await until(() => received.length === 3, 'three messages')
    expect(received).toEqual(['{"action":"building"}', 'binary', '{"action":"built","hash":"abc"}'])
    const down = tapped.filter((entry) => entry.direction === 'upstream-to-client').map((entry) => entry.message)
    expect(down.map((message) => message.text)).toEqual(['{"action":"building"}', undefined, '{"action":"built","hash":"abc"}'])
    expect([...(down[1]?.data ?? [])]).toEqual([0x00, 0x01, 0xfe, 0xff])
  })

  it('does not alter a single byte on the wire in either direction', async () => {
    // A raw upstream: records what arrives and answers with fixed bytes.
    const upstreamReceived: Buffer[] = []
    const serverFrames = Buffer.concat([
      Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]), // text "Hello"
      Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c]), // fragment "Hel"
      Buffer.from([0x89, 0x00]), // ping between fragments
      Buffer.from([0x80, 0x02, 0x6c, 0x6f]), // final fragment "lo"
      Buffer.from([0x82, 0x7e, 0x01, 0x00]), Buffer.alloc(256, 0xee), // binary, 16-bit length
    ])
    const responseHead = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fixed-for-test\r\nX-Custom: 1\r\n\r\n'
    const rawUpstream = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        const before = Buffer.concat(upstreamReceived).includes('\r\n\r\n')
        upstreamReceived.push(chunk)
        if (!before && Buffer.concat(upstreamReceived).includes('\r\n\r\n')) {
          // Head and first frame in one write, the rest in awkward pieces.
          socket.write(Buffer.concat([Buffer.from(responseHead), serverFrames.subarray(0, 9)]))
          setTimeout(() => socket.write(serverFrames.subarray(9, 10)), 20)
          setTimeout(() => socket.write(serverFrames.subarray(10, 20)), 40)
          setTimeout(() => socket.write(serverFrames.subarray(20)), 60)
        }
      })
    })
    await new Promise<void>((resolve) => rawUpstream.listen(0, '127.0.0.1', () => resolve()))
    onCleanup(() => new Promise<void>((resolve) => rawUpstream.close(() => resolve())))

    const { tapped, onUpgradeFrame } = recorder()
    const proxy = await startProxy((rawUpstream.address() as AddressInfo).port, { onUpgradeFrame })
    const client = await rawConnect(proxy.port)
    client.socket.write(
      `GET /raw HTTP/1.1\r\nHost: localhost:${proxy.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n',
    )
    await until(() => client.received().length >= responseHead.length + serverFrames.length, 'server frames')
    // The client got the upstream's bytes exactly, response head included.
    expect(client.received().equals(Buffer.concat([Buffer.from(responseHead), serverFrames]))).toBe(true)

    // Client frames: masked text "Hello" (RFC 6455 example), then a masked pong split across writes.
    const clientFrames = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58, 0x8a, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
    client.socket.write(clientFrames.subarray(0, 3))
    await sleep(20)
    client.socket.write(clientFrames.subarray(3, 13))
    await sleep(20)
    client.socket.write(clientFrames.subarray(13))
    const requestEnd = (): number => Buffer.concat(upstreamReceived).indexOf('\r\n\r\n') + 4
    await until(() => Buffer.concat(upstreamReceived).length - requestEnd() >= clientFrames.length, 'client frames')
    const all = Buffer.concat(upstreamReceived)
    expect(all.subarray(requestEnd()).equals(clientFrames)).toBe(true)

    // The handshake request: extension offer removed, forwarding headers added, the rest kept.
    const request = all.subarray(0, requestEnd()).toString('latin1')
    expect(request.startsWith('GET /raw HTTP/1.1\r\n')).toBe(true)
    expect(request).toContain(`Host: localhost:${proxy.port}\r\n`)
    expect(request).toContain('Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n')
    expect(request).toContain('Sec-WebSocket-Version: 13\r\n')
    expect(request).toContain('Connection: Upgrade\r\n')
    expect(request).toContain('Upgrade: websocket\r\n')
    expect(request).toContain(`X-Forwarded-Host: localhost:${proxy.port}\r\n`)
    expect(request.toLowerCase()).not.toContain('sec-websocket-extensions')

    // And the tap read all of it correctly from those same bytes.
    const summary = (direction: FrameDirection): [number, string][] =>
      tapped.filter((entry) => entry.direction === direction).map((entry) => [entry.message.opcode, entry.message.text ?? `${entry.message.data.length} bytes`])
    expect(summary('upstream-to-client')).toEqual([
      [WS_OPCODE.text, 'Hello'],
      [WS_OPCODE.ping, '0 bytes'],
      [WS_OPCODE.text, 'Hello'],
      [WS_OPCODE.binary, '256 bytes'],
    ])
    expect(summary('client-to-upstream')).toEqual([
      [WS_OPCODE.text, 'Hello'],
      [WS_OPCODE.pong, '5 bytes'],
    ])
  })

  it('relays a refused handshake as the upstream answered it', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' })
      res.end('upgrade required')
    })
    const { tapped, onUpgradeFrame } = recorder()
    const proxy = await startProxy(upstream.port, { onUpgradeFrame })
    await expect(opened(connect(`ws://localhost:${proxy.port}/nope`))).rejects.toThrow('HTTP 426')
    expect(tapped).toEqual([])
    // The proxy is still serving.
    await expect(opened(connect(`ws://localhost:${proxy.port}/nope`))).rejects.toThrow('HTTP 426')
  })

  it('does not read a refused handshake\'s body as frames', async () => {
    // The body of this 400 is, byte for byte, a valid text frame.
    const refusal = Buffer.concat([Buffer.from('HTTP/1.1 400 Bad Request\r\nContent-Length: 7\r\nConnection: close\r\n\r\n'), Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f])])
    const rawUpstream = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', () => socket.end(refusal))
    })
    await new Promise<void>((resolve) => rawUpstream.listen(0, '127.0.0.1', () => resolve()))
    onCleanup(() => new Promise<void>((resolve) => rawUpstream.close(() => resolve())))
    const { tapped, onUpgradeFrame } = recorder()
    const proxy = await startProxy((rawUpstream.address() as AddressInfo).port, { onUpgradeFrame })
    const client = await rawConnect(proxy.port)
    const ended = new Promise<void>((resolve) => client.socket.once('close', () => resolve()))
    client.socket.write(
      `GET /raw HTTP/1.1\r\nHost: localhost:${proxy.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    await ended
    expect(client.received().equals(refusal)).toBe(true)
    expect(tapped).toEqual([])
  })

  it('answers 502 when the upstream is not there', async () => {
    const proxy = await startProxy(await getFreePort())
    await expect(opened(connect(`ws://localhost:${proxy.port}/hmr`))).rejects.toThrow('HTTP 502')
    expect(proxy.logs.some((entry) => entry.level === 'warn' && entry.message.includes('/hmr'))).toBe(true)
  })

  it('closes the other side when one side goes away', async () => {
    const echo = await startEcho()
    const proxy = await startProxy(echo.port)
    const first = connect(`ws://localhost:${proxy.port}/a`)
    await opened(first)
    const serverSide = [...echo.sockets.clients][0]
    expect(serverSide).toBeDefined()
    const serverClosed = new Promise<void>((resolve) => serverSide?.once('close', () => resolve()))
    first.terminate()
    await serverClosed

    const second = connect(`ws://localhost:${proxy.port}/b`)
    await opened(second)
    const clientClosed = closed(second)
    for (const client of echo.sockets.clients) client.terminate()
    expect(await clientClosed).toBe(1006)
  })

  it('keeps the tunnel working when the frame handler throws', async () => {
    const echo = await startEcho()
    const proxy = await startProxy(echo.port, {
      onUpgradeFrame: () => {
        throw new Error('handler bug')
      },
    })
    const socket = connect(`ws://localhost:${proxy.port}/hmr`)
    await opened(socket)
    socket.send('still works')
    expect((await nextMessage(socket)).data.toString()).toBe('echo:still works')
    expect(proxy.logs.some((entry) => entry.level === 'warn' && entry.message.includes('onUpgradeFrame'))).toBe(true)
  })

  it('refuses an upgrade with a foreign Host', async () => {
    const echo = await startEcho()
    const proxy = await startProxy(echo.port)
    await expect(opened(connect(`ws://localhost:${proxy.port}/hmr`, { headers: { host: 'evil.example' } }))).rejects.toThrow('HTTP 403')
    expect(echo.upgrades).toHaveLength(0)
  })

  it('close() ends open tunnels', async () => {
    const echo = await startEcho()
    const proxy = await startProxy(echo.port)
    const socket = connect(`ws://localhost:${proxy.port}/hmr`)
    await opened(socket)
    const clientClosed = closed(socket)
    await proxy.close()
    expect(await clientClosed).toBe(1006)
    await until(() => echo.sockets.clients.size === 0, 'upstream side to close')
  })
})

describe('8. the overlay socket under the reserved prefix', () => {
  async function setup(withHandler = true): Promise<{
    proxy: Awaited<ReturnType<typeof startProxy>>
    echo: Awaited<ReturnType<typeof startEcho>>
    paths: string[]
    tapped: Tapped[]
  }> {
    const echo = await startEcho()
    const paths: string[] = []
    const { tapped, onUpgradeFrame } = recorder()
    const proxy = await startProxy(echo.port, {
      onUpgradeFrame,
      ...(withHandler
        ? {
            onWebSocket(socket, request) {
              paths.push(request.url ?? '')
              socket.on('message', (data: RawData) => socket.send(`overlay:${data.toString()}`))
            },
          }
        : {}),
    })
    return { proxy, echo, paths, tapped }
  }

  it('hands a same-origin connection to onWebSocket and never to the upstream', async () => {
    const { proxy, echo, paths, tapped } = await setup()
    for (const host of [`localhost:${proxy.port}`, `127.0.0.1:${proxy.port}`]) {
      const socket = connect(`ws://${host}/__primp/ws?session=1`, { origin: `http://${host}` })
      await opened(socket)
      socket.send('hello')
      expect((await nextMessage(socket)).data.toString()).toBe('overlay:hello')
    }
    expect(paths).toEqual(['/__primp/ws?session=1', '/__primp/ws?session=1'])
    // Not forwarded, and not reported as an app socket either.
    expect(echo.upgrades).toHaveLength(0)
    expect(tapped).toEqual([])
  })

  it('refuses a missing, foreign or mismatched Origin', async () => {
    const { proxy, paths } = await setup()
    const url = `ws://localhost:${proxy.port}/__primp/ws`
    await expect(opened(connect(url))).rejects.toThrow('HTTP 403')
    await expect(opened(connect(url, { origin: 'http://evil.example' }))).rejects.toThrow('HTTP 403')
    await expect(opened(connect(url, { origin: `https://localhost:${proxy.port}` }))).rejects.toThrow('HTTP 403')
    await expect(opened(connect(url, { origin: `http://localhost:${proxy.port + 1}` }))).rejects.toThrow('HTTP 403')
    // Right port, but not the name the browser used for this connection.
    await expect(opened(connect(url, { origin: `http://127.0.0.1:${proxy.port}` }))).rejects.toThrow('HTTP 403')
    await expect(opened(connect(url, { origin: 'null' }))).rejects.toThrow('HTTP 403')
    expect(paths).toEqual([])
  })

  it('refuses a rebound Host even when Origin matches it', async () => {
    const { proxy, paths } = await setup()
    const host = `evil.example:${proxy.port}`
    const socket = connect(`ws://localhost:${proxy.port}/__primp/ws`, { origin: `http://${host}`, headers: { host } })
    await expect(opened(socket)).rejects.toThrow('HTTP 403')
    expect(paths).toEqual([])
  })

  it('answers 404 when no handler is configured', async () => {
    const { proxy, echo } = await setup(false)
    const socket = connect(`ws://localhost:${proxy.port}/__primp/ws`, { origin: `http://localhost:${proxy.port}` })
    await expect(opened(socket)).rejects.toThrow('HTTP 404')
    expect(echo.upgrades).toHaveLength(0)
  })

  it('survives a handler that throws', async () => {
    const echo = await startEcho()
    let calls = 0
    const proxy = await startProxy(echo.port, {
      onWebSocket(socket) {
        if (++calls === 1) throw new Error('handler bug')
        socket.send('second time lucky')
      },
    })
    const options = { origin: `http://localhost:${proxy.port}` }
    const first = connect(`ws://localhost:${proxy.port}/__primp/ws`, options)
    expect(await closed(first)).toBe(1006)
    expect(proxy.logs.some((entry) => entry.level === 'error' && entry.message.includes('onWebSocket'))).toBe(true)
    const second = connect(`ws://localhost:${proxy.port}/__primp/ws`, options)
    expect((await nextMessage(second)).data.toString()).toBe('second time lucky')
  })

  it('close() ends overlay sockets', async () => {
    const { proxy } = await setup()
    const socket = connect(`ws://localhost:${proxy.port}/__primp/ws`, { origin: `http://localhost:${proxy.port}` })
    await opened(socket)
    const clientClosed = closed(socket)
    await proxy.close()
    expect(await clientClosed).toBe(1006)
  })
})
