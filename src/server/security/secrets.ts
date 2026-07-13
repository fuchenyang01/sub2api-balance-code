import { createHash } from 'node:crypto'

import { CompactEncrypt, SignJWT, compactDecrypt, errors, jwtVerify } from 'jose'
import type { JWTPayload } from 'jose'

import { normalizeAmount } from '../amount.js'
import { AppError } from '../errors.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const operationIssuer = 'sub2api-balance-code'
const operationAudience = 'balance-conversion'
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface SecretsServiceOptions {
  sessionSecret: string
  operationSigningSecret: string
  operationTtlMinutes: number
  now?: () => Date
}

export interface SessionPayload {
  version: 1
  userJwt: string
  userId: number
  expiresAt: string
}

export interface OperationPayload {
  version: 1
  operationId: string
  userId: number
  amount: string
  issuedAt: string
  expiresAt: string
}

function keyFromSecret(secret: string): Uint8Array {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new TypeError('Secret must contain at least 32 bytes')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function isCanonicalAmount(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return normalizeAmount(value) === value
  } catch {
    return false
  }
}

function numericDateToIso(value: number): string | undefined {
  try {
    return new Date(value * 1000).toISOString()
  } catch {
    return undefined
  }
}

function invalidSession(): AppError {
  return new AppError('SESSION_INVALID', 401, '会话无效')
}

function expiredSession(): AppError {
  return new AppError('SESSION_EXPIRED', 401, '会话已过期')
}

function invalidOperation(): AppError {
  return new AppError('OPERATION_TOKEN_INVALID', 401, '操作令牌无效')
}

function expiredOperation(): AppError {
  return new AppError('OPERATION_TOKEN_EXPIRED', 401, '操作令牌已过期')
}

function internalSecurityError(): Error {
  return new Error('安全操作失败')
}

function validateOperationPayload(
  payload: JWTPayload,
  expectedUserId: number,
): OperationPayload {
  if (
    payload.version !== 1 ||
    typeof payload.jti !== 'string' ||
    !uuidV4Pattern.test(payload.jti) ||
    typeof payload.sub !== 'string' ||
    typeof payload.iat !== 'number' ||
    !Number.isSafeInteger(payload.iat) ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    !isCanonicalAmount(payload.amount)
  ) {
    throw invalidOperation()
  }

  const userId = Number(payload.sub)
  const issuedAt = numericDateToIso(payload.iat)
  const expiresAt = numericDateToIso(payload.exp)
  if (
    !isPositiveInteger(userId) ||
    String(userId) !== payload.sub ||
    !isPositiveInteger(expectedUserId) ||
    userId !== expectedUserId ||
    issuedAt === undefined ||
    expiresAt === undefined
  ) {
    throw invalidOperation()
  }

  return {
    version: 1,
    operationId: payload.jti,
    userId,
    amount: payload.amount,
    issuedAt,
    expiresAt,
  }
}

export class SecretsService {
  readonly #sessionKey: Uint8Array
  readonly #operationKey: Uint8Array
  readonly #operationTtlSeconds: number
  readonly #now: () => Date

  constructor(options: SecretsServiceOptions) {
    this.#sessionKey = keyFromSecret(options.sessionSecret)
    this.#operationKey = keyFromSecret(options.operationSigningSecret)
    const operationTtlSeconds = options.operationTtlMinutes * 60
    if (
      !Number.isSafeInteger(options.operationTtlMinutes) ||
      options.operationTtlMinutes <= 0 ||
      !Number.isSafeInteger(operationTtlSeconds)
    ) {
      throw new TypeError('Operation TTL must be a positive integer')
    }
    this.#operationTtlSeconds = operationTtlSeconds
    this.#now = options.now ?? (() => new Date())
  }

  #currentDate(): Date {
    try {
      const value = this.#now()
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw internalSecurityError()
      }
      return new Date(value.getTime())
    } catch {
      throw internalSecurityError()
    }
  }

  async sealSession(input: {
    userJwt: string
    userId: number
    expiresAt: Date
  }): Promise<string> {
    if (
      typeof input.userJwt !== 'string' ||
      input.userJwt.length === 0 ||
      !isPositiveInteger(input.userId) ||
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime())
    ) {
      throw invalidSession()
    }
    if (input.expiresAt.getTime() <= this.#currentDate().getTime()) {
      throw invalidSession()
    }

    const payload: SessionPayload = {
      version: 1,
      userJwt: input.userJwt,
      userId: input.userId,
      expiresAt: input.expiresAt.toISOString(),
    }

    try {
      return await new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .encrypt(this.#sessionKey)
    } catch {
      throw internalSecurityError()
    }
  }

  async unsealSession(token: string): Promise<SessionPayload> {
    const currentDate = this.#currentDate()
    try {
      const { plaintext, protectedHeader } = await compactDecrypt(token, this.#sessionKey, {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
      })
      if (protectedHeader.alg !== 'dir' || protectedHeader.enc !== 'A256GCM') {
        throw invalidSession()
      }

      const payload: unknown = JSON.parse(decoder.decode(plaintext))
      if (
        !isRecord(payload) ||
        Object.keys(payload).length !== 4 ||
        payload.version !== 1 ||
        typeof payload.userJwt !== 'string' ||
        payload.userJwt.length === 0 ||
        !isPositiveInteger(payload.userId) ||
        !isCanonicalIsoDate(payload.expiresAt)
      ) {
        throw invalidSession()
      }
      if (Date.parse(payload.expiresAt) <= currentDate.getTime()) {
        throw expiredSession()
      }

      return payload as unknown as SessionPayload
    } catch (error) {
      if (error instanceof AppError) throw error
      throw invalidSession()
    }
  }

  async signOperation(input: {
    operationId: string
    userId: number
    amount: string
  }): Promise<{ token: string; expiresAt: string }> {
    if (
      typeof input.operationId !== 'string' ||
      !uuidV4Pattern.test(input.operationId) ||
      !isPositiveInteger(input.userId) ||
      !isCanonicalAmount(input.amount)
    ) {
      throw invalidOperation()
    }

    const issuedAtSeconds = Math.floor(this.#currentDate().getTime() / 1000)
    const expiresAtSeconds = issuedAtSeconds + this.#operationTtlSeconds
    try {
      const token = await new SignJWT({ version: 1, amount: input.amount })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(operationIssuer)
        .setAudience(operationAudience)
        .setSubject(String(input.userId))
        .setJti(input.operationId)
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime(expiresAtSeconds)
        .sign(this.#operationKey)

      return {
        token,
        expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      }
    } catch {
      throw internalSecurityError()
    }
  }

  async verifyOperation(token: string, expectedUserId: number): Promise<OperationPayload> {
    const currentDate = this.#currentDate()
    try {
      const { payload } = await jwtVerify(token, this.#operationKey, {
        algorithms: ['HS256'],
        issuer: operationIssuer,
        audience: operationAudience,
        currentDate,
        requiredClaims: ['iat', 'exp', 'sub', 'jti'],
      })
      return validateOperationPayload(payload, expectedUserId)
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        validateOperationPayload(error.payload, expectedUserId)
        throw expiredOperation()
      }
      if (error instanceof AppError) throw error
      throw invalidOperation()
    }
  }
}
