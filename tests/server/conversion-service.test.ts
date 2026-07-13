import { describe, expect, it } from 'vitest'

import { ConversionService } from '../../src/server/conversion/service.js'
import { AppError } from '../../src/server/errors.js'
import type { OperationPayload } from '../../src/server/security/secrets.js'
import type { AdminClient } from '../../src/server/sub2api/admin-client.js'
import { UpstreamError, type UpstreamErrorKind } from '../../src/server/sub2api/http.js'
import type { RedeemCode } from '../../src/server/sub2api/types.js'
import type { UserClient } from '../../src/server/sub2api/user-client.js'

const now = '2026-07-13T08:00:00.000Z'
const expiresAt = '2026-07-13T08:10:00.000Z'
const operationId = '11111111-1111-4111-8111-111111111111'
const secondOperationId = '22222222-2222-4222-8222-222222222222'
const userId = 7

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

function code(overrides: Partial<RedeemCode> = {}): RedeemCode {
  return {
    id: 91,
    code: 'CODE-1',
    type: 'balance',
    value: 10,
    status: 'unused',
    used_by: null,
    created_at: now,
    ...overrides,
  }
}

class FakeUserClient implements UserClient {
  profile = { id: userId, username: 'alice', balance: 100, status: 'active' }
  calls: string[] = []

  async getProfile(userJwt: string): Promise<typeof this.profile> {
    this.calls.push(userJwt)
    return this.profile
  }
}

class FakeSecrets {
  readonly signed: Array<{ operationId: string; userId: number; amount: string }> = []
  readonly verified: Array<[string, number]> = []
  payload: OperationPayload = {
    version: 1,
    operationId,
    userId,
    amount: '10',
    issuedAt: now,
    expiresAt,
  }

  async signOperation(input: {
    operationId: string
    userId: number
    amount: string
  }): Promise<{ token: string; expiresAt: string }> {
    this.signed.push(input)
    return { token: `token-${input.operationId}`, expiresAt }
  }

  async verifyOperation(token: string, expectedUserId: number): Promise<OperationPayload> {
    this.verified.push([token, expectedUserId])
    return this.payload
  }
}

type AdminCall =
  | ['generate', string, number]
  | ['getCode', number]
  | ['delete', number]
  | ['debit', number, string, number]

class FakeAdminClient implements AdminClient {
  calls: AdminCall[] = []
  generated = code()
  stored: RedeemCode | null = this.generated
  generationCache = new Map<string, RedeemCode>()
  generateHooks = new Map<string, () => void | Promise<void>>()
  generateError?: unknown
  getErrors: unknown[] = []
  deleteErrors: unknown[] = []
  debitErrors: unknown[] = []
  generateGate: Promise<void> | undefined
  debitHook: (() => void | Promise<void>) | undefined

  async generateCode(id: string, amount: number): Promise<RedeemCode> {
    this.calls.push(['generate', `code-${id}`, amount])
    await this.generateHooks.get(id)?.()
    if (this.generateGate !== undefined) await this.generateGate
    if (this.generateError !== undefined) throw this.generateError
    const replay = this.generationCache.get(id)
    if (replay !== undefined) return replay
    this.generationCache.set(id, this.generated)
    this.stored = this.generated
    return this.generated
  }

  async getCode(id: number): Promise<RedeemCode | null> {
    this.calls.push(['getCode', id])
    const error = this.getErrors.shift()
    if (error !== undefined) throw error
    return this.stored
  }

  async deleteCode(id: number): Promise<'deleted' | 'missing'> {
    this.calls.push(['delete', id])
    const error = this.deleteErrors.shift()
    if (error !== undefined) throw error
    if (this.stored === null) return 'missing'
    this.stored = null
    return 'deleted'
  }

  async debitBalance(id: number, opId: string, amount: number): Promise<void> {
    this.calls.push(['debit', id, `debit-${opId}`, amount])
    if (this.debitHook !== undefined) await this.debitHook()
    const error = this.debitErrors.shift()
    if (error !== undefined) throw error
  }
}

function upstream(kind: UpstreamErrorKind, status?: number): UpstreamError {
  return new UpstreamError(kind, `upstream ${kind}`, status === undefined ? {} : { status })
}

function setup(): {
  service: ConversionService
  users: FakeUserClient
  admin: FakeAdminClient
  secrets: FakeSecrets
} {
  const users = new FakeUserClient()
  const admin = new FakeAdminClient()
  const secrets = new FakeSecrets()
  return {
    service: new ConversionService(users, admin, secrets),
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
  it('normalizes the amount and signs the exact normalized string', async () => {
    const { service, secrets } = setup()

    await expect(service.prepare('user-jwt', userId, operationId, '0010.00000000')).resolves.toEqual({
      operation_token: `token-${operationId}`,
      expires_at: expiresAt,
      amount: '10',
    })
    expect(secrets.signed).toEqual([{ operationId, userId, amount: '10' }])
  })

  it('preserves a normalized plain decimal that Decimal.toString would exponentiate', async () => {
    const { service, users, secrets } = setup()
    users.profile = { ...users.profile, balance: 1e22 }
    const amount = '1000000000000000000000'

    await expect(service.prepare('user-jwt', userId, operationId, amount)).resolves.toMatchObject({
      amount,
    })
    expect(secrets.signed[0]?.amount).toBe(amount)
  })

  it('rejects a profile belonging to a different session user', async () => {
    const { service, users, secrets } = setup()
    users.profile = { ...users.profile, id: 8 }

    await expectAppError(() => service.prepare('user-jwt', userId, operationId, '10'), 'SESSION_INVALID')
    expect(secrets.signed).toEqual([])
  })

  it('rejects an amount above the live balance without generating a token', async () => {
    const { service, users, secrets } = setup()
    users.profile = { ...users.profile, balance: 9.99 }

    const error = await expectAppError(
      () => service.prepare('user-jwt', userId, operationId, '10'),
      'AMOUNT_EXCEEDS_BALANCE',
    )
    expect(error.status).toBe(409)
    expect(secrets.signed).toEqual([])
  })
})

describe('ConversionService.execute', () => {
  it('completes in generate, lookup, validate, debit order with stable idempotency keys', async () => {
    const { service, admin } = setup()

    const result = await service.execute('operation-token', userId)

    expect(admin.calls).toEqual([
      ['generate', `code-${operationId}`, 10],
      ['getCode', 91],
      ['debit', 7, `debit-${operationId}`, 10],
    ])
    expect(result).toEqual({
      status: 'completed',
      operation_id: operationId,
      amount: '10',
      code: 'CODE-1',
      created_at: now,
    })
  })

  it('replays generation and debit with the same keys even when the code is already used', async () => {
    const { service, admin } = setup()

    const first = await service.execute('operation-token', userId)
    admin.stored = code({ status: 'used', used_by: userId })
    const second = await service.execute('operation-token', userId)

    expect(second).toEqual(first)
    expect(admin.calls.filter(([name]) => name === 'generate')).toEqual([
      ['generate', `code-${operationId}`, 10],
      ['generate', `code-${operationId}`, 10],
    ])
    expect(admin.calls.filter(([name]) => name === 'debit')).toEqual([
      ['debit', userId, `debit-${operationId}`, 10],
      ['debit', userId, `debit-${operationId}`, 10],
    ])
  })

  it.each([
    ['auth', 'UPSTREAM_AUTH_FAILED'],
    ['not-found', 'UPSTREAM_UNAVAILABLE'],
  ] as const)('maps a definite %s generation failure and never debits', async (kind, errorCode) => {
    const { service, admin } = setup()
    admin.generateError = upstream(kind)

    await expectAppError(() => service.execute('operation-token', userId), errorCode)
    expect(admin.calls).toEqual([['generate', `code-${operationId}`, 10]])
  })

  it('returns pending for an HTTP 408 generation response', async () => {
    const { service, admin } = setup()
    admin.generateError = upstream('http', 408)

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'CONVERSION_PENDING',
    })
    expect(admin.calls).toEqual([['generate', `code-${operationId}`, 10]])
  })

  it('retries an uncertain generation with the same generation key', async () => {
    const { service, admin } = setup()
    admin.generateError = upstream('timeout')
    await service.execute('operation-token', userId)
    admin.generateError = undefined

    await expect(service.execute('operation-token', userId)).resolves.toMatchObject({ status: 'completed' })
    expect(admin.calls.filter(([name]) => name === 'generate')).toEqual([
      ['generate', `code-${operationId}`, 10],
      ['generate', `code-${operationId}`, 10],
    ])
  })

  it.each([
    ['timeout', 'CONVERSION_PENDING'],
    ['network', 'CONVERSION_PENDING'],
    ['idempotency-in-progress', 'CONVERSION_IN_PROGRESS'],
    ['idempotency-store-unavailable', 'UPSTREAM_IDEMPOTENCY_UNAVAILABLE'],
    ['http', 'CONVERSION_PENDING'],
    ['invalid-response', 'CONVERSION_PENDING'],
  ] as const)('returns pending for uncertain %s generation without deleting or debiting', async (kind, error) => {
    const { service, admin } = setup()
    admin.generateError = upstream(kind, kind === 'http' ? 500 : undefined)

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error,
    })
    expect(admin.calls).toEqual([['generate', `code-${operationId}`, 10]])
  })

  it('terminates without debiting when the generated code is missing on lookup', async () => {
    const { service, admin } = setup()
    admin.stored = null
    admin.generateCode = async (id, amount) => {
      admin.calls.push(['generate', `code-${id}`, amount])
      return admin.generated
    }

    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')
    expect(admin.calls).toEqual([
      ['generate', `code-${operationId}`, 10],
      ['getCode', 91],
    ])
  })

  it.each([
    ['wrong type', code({ type: 'quota' })],
    ['wrong amount', code({ value: 10.01 })],
  ])('rejects a code with %s as an upstream data conflict', async (_name, conflictingCode) => {
    const { service, admin } = setup()
    admin.generated = conflictingCode
    admin.stored = conflictingCode

    await expectAppError(() => service.execute('operation-token', userId), 'UPSTREAM_DATA_CONFLICT')
    expect(admin.calls.some(([name]) => name === 'debit')).toBe(false)
  })

  it('returns pending for an HTTP 408 code lookup response', async () => {
    const { service, admin } = setup()
    admin.getErrors.push(upstream('http', 408))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'CONVERSION_PENDING',
    })
    expect(admin.calls.some(([name]) => name === 'debit')).toBe(false)
  })

  it('retries a failed lookup by replaying generation before querying the same code', async () => {
    const { service, admin } = setup()
    admin.getErrors.push(upstream('timeout'))
    await service.execute('operation-token', userId)

    await expect(service.execute('operation-token', userId)).resolves.toMatchObject({ status: 'completed' })
    expect(admin.calls.filter(([name]) => name === 'generate')).toHaveLength(2)
    expect(admin.calls.filter(([name]) => name === 'getCode')).toEqual([
      ['getCode', 91],
      ['getCode', 91],
    ])
  })

  it.each([
    ['auth', 'UPSTREAM_AUTH_FAILED'],
    ['timeout', 'CONVERSION_PENDING'],
    ['invalid-response', 'CONVERSION_PENDING'],
  ] as const)('maps %s lookup failures without exposing or debiting the code', async (kind, expected) => {
    const { service, admin } = setup()
    admin.getErrors.push(upstream(kind))

    if (expected === 'UPSTREAM_AUTH_FAILED') {
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

  it('deletes an unpublished code and terminates on definite insufficient balance', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('insufficient-balance', 409))

    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')
    expect(admin.calls).toEqual([
      ['generate', `code-${operationId}`, 10],
      ['getCode', 91],
      ['debit', userId, `debit-${operationId}`, 10],
      ['getCode', 91],
      ['delete', 91],
    ])
  })

  it('treats an already missing code as successful compensation', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('insufficient-balance', 409))
    admin.deleteCode = async (id) => {
      admin.calls.push(['delete', id])
      return 'missing'
    }

    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')
    expect(admin.calls.filter(([name]) => name === 'getCode')).toHaveLength(2)
  })

  it('does not recreate a compensated code when generation is replayed with the same token', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('insufficient-balance', 409))

    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')
    expect(admin.stored).toBeNull()
    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')

    expect(admin.calls.filter(([name]) => name === 'generate')).toHaveLength(2)
    expect(admin.calls.filter(([name]) => name === 'debit')).toHaveLength(1)
    expect(admin.calls.filter(([name]) => name === 'delete')).toHaveLength(1)
  })

  it('never deletes an already used code when debit unexpectedly reports insufficient balance', async () => {
    const { service, admin } = setup()
    admin.generated = code({ status: 'used', used_by: userId })
    admin.debitErrors.push(upstream('insufficient-balance', 409))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'MANUAL_REVIEW_REQUIRED',
    })
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
    expect(admin.calls.filter(([name]) => name === 'getCode')).toHaveLength(2)
  })

  it('rechecks the code and does not delete when it becomes used during debit', async () => {
    const { service, admin } = setup()
    admin.debitHook = () => {
      admin.stored = code({ status: 'used', used_by: userId })
    }
    admin.debitErrors.push(upstream('insufficient-balance', 409))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'MANUAL_REVIEW_REQUIRED',
    })
    expect(admin.calls.filter(([name]) => name === 'getCode')).toHaveLength(2)
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
  })

  it.each([
    ['used with no user', code({ status: 'used', used_by: null })],
    ['unused with a user', code({ status: 'unused', used_by: userId })],
    ['unknown status', code({ status: 'suspended', used_by: null })],
  ])('requires manual review for latest code state %s', async (_name, latestCode) => {
    const { service, admin } = setup()
    admin.debitHook = () => {
      admin.stored = latestCode
    }
    admin.debitErrors.push(upstream('insufficient-balance', 409))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'MANUAL_REVIEW_REQUIRED',
    })
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
  })

  it('terminates without deletion when the compensation precheck finds the code missing', async () => {
    const { service, admin } = setup()
    admin.debitHook = () => {
      admin.stored = null
    }
    admin.debitErrors.push(upstream('insufficient-balance', 409))

    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')
    expect(admin.calls.filter(([name]) => name === 'getCode')).toHaveLength(2)
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
  })

  it.each([
    ['timeout', undefined, 'CONVERSION_PENDING'],
    ['network', undefined, 'CONVERSION_PENDING'],
    ['idempotency-in-progress', undefined, 'CONVERSION_IN_PROGRESS'],
    ['idempotency-store-unavailable', undefined, 'UPSTREAM_IDEMPOTENCY_UNAVAILABLE'],
    ['http', 408, 'CONVERSION_PENDING'],
    ['http', 500, 'CONVERSION_PENDING'],
    ['invalid-response', undefined, 'CONVERSION_PENDING'],
  ] as const)(
    'returns pending without deletion when compensation precheck fails with %s %s',
    async (kind, status, error) => {
      const { service, admin } = setup()
      admin.debitErrors.push(upstream('insufficient-balance', 409))
      admin.getErrors.push(undefined, upstream(kind, status))

      await expect(service.execute('operation-token', userId)).resolves.toEqual({
        status: 'pending',
        operation_id: operationId,
        error,
      })
      expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
    },
  )

  it.each([
    ['auth', undefined, 'UPSTREAM_AUTH_FAILED'],
    ['http', 400, 'UPSTREAM_UNAVAILABLE'],
  ] as const)(
    'maps definite compensation precheck failure %s %s without deletion',
    async (kind, status, errorCode) => {
      const { service, admin } = setup()
      admin.debitErrors.push(upstream('insufficient-balance', 409))
      admin.getErrors.push(undefined, upstream(kind, status))

      await expectAppError(() => service.execute('operation-token', userId), errorCode)
      expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
    },
  )

  it('returns pending without deletion for an HTTP 408 debit response', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('http', 408))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'CONVERSION_PENDING',
    })
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
  })

  it('terminates when deletion times out but a confirming lookup reports missing', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('insufficient-balance'))
    admin.deleteErrors.push(upstream('timeout'))
    admin.getCode = async (id) => {
      admin.calls.push(['getCode', id])
      return admin.calls.filter(([name]) => name === 'getCode').length <= 2 ? admin.stored : null
    }

    await expectAppError(() => service.execute('operation-token', userId), 'OPERATION_TERMINATED')
    expect(admin.calls.slice(-2)).toEqual([
      ['delete', 91],
      ['getCode', 91],
    ])
  })

  it.each([
    ['code still exists', undefined],
    ['confirmation is uncertain', upstream('network')],
  ])('returns pending when deletion is uncertain and %s', async (_name, queryError) => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('insufficient-balance'))
    admin.deleteErrors.push(upstream('timeout'))
    if (queryError !== undefined) admin.getErrors.push(undefined, undefined, queryError)

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'CONVERSION_PENDING',
    })
    expect(admin.calls.filter(([name]) => name === 'debit')).toHaveLength(1)
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(true)
  })

  it.each([
    ['timeout', 'CONVERSION_PENDING'],
    ['network', 'CONVERSION_PENDING'],
    ['idempotency-in-progress', 'CONVERSION_IN_PROGRESS'],
    ['idempotency-store-unavailable', 'UPSTREAM_IDEMPOTENCY_UNAVAILABLE'],
    ['http', 'CONVERSION_PENDING'],
    ['invalid-response', 'CONVERSION_PENDING'],
  ] as const)('returns pending and never deletes after uncertain %s debit', async (kind, error) => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream(kind, kind === 'http' ? 500 : undefined))

    await expect(service.execute('operation-token', userId)).resolves.toEqual({
      status: 'pending',
      operation_id: operationId,
      error,
    })
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
  })

  it('maps a definite debit request error without deleting or exposing the code', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('http', 400))

    await expectAppError(() => service.execute('operation-token', userId), 'UPSTREAM_UNAVAILABLE')
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
  })

  it('retries an uncertain debit with the same debit key without deleting the code', async () => {
    const { service, admin } = setup()
    admin.debitErrors.push(upstream('timeout'))
    await service.execute('operation-token', userId)

    await expect(service.execute('operation-token', userId)).resolves.toMatchObject({ status: 'completed' })
    expect(admin.calls.filter(([name]) => name === 'debit')).toEqual([
      ['debit', userId, `debit-${operationId}`, 10],
      ['debit', userId, `debit-${operationId}`, 10],
    ])
    expect(admin.calls.some(([name]) => name === 'delete')).toBe(false)
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

  it('rejects a token amount that cannot be converted exactly before calling admin APIs', async () => {
    const { service, secrets, admin } = setup()
    secrets.payload = { ...secrets.payload, amount: '9007199254740993' }

    await expectAppError(() => service.execute('operation-token', userId), 'AMOUNT_INVALID')
    expect(admin.calls).toEqual([])
  })

  it('serializes different operations for the same user until the first releases the lock', async () => {
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

  it('allows different users with different operations to execute concurrently', async () => {
    const { service, admin, secrets } = setup()
    const firstEntered = deferred()
    const firstRelease = deferred()
    const secondEntered = deferred()
    secrets.verifyOperation = async (token) =>
      token === 'first-token'
        ? secrets.payload
        : { ...secrets.payload, operationId: secondOperationId, userId: 8 }
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
    await secondEntered.promise

    firstRelease.resolve()
    await Promise.all([first, second])
  })
})
