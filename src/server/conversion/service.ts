import { Decimal } from 'decimal.js'

import type { ExecuteResponse, PrepareResponse } from '../../shared/contracts.js'
import { amountToUpstreamNumber, normalizeAmount, parseAmount } from '../amount.js'
import { AppError } from '../errors.js'
import type { OperationPayload, SecretsService } from '../security/secrets.js'
import type { AdminClient } from '../sub2api/admin-client.js'
import { isUpstreamError, type UpstreamError } from '../sub2api/http.js'
import type { RedeemCode } from '../sub2api/types.js'
import type { UserClient } from '../sub2api/user-client.js'
import { KeyedMutex } from './keyed-mutex.js'

type OperationSecrets = Pick<SecretsService, 'signOperation' | 'verifyOperation'>

const uncertainKinds = new Set([
  'timeout',
  'network',
  'idempotency-in-progress',
  'idempotency-store-unavailable',
  'invalid-response',
])

function isUncertain(error: unknown): error is UpstreamError {
  if (!isUpstreamError(error)) return false
  if (error.kind === 'http') return error.status === undefined || error.status >= 500
  return uncertainKinds.has(error.kind)
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

function validateCode(code: RedeemCode, amount: Decimal): void {
  if (code.type !== 'balance' || !new Decimal(code.value).equals(amount)) {
    throw new AppError('UPSTREAM_DATA_CONFLICT', 502, '上游兑换码数据冲突')
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
  ): Promise<PrepareResponse> {
    const normalizedAmount = normalizeAmount(rawAmount)
    const amount = new Decimal(normalizedAmount)
    const profile = await this.#users.getProfile(userJwt)

    if (profile.id !== userId) {
      throw new AppError('SESSION_INVALID', 401, '会话用户不一致')
    }
    if (amount.gt(profile.balance)) {
      throw new AppError('AMOUNT_EXCEEDS_BALANCE', 409, '金额超过当前余额')
    }

    const signed = await this.#secrets.signOperation({
      operationId,
      userId,
      amount: normalizedAmount,
    })
    return {
      operation_token: signed.token,
      expires_at: signed.expiresAt,
      amount: normalizedAmount,
    }
  }

  async execute(operationToken: string, userId: number): Promise<ExecuteResponse> {
    const operation = await this.#secrets.verifyOperation(operationToken, userId)
    return this.#mutex.run(userId, () => this.#executeLocked(operation))
  }

  async #executeLocked(operation: OperationPayload): Promise<ExecuteResponse> {
    const amount = parseAmount(operation.amount)
    const upstreamAmount = amountToUpstreamNumber(amount)
    let generated: RedeemCode

    try {
      generated = await this.#admin.generateCode(operation.operationId, upstreamAmount)
    } catch (error) {
      if (isUncertain(error)) return pending(operation.operationId, error)
      throw upstreamFailure(error)
    }

    let stored: RedeemCode | null
    try {
      stored = await this.#admin.getCode(generated.id)
    } catch (error) {
      if (isUncertain(error)) return pending(operation.operationId, error)
      throw upstreamFailure(error)
    }
    if (stored === null) throw terminated()

    validateCode(stored, amount)

    try {
      await this.#admin.debitBalance(operation.userId, operation.operationId, upstreamAmount)
    } catch (error) {
      if (isUpstreamError(error, 'insufficient-balance')) {
        if (stored.status !== 'unused' || stored.used_by !== null) {
          return {
            status: 'pending',
            operation_id: operation.operationId,
            error: 'MANUAL_REVIEW_REQUIRED',
          }
        }
        return this.#compensate(operation.operationId, stored)
      }
      if (isUncertain(error)) return pending(operation.operationId, error)
      throw upstreamFailure(error)
    }

    return {
      status: 'completed',
      operation_id: operation.operationId,
      amount: operation.amount,
      code: stored.code,
      created_at: stored.created_at,
    }
  }

  async #compensate(operationId: string, code: RedeemCode): Promise<ExecuteResponse> {
    try {
      await this.#admin.deleteCode(code.id)
      throw terminated()
    } catch (error) {
      if (error instanceof AppError) throw error
      if (!isUncertain(error)) throw upstreamFailure(error)

      try {
        const remaining = await this.#admin.getCode(code.id)
        if (remaining === null) throw terminated()
      } catch (lookupError) {
        if (lookupError instanceof AppError) throw lookupError
        if (!isUncertain(lookupError)) throw upstreamFailure(lookupError)
      }

      return { status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING' }
    }
  }
}
