import { z } from 'zod'

import { MAX_BATCH_COUNT } from '../../shared/contracts.js'
import { isUpstreamError, requestUpstream, UpstreamError } from './http.js'
import { redeemCodeSchema, type RedeemCode } from './types.js'

export interface AdminClient {
  generateCodes(operationId: string, amount: number, count: number): Promise<RedeemCode[]>
  batchDeleteCodes(ids: number[]): Promise<number>
  getCode(id: number): Promise<RedeemCode | null>
  deleteCode(id: number): Promise<'deleted' | 'missing'>
  debitBalance(userId: number, operationId: string, amount: number): Promise<void>
}

const generatedCodesSchema = z.array(redeemCodeSchema).min(1).max(MAX_BATCH_COUNT)
const batchDeleteResultSchema = z.object({ deleted: z.number().int().nonnegative() }).strict()
const emptyDataSchema = z.object({})

export class Sub2ApiAdminClient implements AdminClient {
  readonly #baseUrl: string
  readonly #adminApiKey: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch

  constructor(
    baseUrl: string,
    adminApiKey: string,
    timeoutMs: number,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#adminApiKey = adminApiKey
    this.#timeoutMs = timeoutMs
    this.#fetchImpl = fetchImpl
  }

  async generateCodes(operationId: string, amount: number, count: number): Promise<RedeemCode[]> {
    const codes = await this.#request('/api/v1/admin/redeem-codes/generate', generatedCodesSchema, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `code-${operationId}`,
      },
      body: JSON.stringify({ count, type: 'balance', value: amount }),
    })
    if (codes.length !== count) {
      throw new UpstreamError('invalid-response', 'generated code count mismatch')
    }
    return codes
  }

  async batchDeleteCodes(ids: number[]): Promise<number> {
    const result = await this.#request(
      '/api/v1/admin/redeem-codes/batch-delete',
      batchDeleteResultSchema,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      },
    )
    return result.deleted
  }

  async getCode(id: number): Promise<RedeemCode | null> {
    try {
      return await this.#request(`/api/v1/admin/redeem-codes/${id}`, redeemCodeSchema)
    } catch (error) {
      if (isUpstreamError(error, 'not-found')) return null
      throw error
    }
  }

  async deleteCode(id: number): Promise<'deleted' | 'missing'> {
    try {
      await this.#request(`/api/v1/admin/redeem-codes/${id}`, emptyDataSchema, {
        method: 'DELETE',
      })
      return 'deleted'
    } catch (error) {
      if (isUpstreamError(error, 'not-found')) return 'missing'
      throw error
    }
  }

  async debitBalance(userId: number, operationId: string, amount: number): Promise<void> {
    await this.#request(`/api/v1/admin/users/${userId}/balance`, emptyDataSchema, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `debit-${operationId}`,
      },
      body: JSON.stringify({
        balance: amount,
        operation: 'subtract',
        notes: `balance-to-code:${operationId}`,
      }),
    })
  }

  #request<T>(path: string, dataSchema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    return requestUpstream({
      url: `${this.#baseUrl}${path}`,
      init: {
        ...init,
        headers: {
          'x-api-key': this.#adminApiKey,
          ...init.headers,
        },
      },
      timeoutMs: this.#timeoutMs,
      dataSchema,
      fetchImpl: this.#fetchImpl,
      sensitiveValues: [this.#adminApiKey],
    })
  }
}
