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

function tamperCompactToken(
  token: string,
  segmentIndex: number,
): { token: string; originalSegment: string; tamperedSegment: string } {
  const segments = token.split('.')
  const originalSegment = segments[segmentIndex]
  if (originalSegment === undefined || originalSegment.length < 3) {
    throw new Error('Compact token segment is too short to tamper safely')
  }

  const position = Math.floor(originalSegment.length / 2)
  const replacement = originalSegment[position] === 'A' ? 'B' : 'A'
  const tamperedSegment =
    originalSegment.slice(0, position) + replacement + originalSegment.slice(position + 1)
  segments[segmentIndex] = tamperedSegment

  return { token: segments.join('.'), originalSegment, tamperedSegment }
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

async function expectSafeInternalError(action: () => Promise<unknown>): Promise<void> {
  let error: unknown
  try {
    await action()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(AppError)
  const exposed = `${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).cause)}`
  expect(exposed).not.toContain(sessionSecret)
  expect(exposed).not.toContain(operationSecret)
  expect(exposed).not.toContain(userJwt)
  expect((error as Error).cause).toBeUndefined()
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

function operationClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    amount: '1.23',
    iss: 'sub2api-balance-code',
    aud: 'balance-conversion',
    sub: '42',
    jti: operationId,
    iat: Math.floor(now.getTime() / 1_000),
    exp: Math.floor(now.getTime() / 1_000) + 3_600,
    ...overrides,
  }
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

  it('rejects a token encrypted with a different session secret', async () => {
    const token = await service().sealSession({
      userJwt,
      userId: 42,
      expiresAt: new Date('2026-07-13T09:00:00.000Z'),
    })

    await expectAppError(
      () => service({ sessionSecret: otherSessionSecret }).unsealSession(token),
      'SESSION_INVALID',
    )
  })

  it('rejects a token with deterministically tampered ciphertext bytes', async () => {
    const token = await service().sealSession({
      userJwt,
      userId: 42,
      expiresAt: new Date('2026-07-13T09:00:00.000Z'),
    })
    const tampered = tamperCompactToken(token, 3)

    expect(tampered.token).not.toBe(token)
    expect(Buffer.from(tampered.tamperedSegment, 'base64url')).not.toEqual(
      Buffer.from(tampered.originalSegment, 'base64url'),
    )
    await expectAppError(() => service().unsealSession(tampered.token), 'SESSION_INVALID')
  })

  it('rejects a malformed compact JWE', async () => {
    await expectAppError(() => service().unsealSession('not-a-compact-jwe'), 'SESSION_INVALID')
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
    const signed = await service().signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })

    expect(signed.expiresAt).toBe('2026-07-13T09:00:00.000Z')
    await expect(service().verifyOperation(signed.token, 42)).resolves.toEqual({
      version: 1,
      operationId,
      userId: 42,
      amount: '1.23',
      count: 1,
      issuedAt: '2026-07-13T08:00:00.000Z',
      expiresAt: '2026-07-13T09:00:00.000Z',
    })
  })

  it.each(['0.0000001', '0.00000001', '1000000000000000000000'])(
    'signs and verifies canonical plain decimal amount %s',
    async (amount) => {
      const signed = await service().signOperation({ operationId, userId: 42, amount, count: 1 })

      await expect(service().verifyOperation(signed.token, 42)).resolves.toMatchObject({ amount })
    },
  )

  it('signs and verifies an explicit batch count', async () => {
    const signed = await service().signOperation({
      operationId,
      userId: 42,
      amount: '1.23',
      count: 100,
    })
    await expect(service().verifyOperation(signed.token, 42)).resolves.toMatchObject({
      operationId,
      userId: 42,
      amount: '1.23',
      count: 100,
    })
  })

  it('treats a valid legacy operation without count as a single-code batch', async () => {
    const token = await makeOperationToken(operationClaims())
    await expect(service().verifyOperation(token, 42)).resolves.toMatchObject({ count: 1 })
  })

  it.each([0, 101, 1.5, '2'])('rejects invalid operation count %s', async (count) => {
    const token = await makeOperationToken(operationClaims({ count }))
    await expectAppError(() => service().verifyOperation(token, 42), 'OPERATION_TOKEN_INVALID')
  })

  it('binds verification to the expected user', async () => {
    const { token } = await service().signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })
    await expectAppError(() => service().verifyOperation(token, 7), 'OPERATION_TOKEN_INVALID')
  })

  it('reports an expired operation token distinctly using the injected clock', async () => {
    const signer = service({ now: () => new Date('2026-07-13T06:00:00.000Z') })
    const { token } = await signer.signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })

    await expectAppError(() => service().verifyOperation(token, 42), 'OPERATION_TOKEN_EXPIRED')
  })

  it('does not report an expired token for the wrong expected user', async () => {
    const signer = service({ now: () => new Date('2026-07-13T06:00:00.000Z') })
    const { token } = await signer.signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })

    await expectAppError(() => service().verifyOperation(token, 7), 'OPERATION_TOKEN_INVALID')
  })

  it.each([
    ['amount', { amount: '001.00' }],
    ['version', { version: 2 }],
    ['jti', { jti: 'not-a-uuid' }],
    ['subject', { sub: '0' }],
    ['time order', { iat: 1_783_926_000, exp: 1_783_922_400 }],
  ])('rejects expired tokens with invalid %s claims', async (_name, override) => {
    const token = await makeOperationToken({
      iss: 'sub2api-balance-code',
      aud: 'balance-conversion',
      sub: '42',
      jti: operationId,
      iat: 1_783_922_400,
      exp: 1_783_926_000,
      version: 1,
      amount: '1.23',
      ...override,
    })

    await expectAppError(() => service().verifyOperation(token, 42), 'OPERATION_TOKEN_INVALID')
  })

  it('rejects a token signed with a different operation secret', async () => {
    const { token } = await service().signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })

    await expectAppError(
      () => service({ operationSigningSecret: otherOperationSecret }).verifyOperation(token, 42),
      'OPERATION_TOKEN_INVALID',
    )
  })

  it('rejects a token with deterministically tampered signature bytes', async () => {
    const { token } = await service().signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })
    const tampered = tamperCompactToken(token, 2)

    expect(tampered.token).not.toBe(token)
    expect(Buffer.from(tampered.tamperedSegment, 'base64url')).not.toEqual(
      Buffer.from(tampered.originalSegment, 'base64url'),
    )
    await expectAppError(
      () => service().verifyOperation(tampered.token, 42),
      'OPERATION_TOKEN_INVALID',
    )
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
    { operationId: 'not-a-uuid', userId: 42, amount: '1.23', count: 1 },
    { operationId: '123e4567-e89b-12d3-a456-426614174000', userId: 42, amount: '1.23', count: 1 },
    { operationId, userId: 0, amount: '1.23', count: 1 },
    { operationId, userId: 1.5, amount: '1.23', count: 1 },
    { operationId, userId: 42, amount: '001.00', count: 1 },
    { operationId, userId: 42, amount: '1.00', count: 1 },
    { operationId, userId: 42, amount: '001.23000000', count: 1 },
    { operationId, userId: 42, amount: '1.23000000', count: 1 },
    { operationId, userId: 42, amount: '1.23', count: 0 },
    { operationId, userId: 42, amount: '1.23', count: 101 },
    { operationId, userId: 42, amount: '1.23', count: 1.5 },
  ])('rejects invalid operation input %#', async (input) => {
    await expectAppError(() => service().signOperation(input), 'OPERATION_TOKEN_INVALID')
  })

  it('rejects a TTL whose seconds overflow the safe integer range', () => {
    expect(() => service({ operationTtlMinutes: Number.MAX_SAFE_INTEGER })).toThrow(TypeError)
  })

  it('fails safely when the injected clock is invalid for every public operation', async () => {
    const sessionToken = await service().sealSession({
      userJwt,
      userId: 42,
      expiresAt: new Date('2026-07-13T09:00:00.000Z'),
    })
    const operationToken = (await service().signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })).token
    const invalidClock = service({ now: () => new Date(Number.NaN) })

    const actions = [
      () => invalidClock.sealSession({ userJwt, userId: 42, expiresAt: new Date('2026-07-13T09:00:00.000Z') }),
      () => invalidClock.unsealSession(sessionToken),
      () => invalidClock.signOperation({ operationId, userId: 42, amount: '1.23', count: 1 }),
      () => invalidClock.verifyOperation(operationToken, 42),
    ]
    for (const action of actions) await expectSafeInternalError(action)
  })

  it('does not expose an error thrown by the injected clock', async () => {
    const subject = service({
      now: () => {
        throw new Error(operationSecret)
      },
    })

    await expectSafeInternalError(() =>
      subject.signOperation({ operationId, userId: 42, amount: '1.23', count: 1 }),
    )
  })

  it('does not expose tokens, JWTs, secrets, or JOSE causes in errors', async () => {
    const sessionToken = await service().sealSession({
      userJwt,
      userId: 42,
      expiresAt: new Date('2026-07-13T09:00:00.000Z'),
    })
    const operationToken = (await service().signOperation({ operationId, userId: 42, amount: '1.23', count: 1 })).token

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
