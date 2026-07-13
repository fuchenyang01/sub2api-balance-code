import { createHash } from 'node:crypto'

import { CompactEncrypt, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { AppError } from '../../src/server/errors.js'
import { SecretsService } from '../../src/server/security/secrets.js'

const sessionSecret = 'session-secret-that-is-at-least-32-bytes'
const operationSecret = 'operation-secret-that-is-at-least-32-bytes'
const otherSessionSecret = 'another-session-secret-that-is-32-bytes'
const otherOperationSecret = 'another-operation-secret-that-is-32-bytes'
const now = new Date('2026-07-13T08:00:00.000Z')
const userJwt = 'eyJhbGciOiJIUzI1NiJ9.sensitive-user-jwt.signature'
const operationId = '123e4567-e89b-42d3-a456-426614174000'

function service(
  overrides: Partial<ConstructorParameters<typeof SecretsService>[0]> = {},
): SecretsService {
  return new SecretsService({
    sessionSecret,
    operationSigningSecret: operationSecret,
    operationTtlMinutes: 60,
    now: () => now,
    ...overrides,
  })
}

function derivedKey(secret: string): Uint8Array {
  return createHash('sha256').update(secret, 'utf8').digest()
}

async function expectAppError(
  action: () => Promise<unknown>,
  code: 'SESSION_INVALID' | 'SESSION_EXPIRED' | 'OPERATION_TOKEN_INVALID' | 'OPERATION_TOKEN_EXPIRED',
): Promise<AppError> {
  try {
    await action()
    throw new Error('Expected operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code, status: 401 })
    return error as AppError
  }
}

async function makeSessionToken(
  payload: unknown,
  header: { alg: string; enc: string } = { alg: 'dir', enc: 'A256GCM' },
): Promise<string> {
  const key =
    header.enc === 'A128GCM'
      ? derivedKey(sessionSecret).slice(0, 16)
      : derivedKey(sessionSecret)
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader(header)
    .encrypt(key)
}

async function makeOperationToken(
  claims: Record<string, unknown>,
  options: { secret?: string; alg?: 'HS256' | 'HS384' } = {},
): Promise<string> {
  const alg = options.alg ?? 'HS256'
  return new SignJWT(claims)
    .setProtectedHeader({ alg })
    .sign(derivedKey(options.secret ?? operationSecret))
}

describe('SecretsService sessions', () => {
  it('encrypts session contents and decrypts the original payload', async () => {
    const expiresAt = new Date('2026-07-13T09:00:00.000Z')
    const userId = 987_654_321

    const token = await service().sealSession({ userJwt, userId, expiresAt })

    expect(token).not.toContain(userJwt)
    expect(token).not.toContain(String(userId))
    await expect(service().unsealSession(token)).resolves.toEqual({
      version: 1,
      userJwt,
      userId,
      expiresAt: expiresAt.toISOString(),
    })
  })

  it.each(['wrong secret', 'tampered token', 'malformed token'])('rejects a %s', async (kind) => {
    const token = await service().sealSession({
      userJwt,
      userId: 42,
      expiresAt: new Date('2026-07-13T09:00:00.000Z'),
    })
    const subject =
      kind === 'wrong secret'
        ? service({ sessionSecret: otherSessionSecret })
        : service()
    const input =
      kind === 'tampered token'
        ? `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
        : kind === 'malformed token'
          ? 'not-a-compact-jwe'
          : token

    await expectAppError(() => subject.unsealSession(input), 'SESSION_INVALID')
  })

  it('rejects an unsupported protected header', async () => {
    const token = await makeSessionToken(
      {
        version: 1,
        userJwt,
        userId: 42,
        expiresAt: '2026-07-13T09:00:00.000Z',
      },
      { alg: 'dir', enc: 'A128GCM' },
    )

    await expectAppError(() => service().unsealSession(token), 'SESSION_INVALID')
  })

  it.each([
    {},
    { version: 2, userJwt, userId: 42, expiresAt: '2026-07-13T09:00:00.000Z' },
    { version: 1, userJwt: '', userId: 42, expiresAt: '2026-07-13T09:00:00.000Z' },
    { version: 1, userJwt, userId: 0, expiresAt: '2026-07-13T09:00:00.000Z' },
    { version: 1, userJwt, userId: 42, expiresAt: 'not-a-date' },
  ])('rejects invalid session payload %#', async (payload) => {
    const token = await makeSessionToken(payload)
    await expectAppError(() => service().unsealSession(token), 'SESSION_INVALID')
  })

  it('reports a valid but expired session distinctly', async () => {
    const token = await makeSessionToken({
      version: 1,
      userJwt,
      userId: 42,
      expiresAt: '2026-07-13T07:59:59.000Z',
    })

    await expectAppError(() => service().unsealSession(token), 'SESSION_EXPIRED')
  })

  it.each([
    { userJwt: '', userId: 42, expiresAt: new Date('2026-07-13T09:00:00.000Z') },
    { userJwt, userId: 0, expiresAt: new Date('2026-07-13T09:00:00.000Z') },
    { userJwt, userId: 1.5, expiresAt: new Date('2026-07-13T09:00:00.000Z') },
    { userJwt, userId: 42, expiresAt: new Date('2026-07-13T08:00:00.000Z') },
  ])('rejects invalid session input %#', async (input) => {
    await expectAppError(() => service().sealSession(input), 'SESSION_INVALID')
  })
})

describe('SecretsService operation tokens', () => {
  it('signs and verifies a normalized payload with the configured lifetime', async () => {
    const signed = await service().signOperation({ operationId, userId: 42, amount: '1.23' })

    expect(signed.expiresAt).toBe('2026-07-13T09:00:00.000Z')
    await expect(service().verifyOperation(signed.token, 42)).resolves.toEqual({
      version: 1,
      operationId,
      userId: 42,
      amount: '1.23',
      issuedAt: '2026-07-13T08:00:00.000Z',
      expiresAt: '2026-07-13T09:00:00.000Z',
    })
  })

  it('binds verification to the expected user', async () => {
    const { token } = await service().signOperation({ operationId, userId: 42, amount: '1.23' })
    await expectAppError(() => service().verifyOperation(token, 7), 'OPERATION_TOKEN_INVALID')
  })

  it('reports an expired operation token distinctly using the injected clock', async () => {
    const signer = service({ now: () => new Date('2026-07-13T06:00:00.000Z') })
    const { token } = await signer.signOperation({ operationId, userId: 42, amount: '1.23' })

    await expectAppError(() => service().verifyOperation(token, 42), 'OPERATION_TOKEN_EXPIRED')
  })

  it.each(['wrong secret', 'tampered token'])('rejects a token with a %s', async (kind) => {
    const { token } = await service().signOperation({ operationId, userId: 42, amount: '1.23' })
    const subject =
      kind === 'wrong secret'
        ? service({ operationSigningSecret: otherOperationSecret })
        : service()
    const input =
      kind === 'tampered token'
        ? `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
        : token

    await expectAppError(() => subject.verifyOperation(input, 42), 'OPERATION_TOKEN_INVALID')
  })

  it.each([
    ['wrong issuer', { iss: 'other', aud: 'balance-conversion', sub: '42', jti: operationId, iat: 1_783_929_600, exp: 1_783_933_200, version: 1, amount: '1.23' }, {}],
    ['wrong audience', { iss: 'sub2api-balance-code', aud: 'other', sub: '42', jti: operationId, iat: 1_783_929_600, exp: 1_783_933_200, version: 1, amount: '1.23' }, {}],
    ['wrong algorithm', { iss: 'sub2api-balance-code', aud: 'balance-conversion', sub: '42', jti: operationId, iat: 1_783_929_600, exp: 1_783_933_200, version: 1, amount: '1.23' }, { alg: 'HS384' as const }],
    ['missing claim', { iss: 'sub2api-balance-code', aud: 'balance-conversion', sub: '42', jti: operationId, iat: 1_783_929_600, exp: 1_783_933_200, version: 1 }, {}],
  ])('rejects %s', async (_name, claims, options) => {
    const token = await makeOperationToken(claims, options)
    await expectAppError(() => service().verifyOperation(token, 42), 'OPERATION_TOKEN_INVALID')
  })

  it.each([
    { operationId: 'not-a-uuid', userId: 42, amount: '1.23' },
    { operationId: '123e4567-e89b-12d3-a456-426614174000', userId: 42, amount: '1.23' },
    { operationId, userId: 0, amount: '1.23' },
    { operationId, userId: 1.5, amount: '1.23' },
    { operationId, userId: 42, amount: '001.00' },
    { operationId, userId: 42, amount: '1.00' },
  ])('rejects invalid operation input %#', async (input) => {
    await expectAppError(() => service().signOperation(input), 'OPERATION_TOKEN_INVALID')
  })

  it('does not expose tokens, JWTs, secrets, or JOSE causes in errors', async () => {
    const sessionToken = await service().sealSession({
      userJwt,
      userId: 42,
      expiresAt: new Date('2026-07-13T09:00:00.000Z'),
    })
    const operationToken = (await service().signOperation({ operationId, userId: 42, amount: '1.23' })).token

    const errors = [
      await expectAppError(
        () => service({ sessionSecret: otherSessionSecret }).unsealSession(sessionToken),
        'SESSION_INVALID',
      ),
      await expectAppError(
        () => service({ operationSigningSecret: otherOperationSecret }).verifyOperation(operationToken, 42),
        'OPERATION_TOKEN_INVALID',
      ),
    ]

    for (const error of errors) {
      const exposed = `${error.message} ${JSON.stringify(error)} ${String(error.cause)}`
      expect(exposed).not.toContain(userJwt)
      expect(exposed).not.toContain(sessionToken)
      expect(exposed).not.toContain(operationToken)
      expect(exposed).not.toContain(sessionSecret)
      expect(exposed).not.toContain(operationSecret)
      expect(error.cause).toBeUndefined()
    }
  })
})
