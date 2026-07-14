import { Decimal } from 'decimal.js'

import {
  MAX_BATCH_COUNT,
  MIN_BATCH_COUNT,
  type ExecuteResponse,
  type PrepareResponse,
} from '../../shared/contracts.js'
import { amountToUpstreamNumber, normalizeAmount, parseAmount } from '../amount.js'
import { AppError } from '../errors.js'
import type { OperationPayload, SecretsService } from '../security/secrets.js'
import type { AdminClient } from '../sub2api/admin-client.js'
import {
  isUpstreamError,
  type UpstreamError,
  type UpstreamErrorKind,
} from '../sub2api/http.js'
import type { RedeemCode } from '../sub2api/types.js'
import type { UserClient } from '../sub2api/user-client.js'
import { KeyedMutex } from './keyed-mutex.js'

type OperationSecrets = Pick<SecretsService, 'signOperation' | 'verifyOperation'>

function isUncertain(error: unknown): error is UpstreamError {
  if (!isUpstreamError(error)) return false
  const kind: UpstreamErrorKind = error.kind
  switch (kind) {
    case 'timeout':
    case 'network':
    case 'idempotency-in-progress':
    case 'idempotency-store-unavailable':
    case 'invalid-response':
      return true
    case 'http':
      return error.status === undefined || error.status === 408 || error.status >= 500
    case 'auth':
    case 'not-found':
    case 'insufficient-balance':
      return false
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

function pending(operationId: string, error: UpstreamError): ExecuteResponse {
  const code =
    error.kind === 'idempotency-in-progress'
      ? 'CONVERSION_IN_PROGRESS'
      : error.kind === 'idempotency-store-unavailable'
        ? 'UPSTREAM_IDEMPOTENCY_UNAVAILABLE'
        : 'CONVERSION_PENDING'
  return { status: 'pending', operation_id: operationId, error: code }
}

function upstreamFailure(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (isUpstreamError(error, 'auth')) {
    return new AppError('UPSTREAM_AUTH_FAILED', 502, '上游管理员鉴权失败')
  }
  return new AppError('UPSTREAM_UNAVAILABLE', 502, '上游服务不可用')
}

function terminated(): AppError {
  return new AppError('OPERATION_TERMINATED', 409, '操作已终止')
}

function executionProfileFailure(error: unknown): AppError {
  if (isUpstreamError(error, 'auth')) {
    return new AppError('SESSION_EXPIRED', 401, '会话已过期')
  }
  return new AppError('UPSTREAM_UNAVAILABLE', 502, '上游服务不可用')
}

function validBatchCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= MIN_BATCH_COUNT && count <= MAX_BATCH_COUNT
}

function isValidGeneratedBatch(
  codes: RedeemCode[],
  amount: Decimal,
  expectedCount: number,
): boolean {
  if (codes.length !== expectedCount) return false

  const ids = new Set<number>()
  const values = new Set<string>()
  try {
    for (const code of codes) {
      if (code.type !== 'balance' || !new Decimal(code.value).equals(amount)) return false
      if (ids.has(code.id) || values.has(code.code)) return false
      ids.add(code.id)
      values.add(code.code)
    }
    return true
  } catch {
    return false
  }
}

function manualReview(operationId: string): ExecuteResponse {
  return {
    status: 'pending',
    operation_id: operationId,
    error: 'MANUAL_REVIEW_REQUIRED',
  }
}

export class ConversionService {
  readonly #users: UserClient
  readonly #admin: AdminClient
  readonly #secrets: OperationSecrets
  readonly #mutex: KeyedMutex<number>

  constructor(
    users: UserClient,
    admin: AdminClient,
    secrets: OperationSecrets,
    mutex: KeyedMutex<number> = new KeyedMutex<number>(),
  ) {
    this.#users = users
    this.#admin = admin
    this.#secrets = secrets
    this.#mutex = mutex
  }

  async prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
  ): Promise<PrepareResponse> {
    if (!validBatchCount(count)) {
      throw new AppError('AMOUNT_INVALID', 400, '数量格式无效')
    }
    const normalizedAmount = normalizeAmount(rawAmount)
    const amount = new Decimal(normalizedAmount)
    const totalAmount = amount.mul(count)
    const profile = await this.#users.getProfile(userJwt)

    if (profile.id !== userId) {
      throw new AppError('SESSION_INVALID', 401, '会话用户不一致')
    }
    if (totalAmount.gt(profile.balance)) {
      throw new AppError('AMOUNT_EXCEEDS_BALANCE', 409, '金额超过当前余额')
    }

    const signed = await this.#secrets.signOperation({
      operationId,
      userId,
      amount: normalizedAmount,
      count,
    })
    return {
      operation_token: signed.token,
      expires_at: signed.expiresAt,
      amount: normalizedAmount,
      count,
      total_amount: totalAmount.toFixed(),
    }
  }

  async execute(
    operationToken: string,
    userJwt: string,
    userId: number,
  ): Promise<ExecuteResponse> {
    await this.#secrets.verifyOperation(operationToken, userId)
    return this.#mutex.run(userId, async () => {
      const operation = await this.#secrets.verifyOperation(operationToken, userId)
      return this.#executeLocked(operation, userJwt)
    })
  }

  async #executeLocked(operation: OperationPayload, userJwt: string): Promise<ExecuteResponse> {
    if (!validBatchCount(operation.count)) {
      throw new AppError('OPERATION_TOKEN_INVALID', 401, '操作令牌无效')
    }
    const amount = parseAmount(operation.amount)
    const totalAmount = amount.mul(operation.count)
    const upstreamAmount = amountToUpstreamNumber(amount)
    const upstreamTotal = amountToUpstreamNumber(totalAmount)
    let profile: Awaited<ReturnType<UserClient['getProfile']>>

    try {
      profile = await this.#users.getProfile(userJwt)
    } catch (error) {
      throw executionProfileFailure(error)
    }
    if (profile.id !== operation.userId) {
      throw new AppError('SESSION_INVALID', 401, '会话用户不一致')
    }

    let generated: RedeemCode[]

    try {
      generated = await this.#admin.generateCodes(
        operation.operationId,
        upstreamAmount,
        operation.count,
      )
    } catch (error) {
      if (isUncertain(error)) return pending(operation.operationId, error)
      throw upstreamFailure(error)
    }

    if (!isValidGeneratedBatch(generated, amount, operation.count)) {
      return manualReview(operation.operationId)
    }

    try {
      await this.#admin.debitBalance(operation.userId, operation.operationId, upstreamTotal)
    } catch (error) {
      if (isUpstreamError(error, 'insufficient-balance')) {
        return this.#compensate(operation.operationId, generated)
      }
      if (isUncertain(error)) return pending(operation.operationId, error)
      throw upstreamFailure(error)
    }

    return {
      status: 'completed',
      operation_id: operation.operationId,
      amount: operation.amount,
      count: operation.count,
      total_amount: totalAmount.toFixed(),
      codes: generated.map(({ code, created_at }) => ({ code, created_at })),
    }
  }

  async #compensate(
    operationId: string,
    generated: RedeemCode[],
  ): Promise<ExecuteResponse> {
    let deleted: number
    try {
      deleted = await this.#admin.batchDeleteCodes(generated.map(({ id }) => id))
    } catch (error) {
      if (isUncertain(error)) return pending(operationId, error)
      throw upstreamFailure(error)
    }

    if (deleted === generated.length) throw terminated()
    return manualReview(operationId)
  }
}
