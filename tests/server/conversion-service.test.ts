import { describe, expect, it } from 'vitest'

import type { ExecuteResponse, PrepareResponse } from '../../src/shared/contracts.js'
import { KeyedMutex } from '../../src/server/conversion/keyed-mutex.js'
import { ConversionService } from '../../src/server/conversion/service.js'
import { AppError } from '../../src/server/errors.js'
import { SecretsService, type OperationPayload } from '../../src/server/security/secrets.js'
import type { AdminClient } from '../../src/server/sub2api/admin-client.js'
import { UpstreamError, type UpstreamErrorKind } from '../../src/server/sub2api/http.js'
import type { RedeemCode } from '../../src/server/sub2api/types.js'
import type { UpstreamUserContext } from '../../src/server/sub2api/user-context.js'
import type { UserClient } from '../../src/server/sub2api/user-client.js'

const now = '2026-07-13T08:00:00.000Z'
const expiresAt = '2026-07-13T08:10:00.000Z'
const operationId = '11111111-1111-4111-8111-111111111111'
const secondOperationId = '22222222-2222-4222-8222-222222222222'
const userId = 7
const upstreamContext: UpstreamUserContext = { userAgent: 'Browser-UA/service-test' }

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class ObservableKeyedMutex extends KeyedMutex<number> {
  readonly secondQueued = deferred()
  #runCount = 0

  override run<T>(key: number, work: () => Promise<T>): Promise<T> {
    const result = super.run(key, work)
    this.#runCount += 1
    if (this.#runCount === 2) this.secondQueued.resolve()
    return result
  }
}

async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function code(overrides: Partial<RedeemCode> = {}): RedeemCode {
  return {
    id: 1,
    code: 'CODE-1',
    type: 'balance',
    value: 10,
    status: 'unused',
    used_by: null,
    created_at: now,
    ...overrides,
  }
}

function codes(count: number, value: number): RedeemCode[] {
  return Array.from({ length: count }, (_, index) => code({
    id: index + 1,
    code: `CODE-${index + 1}`,
    value,
  }))
}

class FakeUserClient implements UserClient {
  profile = {
    id: userId,
    username: 'alice',
    balance: 100,
    status: 'active',
    allowed_groups: [24],
  }
  calls: string[] = []
  contexts: Array<UpstreamUserContext | undefined> = []
  error: unknown

  async getProfile(
    userJwt: string,
    context?: UpstreamUserContext,
  ): Promise<typeof this.profile> {
    this.calls.push(userJwt)
    this.contexts.push(context)
    if (this.error !== undefined) throw this.error
    return this.profile
  }
}

class FakeSecrets {
  readonly signed: Array<{
    operationId: string
    userId: number
    amount: string
    count: number
  }> = []
  readonly verified: Array<[string, number]> = []
  payload: OperationPayload = {
    version: 1,
    operationId,
    userId,
    amount: '10',
    count: 1,
    issuedAt: now,
    expiresAt,
  }

  async signOperation(input: {
    operationId: string
    userId: number
    amount: string
    count: number
  }): Promise<{ token: string; expiresAt: string }> {
    this.signed.push(input)
    return { token: `token-${input.operationId}`, expiresAt }
  }

  async verifyOperation(token: string, expectedUserId: number): Promise<OperationPayload> {
    this.verified.push([token, expectedUserId])
    return this.payload
  }
}

class TestConversionService extends ConversionService {
  prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
  ): Promise<PrepareResponse>
  prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
    context: UpstreamUserContext,
  ): Promise<PrepareResponse>
  override prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
    context?: UpstreamUserContext,
  ): Promise<PrepareResponse> {
    return super.prepare(userJwt, userId, operationId, rawAmount, count, context)
  }

  execute(operationToken: string, userId: number): Promise<ExecuteResponse>
  execute(
    operationToken: string,
    userJwt: string,
    userId: number,
    context?: UpstreamUserContext,
  ): Promise<ExecuteResponse>
  override execute(
    operationToken: string,
    userJwtOrUserId: string | number,
    explicitUserId?: number,
    context?: UpstreamUserContext,
  ): Promise<ExecuteResponse> {
    const effectiveUserId = explicitUserId ?? userJwtOrUserId as number
    const userJwt = typeof userJwtOrUserId === 'string'
      ? userJwtOrUserId
      : `user-${effectiveUserId}-jwt`
    return super.execute(operationToken, userJwt, effectiveUserId, context)
  }
}

type AdminCall =
  | ['generate', string, number, number]
  | ['batchDelete', number[]]
  | ['getCode', number]
  | ['delete', number]
  | ['debit', number, string, number]

class FakeAdminClient implements AdminClient {
  calls: AdminCall[] = []
  generatedCodes: RedeemCode[] = codes(1, 10)
  generationCache = new Map<string, RedeemCode[]>()
  generateHooks = new Map<string, () => void | Promise<void>>()
  generateErrors: unknown[] = []
  debitErrors: unknown[] = []
  batchDeleteErrors: unknown[] = []
  batchDeleted: number | undefined
  generateGate: Promise<void> | undefined
  debitHook: (() => void | Promise<void>) | undefined

  async generateCodes(id: string, amount: number, count: number): Promise<RedeemCode[]> {
    this.calls.push(['generate', id, amount, count])
    await this.generateHooks.get(id)?.()
    if (this.generateGate !== undefined) await this.generateGate
    const error = this.generateErrors.shift()
    if (error !== undefined) throw error
    const replay = this.generationCache.get(id)
    if (replay !== undefined) return replay
    this.generationCache.set(id, this.generatedCodes)
    return this.generatedCodes
  }

  async batchDeleteCodes(ids: number[]): Promise<number> {
    this.calls.push(['batchDelete', ids])
    const error = this.batchDeleteErrors.shift()
    if (error !== undefined) throw error
    return this.batchDeleted ?? ids.length
  }

  async getCode(id: number): Promise<RedeemCode | null> {
    this.calls.push(['getCode', id])
    return null
  }

  async deleteCode(id: number): Promise<'deleted' | 'missing'> {
    this.calls.push(['delete', id])
    return 'missing'
  }

  async debitBalance(id: number, opId: string, amount: number): Promise<void> {
    this.calls.push(['debit', id, opId, amount])
    if (this.debitHook !== undefined) await this.debitHook()
    const error = this.debitErrors.shift()
    if (error !== undefined) throw error
  }
}

function upstream(kind: UpstreamErrorKind, status?: number): UpstreamError {
  return new UpstreamError(kind, `upstream ${kind}`, status === undefined ? {} : { status })
}

function setup(mutex: KeyedMutex<number> = new KeyedMutex<number>()): {
  service: TestConversionService
  users: FakeUserClient
  admin: FakeAdminClient
  secrets: FakeSecrets
} {
  const users = new FakeUserClient()
  const admin = new FakeAdminClient()
  const secrets = new FakeSecrets()
  return {
    service: new TestConversionService(users, admin, secrets, 24, mutex),
    users,
    admin,
    secrets,
  }
}

async function expectAppError(
  action: () => Promise<unknown>,
  codeValue: AppError['code'],
): Promise<AppError> {
  try {
    await action()
    throw new Error('Expected operation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: codeValue })
    return error as AppError
  }
}

describe('ConversionService.prepare', () => {
  it('normalizes one-code input and signs an explicit count', async () => {
    const { service, secrets } = setup()

    await expect(service.prepare('user-jwt', userId, operationId, '0010.00000000', 1)).resolves.toEqual({
      operation_token: `token-${operationId}`,
      expires_at: expiresAt,
      amount: '10',
      count: 1,
      total_amount: '10',
    })
    expect(secrets.signed).toEqual([{ operationId, userId, amount: '10', count: 1 }])
  })

  it('prepares one batch against total balance and signs count', async () => {
    const { service, users, secrets } = setup()
    users.profile.balance = 30

    await expect(service.prepare('user-jwt', userId, operationId, '2.5', 10)).resolves.toEqual({
      operation_token: `token-${operationId}`,
      expires_at: expiresAt,
      amount: '2.5',
      count: 10,
      total_amount: '25',
    })
    expect(secrets.signed).toEqual([{ operationId, userId, amount: '2.5', count: 10 }])
  })

  it('forwards the current upstream context without signing it', async () => {
    const { service, users, secrets } = setup()

    await service.prepare('user-jwt', userId, operationId, '10', 1, upstreamContext)

    expect(users.contexts).toEqual([upstreamContext])
    expect(secrets.signed).toHaveLength(1)
    expect(secrets.signed[0]).not.toHaveProperty('upstreamContext')
    expect(secrets.signed[0]).not.toHaveProperty('userAgent')
  })

  it('preserves a normalized plain decimal that Decimal.toString would exponentiate', async () => {
    const { service, users, secrets } = setup()
    users.profile = { ...users.profile, balance: 1e22 }
    const amount = '1000000000000000000000'

    await expect(service.prepare('user-jwt', userId, operationId, amount, 1)).resolves.toMatchObject({
      amount,
      total_amount: amount,
    })
    expect(secrets.signed[0]?.amount).toBe(amount)
  })

  it('rejects a profile belonging to a different session user', async () => {
    const { service, users, secrets } = setup()
    users.profile = { ...users.profile, id: 8 }

    await expectAppError(
      () => service.prepare('user-jwt', userId, operationId, '10', 1),
      'SESSION_INVALID',
    )
    expect(secrets.signed).toEqual([])
  })

  it('rejects a user without redemption access before signing', async () => {
    const { service, users, admin, secrets } = setup()
    users.profile = { ...users.profile, allowed_groups: [] }

    await expectAppError(
      () => service.prepare('user-jwt', userId, operationId, '10', 1),
      'REDEEM_ACCESS_DENIED',
    )
    expect(secrets.signed).toEqual([])
    expect(admin.calls).toEqual([])
  })

  it('rejects a batch total above the live balance without generating a token', async () => {
    const { service, users, secrets } = setup()
    users.profile = { ...users.profile, balance: 24.99 }

    await expectAppError(
      () => service.prepare('user-jwt', userId, operationId, '2.5', 10),
      'AMOUNT_EXCEEDS_BALANCE',
    )
    expect(secrets.signed).toEqual([])
  })

  it.each([0, 101, 1.5])('rejects invalid batch count %s', async (count) => {
    const { service, secrets } = setup()
    await expectAppError(
      () => service.prepare('user-jwt', userId, operationId, '1', count),
      'AMOUNT_INVALID',
    )
    expect(secrets.signed).toEqual([])
  })
})

describe('ConversionService.execute', () => {
  it('generates once and debits the batch total once', async () => {
    const { service, admin, secrets } = setup()
    admin.generatedCodes = codes(10, 2.5)
    secrets.payload = { ...secrets.payload, amount: '2.5', count: 10 }

    const result = await service.execute('operation-token', 'user-jwt', userId)

    expect(admin.calls).toEqual([
      ['generate', operationId, 2.5, 10],
      ['debit', userId, operationId, 25],
    ])
    expect(result).toMatchObject({
      status: 'completed',
      operation_id: operationId,
      amount: '2.5',
      count: 10,
      total_amount: '25',
    })
    expect(result.status === 'completed' && result.codes).toHaveLength(10)
  })

  it('forwards the current context into the locked profile revalidation', async () => {
    const { service, users } = setup()

    await service.execute('operation-token', 'user-jwt', userId, upstreamContext)

    expect(users.contexts).toEqual([upstreamContext])
  })

  it('forwards context when profile auth fails before administrator side effects', async () => {
    const { service, users, admin } = setup()
    users.error = upstream('auth')

    await expectAppError(
      () => service.execute('operation-token', 'user-jwt', userId, upstreamContext),
      'SESSION_EXPIRED',
    )

    expect(users.contexts).toEqual([upstreamContext])
    expect(admin.calls).toEqual([])
  })

  it('supports the maximum count as one generation and one debit', async () => {
    const { service, admin, secrets } = setup()
    admin.generatedCodes = codes(100, 0.25)
    secrets.payload = { ...secrets.payload, amount: '0.25', count: 100 }

    const result = await service.execute('operation-token', userId)

    expect(result.status === 'completed' && result.codes).toHaveLength(100)
    expect(admin.calls.filter(([name]) => name === 'generate')).toEqual([
      ['generate', operationId, 0.25, 100],
    ])
    expect(admin.calls.filter(([name]) => name === 'debit')).toEqual([
      ['debit', userId, operationId, 25],
    ])
  })

  it('replays the same batch after an uncertain debit even if live balance has fallen', async () => {
    const { service, users, admin, secrets } = setup()
    secrets.payload = { ...secrets.payload, amount: '60', count: 1 }
    admin.generatedCodes = codes(1, 60)
    admin.debitHook = () => {
      users.profile = { ...users.profile, balance: 40 }
    }
    admin.debitErrors.push(upstream('timeout'))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'CONVERSION_PENDING',
    })
    await expect(service.execute('operation-token', userId)).resolves.toMatchObject({
      status: 'completed',
      amount: '60',
      count: 1,
    })
    expect(admin.calls.filter(([name]) => name === 'generate')).toHaveLength(2)
    expect(admin.calls.filter(([name]) => name === 'debit')).toHaveLength(2)
    expect(admin.calls.some(([name]) => name === 'batchDelete')).toBe(false)
  })

  it('rejects a live profile belonging to a different user before admin calls', async () => {
    const { service, users, admin } = setup()
    users.profile = { ...users.profile, id: 8 }

    await expectAppError(
      () => service.execute('operation-token', 'user-jwt', userId),
      'SESSION_INVALID',
    )
    expect(admin.calls).toEqual([])
  })

  it.each([
    ['auth', 'SESSION_EXPIRED'],
    ['timeout', 'UPSTREAM_UNAVAILABLE'],
    ['invalid-response', 'UPSTREAM_UNAVAILABLE'],
  ] as const)('maps live profile %s failures before admin calls', async (kind, errorCode) => {
    const { service, users, admin } = setup()
    users.error = upstream(kind)

    await expectAppError(
      () => service.execute('operation-token', 'user-jwt', userId),
      errorCode,
    )
    expect(admin.calls).toEqual([])
  })

  it.each([
    ['wrong length', () => codes(1, 2.5)],
    ['duplicate id', () => {
      const items = codes(2, 2.5)
      return [items[0]!, { ...items[1]!, id: items[0]!.id }]
    }],
    ['duplicate code', () => {
      const items = codes(2, 2.5)
      return [items[0]!, { ...items[1]!, code: items[0]!.code }]
    }],
    ['wrong type', () => [code({ value: 2.5 }), code({ id: 2, code: 'CODE-2', value: 2.5, type: 'quota' })]],
    ['wrong value', () => [code({ value: 9 }), code({ id: 2, code: 'CODE-2', value: 2.5 })]],
  ] as const)('keeps invalid generated batch hidden: %s', async (_name, generated) => {
    const { service, admin, secrets } = setup()
    secrets.payload = { ...secrets.payload, amount: '2.5', count: 2 }
    admin.generatedCodes = generated()

    const response = await service.execute('operation-token', userId)

    expect(response).toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'MANUAL_REVIEW_REQUIRED',
    })
    expect(response).not.toHaveProperty('codes')
    expect(admin.calls.some(([name]) => name === 'debit')).toBe(false)
  })

  it.each([
    ['auth', undefined, 'UPSTREAM_AUTH_FAILED'],
    ['timeout', undefined, 'CONVERSION_PENDING'],
    ['network', undefined, 'CONVERSION_PENDING'],
    ['idempotency-in-progress', undefined, 'CONVERSION_IN_PROGRESS'],
    ['idempotency-store-unavailable', undefined, 'UPSTREAM_IDEMPOTENCY_UNAVAILABLE'],
    ['http', 500, 'CONVERSION_PENDING'],
    ['http', 400, 'UPSTREAM_UNAVAILABLE'],
    ['invalid-response', undefined, 'CONVERSION_PENDING'],
  ] as const)('maps generation failure %s %s', async (kind, status, expected) => {
    const { service, admin } = setup()
    admin.generateErrors.push(upstream(kind, status))

    if (expected === 'UPSTREAM_AUTH_FAILED' || expected === 'UPSTREAM_UNAVAILABLE') {
      await expectAppError(() => service.execute('operation-token', userId), expected)
    } else {
      await expect(service.execute('operation-token', userId)).resolves.toEqual({
        status: 'pending',
        operation_id: operationId,
        error: expected,
      })
    }
    expect(admin.calls.some(([name]) => name === 'debit')).toBe(false)
  })

  it('batch deletes every generated code after deterministic insufficient debit', async () => {
    const { service, admin, secrets } = setup()
    secrets.payload = { ...secrets.payload, amount: '2.5', count: 3 }
    admin.generatedCodes = codes(3, 2.5)
    admin.debitErrors.push(upstream('insufficient-balance'))

    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')
    expect(admin.calls).toEqual([
      ['generate', operationId, 2.5, 3],
      ['debit', userId, operationId, 7.5],
      ['batchDelete', [1, 2, 3]],
    ])
  })

  it('requires manual review when batch deletion count differs', async () => {
    const { service, admin, secrets } = setup()
    secrets.payload = { ...secrets.payload, amount: '2.5', count: 3 }
    admin.generatedCodes = codes(3, 2.5)
    admin.debitErrors.push(upstream('insufficient-balance'))
    admin.batchDeleted = 2

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'MANUAL_REVIEW_REQUIRED',
    })
  })

  it.each([
    ['timeout', undefined, 'CONVERSION_PENDING'],
    ['network', undefined, 'CONVERSION_PENDING'],
    ['http', 500, 'CONVERSION_PENDING'],
  ] as const)('keeps uncertain batch deletion %s pending', async (kind, status, expected) => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('insufficient-balance'))
    admin.batchDeleteErrors.push(upstream(kind, status))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: expected,
    })
  })

  it('maps a definite batch deletion failure without exposing codes', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('insufficient-balance'))
    admin.batchDeleteErrors.push(upstream('auth'))

    await expectAppError(() => service.execute('operation-token', userId), 'UPSTREAM_AUTH_FAILED')
  })

  it.each([
    ['timeout', undefined, 'CONVERSION_PENDING'],
    ['network', undefined, 'CONVERSION_PENDING'],
    ['idempotency-in-progress', undefined, 'CONVERSION_IN_PROGRESS'],
    ['idempotency-store-unavailable', undefined, 'UPSTREAM_IDEMPOTENCY_UNAVAILABLE'],
    ['http', 408, 'CONVERSION_PENDING'],
    ['http', 500, 'CONVERSION_PENDING'],
    ['invalid-response', undefined, 'CONVERSION_PENDING'],
  ] as const)('returns pending without deleting after uncertain %s debit', async (kind, status, error) => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream(kind, status))

    const result = await service.execute('operation-token', userId)

    expect(result).toEqual({ status: 'pending', operation_id: operationId, error })
    expect(result).not.toHaveProperty('codes')
    expect(admin.calls.some(([name]) => name === 'batchDelete')).toBe(false)
  })

  it('maps a definite debit request error without deletion', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('http', 400))

    await expectAppError(() => service.execute('operation-token', userId), 'UPSTREAM_UNAVAILABLE')
    expect(admin.calls.some(([name]) => name === 'batchDelete')).toBe(false)
  })

  it.each([
    ['amount', '9007199254740993', 1],
    ['total', '4503599627370497', 3],
  ] as const)('rejects an unsafe upstream %s before admin calls', async (_name, amount, count) => {
    const { service, secrets, admin } = setup()
    secrets.payload = { ...secrets.payload, amount, count }

    await expectAppError(() => service.execute('operation-token', userId), 'AMOUNT_INVALID')
    expect(admin.calls).toEqual([])
  })

  it('verifies before taking the per-user lock', async () => {
    const { service, secrets, admin } = setup()
    const invalid = new AppError('OPERATION_TOKEN_INVALID', 401, 'invalid')
    secrets.verifyOperation = async (token) => {
      if (token === 'invalid') throw invalid
      return secrets.payload
    }
    const gate = deferred()
    admin.generateGate = gate.promise

    const first = service.execute('valid', userId)
    await Promise.resolve()
    await expect(service.execute('invalid', userId)).rejects.toBe(invalid)
    gate.resolve()
    await first
  })

  it('reverifies inside the lock and rejects a token that expires while queued', async () => {
    let currentTime = new Date(now)
    const realSecrets = new SecretsService({
      sessionSecret: 'session-secret-that-is-at-least-32-bytes',
      operationSigningSecret: 'operation-secret-that-is-at-least-32-bytes',
      operationTtlMinutes: 1,
      now: () => currentTime,
    })
    const firstSigned = await realSecrets.signOperation({
      operationId,
      userId,
      amount: '10',
      count: 1,
    })
    const secondSigned = await realSecrets.signOperation({
      operationId: secondOperationId,
      userId,
      amount: '10',
      count: 1,
    })
    const secondVerifiedOutside = deferred()
    const verificationCalls: string[] = []
    const verifyingSecrets = {
      signOperation: realSecrets.signOperation.bind(realSecrets),
      verifyOperation: async (token: string, expectedUserId: number) => {
        verificationCalls.push(token)
        const payload = await realSecrets.verifyOperation(token, expectedUserId)
        if (token === secondSigned.token && verificationCalls.filter((value) => value === token).length === 1) {
          secondVerifiedOutside.resolve()
        }
        return payload
      },
    }
    const users = new FakeUserClient()
    const admin = new FakeAdminClient()
    const service = new ConversionService(users, admin, verifyingSecrets, 24)
    const firstEntered = deferred()
    const firstRelease = deferred()
    admin.generateHooks.set(operationId, async () => {
      firstEntered.resolve()
      await firstRelease.promise
    })

    const first = service.execute(firstSigned.token, 'user-jwt', userId, undefined)
    await firstEntered.promise
    const second = service.execute(secondSigned.token, 'user-jwt', userId, undefined)
    const secondExpectation = expectAppError(() => second, 'OPERATION_TOKEN_EXPIRED')
    await secondVerifiedOutside.promise
    currentTime = new Date('2026-07-13T08:01:01.000Z')
    firstRelease.resolve()

    await first
    await secondExpectation
    expect(verificationCalls.filter((token) => token === secondSigned.token)).toHaveLength(2)
    expect(users.calls).toEqual(['user-jwt'])
    expect(admin.calls.some(([name, key]) => (
      name === 'generate' && key === secondOperationId
    ))).toBe(false)
  })

  it('rechecks redemption access after waiting for the per-user lock', async () => {
    const mutex = new ObservableKeyedMutex()
    const { service, users, admin, secrets } = setup(mutex)
    const firstEntered = deferred()
    const firstRelease = deferred()
    secrets.verifyOperation = async (token) => {
      if (token === 'second-token') {
        return { ...secrets.payload, operationId: secondOperationId }
      }
      return secrets.payload
    }
    admin.generateHooks.set(operationId, async () => {
      firstEntered.resolve()
      await firstRelease.promise
    })

    const first = service.execute('first-token', 'user-jwt', userId)
    await firstEntered.promise
    const second = service.execute('second-token', 'user-jwt', userId)
    const secondExpectation = expectAppError(() => second, 'REDEEM_ACCESS_DENIED')
    await mutex.secondQueued.promise
    users.profile = { ...users.profile, allowed_groups: [] }
    firstRelease.resolve()

    await expect(first).resolves.toMatchObject({
      status: 'completed',
      operation_id: operationId,
    })
    await secondExpectation
    expect(admin.calls).toEqual([
      ['generate', operationId, 10, 1],
      ['debit', userId, operationId, 10],
    ])
  })

  it('serializes different operations for the same user', async () => {
    const { service, admin, secrets } = setup()
    const firstEntered = deferred()
    const firstRelease = deferred()
    const secondVerified = deferred()
    const events: string[] = []
    secrets.verifyOperation = async (token) => {
      if (token === 'first-token') return secrets.payload
      secondVerified.resolve()
      return { ...secrets.payload, operationId: secondOperationId }
    }
    admin.generateHooks.set(operationId, async () => {
      events.push('first-entered')
      firstEntered.resolve()
      await firstRelease.promise
      events.push('first-released')
    })
    admin.generateHooks.set(secondOperationId, () => {
      events.push('second-entered')
    })

    const first = service.execute('first-token', userId)
    await firstEntered.promise
    const second = service.execute('second-token', userId)
    await secondVerified.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual(['first-entered'])

    firstRelease.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first-entered', 'first-released', 'second-entered'])
  })

  it('allows different users to execute concurrently', async () => {
    const { service, users, admin, secrets } = setup()
    const firstEntered = deferred()
    const firstRelease = deferred()
    const secondEntered = deferred()
    secrets.verifyOperation = async (token) => token === 'first-token'
      ? secrets.payload
      : { ...secrets.payload, operationId: secondOperationId, userId: 8 }
    users.getProfile = async (token) => ({
      ...users.profile,
      id: token === 'user-8-jwt' ? 8 : userId,
    })
    admin.generateHooks.set(operationId, async () => {
      firstEntered.resolve()
      await firstRelease.promise
    })
    admin.generateHooks.set(secondOperationId, () => {
      secondEntered.resolve()
    })

    const first = service.execute('first-token', userId)
    await firstEntered.promise
    const second = service.execute('second-token', 8)
    try {
      expect(await resolvesWithin(secondEntered.promise, 500)).toBe(true)
    } finally {
      firstRelease.resolve()
      await Promise.all([first, second])
    }
  })
})
