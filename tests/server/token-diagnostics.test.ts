import { describe, expect, it } from 'vitest'

import {
  stableUpstreamReason,
  tokenDiagnostics,
} from '../../src/server/security/token-diagnostics.js'

function jwt(payload: Record<string, unknown>, signature = 'signature'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${claims}.${signature}`
}

describe('token diagnostics', () => {
  it('returns stable, non-reversible fields for a JWT', () => {
    const issuedAt = Math.floor(Date.parse('2026-07-17T10:00:00.000Z') / 1_000)
    const expiresAt = Math.floor(Date.parse('2026-07-17T11:00:00.000Z') / 1_000)
    const token = jwt({ iat: issuedAt, exp: expiresAt })

    const first = tokenDiagnostics(token)
    const second = tokenDiagnostics(token)

    expect(first).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      issued_at: '2026-07-17T10:00:00.000Z',
      expires_at: '2026-07-17T11:00:00.000Z',
    })
    expect(second).toEqual(first)
    expect(JSON.stringify(first)).not.toContain(token)
  })

  it('uses a different fingerprint for a different token', () => {
    const claims = { iat: 1_784_282_400, exp: 1_784_286_000 }

    expect(tokenDiagnostics(jwt(claims, 'first')).fingerprint).not.toBe(
      tokenDiagnostics(jwt(claims, 'second')).fingerprint,
    )
  })

  it('keeps the fingerprint and nulls claims for malformed input', () => {
    expect(tokenDiagnostics('not-a-jwt')).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      issued_at: null,
      expires_at: null,
    })
  })

  it.each([
    ['INVALID_TOKEN', 'INVALID_TOKEN'],
    ['TOKEN_REVOKED_2', 'TOKEN_REVOKED_2'],
    ['PRIVATE RESPONSE DETAIL: account=alice', null],
    ['invalid_token', null],
    ['A'.repeat(65), null],
    [undefined, null],
  ] as const)('keeps only stable upstream reason codes: %s', (reason, expected) => {
    expect(stableUpstreamReason(reason)).toBe(expected)
  })
})
