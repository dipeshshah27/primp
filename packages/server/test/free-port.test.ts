import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { closeServer, getFreePort, listenOn, listenOnLoopback } from '../src/free-port.ts'

const open: Server[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => closeServer(server)))
})

function tracked(): Server {
  const server = createServer()
  open.push(server)
  return server
}

describe('getFreePort', () => {
  it('returns a port that can be bound on both loopback addresses', async () => {
    const port = await getFreePort()
    expect(port).toBeGreaterThan(1023)
    expect(port).toBeLessThan(65536)
    expect(await listenOn(tracked(), port, '127.0.0.1')).toBe(port)
    expect(await listenOn(tracked(), port, '::1')).toBe(port)
  })

  it('returns different ports while earlier ones are held', async () => {
    const ports = new Set<number>()
    for (let i = 0; i < 20; i++) {
      const port = await getFreePort()
      await listenOn(tracked(), port, '127.0.0.1')
      ports.add(port)
    }
    expect(ports.size).toBe(20)
  })
})

describe('listenOnLoopback', () => {
  it('binds 127.0.0.1 and ::1 on one OS-chosen port', async () => {
    const { port, servers } = await listenOnLoopback(tracked, 0)
    expect(servers).toHaveLength(2)
    expect(servers.map((server) => server.address())).toEqual([
      { address: '127.0.0.1', family: 'IPv4', port },
      { address: '::1', family: 'IPv6', port },
    ])
  })

  it('rejects a fixed port that is taken on either family, leaving nothing bound', async () => {
    for (const taken of ['127.0.0.1', '::1']) {
      const port = await getFreePort()
      const holder = tracked()
      await listenOn(holder, port, taken)
      await expect(listenOnLoopback(tracked, port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
      await closeServer(holder)
      // Both addresses are free again: the failed attempt released its half.
      const { servers } = await listenOnLoopback(tracked, port)
      expect(servers).toHaveLength(2)
      await Promise.all(servers.map((server) => closeServer(server)))
    }
  })
})
