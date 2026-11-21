import { describe, expect, it } from 'vitest'
import { planCsp } from '../src/csp.ts'

const context = { publicHost: 'localhost:4000', makeNonce: () => 'GENERATED' }

describe('planCsp, nonce mode', () => {
  it('reuses the nonce of a strict-dynamic policy and leaves the header alone', () => {
    const header = "default-src 'self'; script-src 'self' 'nonce-abc123' 'strict-dynamic'; style-src 'self' 'nonce-abc123'"
    const plan = planCsp('nonce', [header], context)
    expect(plan.nonce).toBe('abc123')
    expect(plan.warning).toBeUndefined()
    // Only the WebSocket source is added, as a connect-src copied from default-src.
    expect(plan.values).toEqual([`${header}; connect-src 'self' ws://localhost:4000`])
  })

  it('returns a header that needs nothing byte for byte', () => {
    const header = "script-src  'nonce-R4nd0m=='   https://cdn.example ;  img-src *"
    const plan = planCsp('nonce', [header], context)
    expect(plan.values).toEqual([header])
    expect(plan.nonce).toBe('R4nd0m==')
  })

  it("accepts 'self' without a nonce", () => {
    const header = "script-src 'self' https://cdn.example"
    expect(planCsp('nonce', [header], context)).toEqual({ values: [header], nonce: undefined, warning: undefined })
  })

  it('accepts the proxy origin written as a host source', () => {
    for (const source of ['localhost:4000', 'http://localhost:4000', 'localhost:*', 'http:', '*']) {
      const header = `script-src ${source}`
      expect(planCsp('nonce', [header], context).values, source).toEqual([header])
    }
    for (const source of ['localhost:3000', 'https://localhost:4000', 'example.com', 'localhost']) {
      const plan = planCsp('nonce', [`script-src ${source}`], context)
      expect(plan.values, source).toEqual([`script-src ${source} 'self'`])
    }
  })

  it('prefers script-src-elem over script-src over default-src', () => {
    const plan = planCsp('nonce', ["default-src 'none'; script-src 'none'; script-src-elem 'nonce-n1'"], context)
    expect(plan.nonce).toBe('n1')
    expect(plan.warning).toBeUndefined()
  })

  it('has no opinion when nothing restricts scripts', () => {
    const header = "img-src 'self'; frame-ancestors 'none'"
    expect(planCsp('nonce', [header], context)).toEqual({ values: [header], nonce: undefined, warning: undefined })
  })

  it("falls back to adding 'self' when there is no nonce and no 'self', and warns", () => {
    const plan = planCsp('nonce', ["script-src https://cdn.example 'unsafe-inline'"], context)
    // 'self' rather than a nonce: a nonce would switch off the page's 'unsafe-inline'.
    expect(plan.values).toEqual(["script-src https://cdn.example 'unsafe-inline' 'self'"])
    expect(plan.nonce).toBeUndefined()
    expect(plan.warning).toMatch(/script-src/)
  })

  it("replaces 'none'", () => {
    const plan = planCsp('nonce', ["script-src 'none'"], context)
    expect(plan.values).toEqual(["script-src 'self'"])
    expect(plan.warning).toBeDefined()
  })

  it('creates script-src from default-src instead of loosening default-src', () => {
    const plan = planCsp('nonce', ["default-src https://cdn.example; img-src 'self'"], context)
    expect(plan.values).toEqual([
      "default-src https://cdn.example; img-src 'self'; script-src https://cdn.example 'self'; connect-src https://cdn.example ws://localhost:4000",
    ])
    expect(plan.warning).toBeDefined()
  })

  it('adds a generated nonce under strict-dynamic with hashes only', () => {
    const plan = planCsp('nonce', ["script-src 'sha256-AAAA' 'strict-dynamic'"], context)
    expect(plan.values).toEqual(["script-src 'sha256-AAAA' 'strict-dynamic' 'nonce-GENERATED'"])
    expect(plan.nonce).toBe('GENERATED')
    expect(plan.warning).toBeDefined()
  })

  it('satisfies several policies at once', () => {
    // Two headers, the second carrying two comma-separated policies.
    const plan = planCsp(
      'nonce',
      ["script-src 'nonce-a' 'strict-dynamic'", "script-src 'nonce-a' 'self', script-src 'nonce-b' 'strict-dynamic'"],
      context,
    )
    // No single page nonce passes both strict-dynamic policies, so one is added to each.
    expect(plan.nonce).toBe('GENERATED')
    expect(plan.values).toEqual([
      "script-src 'nonce-a' 'strict-dynamic' 'nonce-GENERATED'",
      "script-src 'nonce-a' 'self', script-src 'nonce-b' 'strict-dynamic' 'nonce-GENERATED'",
    ])
  })

  it('picks the nonce every policy shares', () => {
    const plan = planCsp('nonce', ["script-src 'nonce-a' 'nonce-b' 'strict-dynamic'", "script-src 'nonce-b' 'strict-dynamic'"], context)
    expect(plan.nonce).toBe('b')
    expect(plan.warning).toBeUndefined()
  })

  it('treats report-only values the same way', () => {
    const plan = planCsp('nonce', ["script-src 'nonce-xyz'; connect-src 'self'"], context)
    expect(plan.nonce).toBe('xyz')
    expect(plan.values).toEqual(["script-src 'nonce-xyz'; connect-src 'self' ws://localhost:4000"])
  })
})

describe('planCsp, connect-src', () => {
  it('leaves a policy that already names the socket or all ws', () => {
    for (const header of ['connect-src ws://localhost:4000', 'connect-src ws:', "connect-src 'self' ws://localhost:*"]) {
      expect(planCsp('nonce', [header], context).values, header).toEqual([header])
    }
  })

  it("replaces connect-src 'none'", () => {
    expect(planCsp('nonce', ["connect-src 'none'"], context).values).toEqual(['connect-src ws://localhost:4000'])
  })
})

describe('planCsp, rewrite mode', () => {
  it("adds 'self' and does not use the page's nonce", () => {
    const plan = planCsp('rewrite', ["script-src 'nonce-abc' https://cdn.example"], context)
    expect(plan.values).toEqual(["script-src 'nonce-abc' https://cdn.example 'self'"])
    expect(plan.nonce).toBeUndefined()
    expect(plan.warning).toBeUndefined()
  })

  it('adds its own nonce under strict-dynamic', () => {
    const plan = planCsp('rewrite', ["script-src 'nonce-abc' 'strict-dynamic'"], context)
    expect(plan.values).toEqual(["script-src 'nonce-abc' 'strict-dynamic' 'nonce-GENERATED'"])
    expect(plan.nonce).toBe('GENERATED')
  })

  it('changes nothing when the policy already allows the proxy origin', () => {
    const header = "script-src 'self'"
    expect(planCsp('rewrite', [header], context).values).toEqual([header])
  })

  it('generates a usable nonce by default', () => {
    const plan = planCsp('rewrite', ["script-src 'strict-dynamic'"], { publicHost: 'localhost:4000' })
    expect(plan.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(plan.values[0]).toContain(`'nonce-${plan.nonce}'`)
  })
})

describe('planCsp, strip mode', () => {
  it('removes every header', () => {
    expect(planCsp('strip', ["script-src 'none'", "default-src 'self'"], context)).toEqual({
      values: [undefined, undefined],
      nonce: undefined,
      warning: undefined,
    })
  })
})
