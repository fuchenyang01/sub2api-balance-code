import { createHash } from 'node:crypto'

import { decodeJwt } from 'jose'

export interface TokenDiagnostics {
  fingerprint: string
  issued_at: string | null
  expires_at: string | null
}

const stableReasonPattern = /^[A-Z][A-Z0-9_]{0,63}$/

export function stableUpstreamReason(reason: unknown): string | null {
  return typeof reason === 'string' && stableReasonPattern.test(reason) ? reason : null
}

function numericDate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  const date = new Date(value * 1_000)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9_999) return null
  return date.toISOString()
}

export function tokenDiagnostics(token: string): TokenDiagnostics {
  const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 16)
  try {
    const claims = decodeJwt(token)
    return {
      fingerprint,
      issued_at: numericDate(claims.iat),
      expires_at: numericDate(claims.exp),
    }
  } catch {
    return { fingerprint, issued_at: null, expires_at: null }
  }
}
