import { describe, expect, it } from 'vitest'
import { isAllowedHost, isLoopbackHost, parseHostHeader, rewriteLocation, rewriteSetCookie, type ProxyTarget } from '../src/headers.ts'
import { connectCandidates } from '../src/upstream.ts'

const target: ProxyTarget = { protocol: 'http', host: 'localhost', port: 3000 }

describe('Host header', () => {
  it('parses names, IPv4 and bracketed IPv6', () => {
    expect(parseHostHeader('LocalHost:4000')).toEqual({ hostname: 'localhost', port: 4000 })
    expect(parseHostHeader('127.0.0.1')).toEqual({ hostname: '127.0.0.1', port: undefined })
    expect(parseHostHeader('[::1]:4000')).toEqual({ hostname: '[::1]', port: 4000 })
    expect(parseHostHeader('a b')).toBeUndefined()
    expect(parseHostHeader('user@localhost:4000')).toBeUndefined()
    expect(parseHostHeader(undefined)).toBeUndefined()
  })

  it('allows the three loopback names on the proxy port only', () => {
    for (const host of ['localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'LOCALHOST:4000']) {
      expect(isAllowedHost(host, 4000), host).toBe(true)
    }
    for (const host of [
      'localhost:4001',
      'localhost',
      'evil.example:4000',
      'localhost.evil.example:4000',
      '127.0.0.1.nip.io:4000',
      'app.localhost:4000',
      '192.168.1.5:4000',
      '0.0.0.0:4000',
      '',
      undefined,
    ]) {
      expect(isAllowedHost(host, 4000), String(host)).toBe(false)
    }
    expect(isAllowedHost('localhost', 80)).toBe(true)
  })

  it('knows which targets are this machine', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'app.localhost']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['example.com', '192.168.0.2', '127.example.com', 'localhost.example.com']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('rewriteLocation', () => {
  it('points redirects to the dev server back at the proxy', () => {
    expect(rewriteLocation('http://localhost:3000/login?next=%2F', target, 'localhost:4000')).toBe('http://localhost:4000/login?next=%2F')
    expect(rewriteLocation('http://127.0.0.1:3000/a', target, 'localhost:4000')).toBe('http://localhost:4000/a')
    expect(rewriteLocation('http://[::1]:3000', target, '127.0.0.1:4000')).toBe('http://127.0.0.1:4000')
    expect(rewriteLocation('//localhost:3000/a#frag', target, 'localhost:4000')).toBe('http://localhost:4000/a#frag')
    expect(rewriteLocation('HTTP://LOCALHOST:3000/A', target, 'localhost:4000')).toBe('http://localhost:4000/A')
  })

  it('leaves relative, foreign and near-miss URLs alone', () => {
    for (const value of [
      '/login',
      'login?x=http://localhost:3000/',
      'https://example.com/cb?to=http://localhost:3000/',
      'http://localhost:30001/a',
      'http://localhost:300/a',
      'https://localhost:3000/a',
      'http://localhost:3000.example.com/a',
      'http://localhost:4000/a',
      'mailto:someone@localhost:3000',
    ]) {
      expect(rewriteLocation(value, target, 'localhost:4000'), value).toBe(value)
    }
  })

  it('handles an HTTPS dev server, including URLs it builds from the forwarded Host', () => {
    const secure: ProxyTarget = { protocol: 'https', host: 'localhost', port: 3443 }
    expect(rewriteLocation('https://localhost:3443/a', secure, 'localhost:4000')).toBe('http://localhost:4000/a')
    expect(rewriteLocation('https://localhost:4000/a', secure, 'localhost:4000')).toBe('http://localhost:4000/a')
    expect(rewriteLocation('https://example.com/a', secure, 'localhost:4000')).toBe('https://example.com/a')
  })

  it('matches a default port written or omitted', () => {
    const plain: ProxyTarget = { protocol: 'http', host: 'dev.internal', port: 80 }
    expect(rewriteLocation('http://dev.internal/a', plain, 'localhost:4000')).toBe('http://localhost:4000/a')
    expect(rewriteLocation('http://dev.internal:80/a', plain, 'localhost:4000')).toBe('http://localhost:4000/a')
    // A non-loopback target does not claim the loopback names.
    expect(rewriteLocation('http://localhost/a', plain, 'localhost:4000')).toBe('http://localhost/a')
  })
})

describe('rewriteSetCookie', () => {
  it('drops a Domain that names the dev server and nothing else', () => {
    expect(rewriteSetCookie('sid=abc; Path=/; Domain=localhost:3000; HttpOnly', target)).toBe('sid=abc; Path=/; HttpOnly')
    expect(rewriteSetCookie('sid=abc; domain=LOCALHOST; Secure', target)).toBe('sid=abc; Secure')
    expect(rewriteSetCookie('sid=abc; Domain=.localhost', target)).toBe('sid=abc')
  })

  it('returns every other cookie unchanged, byte for byte', () => {
    for (const value of [
      'sid=abc; Path=/; HttpOnly; SameSite=Lax',
      'sid=abc; Domain=example.com; Path=/',
      'domain=localhost; Path=/',
      'a=b;  Expires=Wed, 21 Oct 2026 07:28:00 GMT ;Max-Age=3600',
      'sid=abc; Domain=localhost:3001',
    ]) {
      expect(rewriteSetCookie(value, target), value).toBe(value)
    }
  })
})

describe('connectCandidates', () => {
  it('tries the configured loopback address first, then the other family', () => {
    expect(connectCandidates('127.0.0.1')).toEqual(['127.0.0.1', '::1'])
    expect(connectCandidates('::1')).toEqual(['::1', '127.0.0.1'])
    expect(connectCandidates('[::1]')).toEqual(['::1', '127.0.0.1'])
    expect(connectCandidates('localhost')).toEqual(['::1', '127.0.0.1'])
    expect(connectCandidates('dev.internal')).toEqual(['dev.internal'])
  })
})
