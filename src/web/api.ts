import { Decimal } from 'decimal.js'
import { z } from 'zod'

import {
  MAX_BATCH_COUNT,
  MIN_BATCH_COUNT,
  errorCodes,
  type ErrorCode,
  type ExecuteRequest,
  type ExecuteResponse,
  type MeResponse,
  type PrepareRequest,
  type PrepareResponse,
  type PublicConfigResponse,
} from '../shared/contracts.js'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ConversionApi {
  config(): Promise<PublicConfigResponse>
  exchange(token: string): Promise<MeResponse>
  me(): Promise<MeResponse>
  logout(): Promise<void>
  prepare(request: PrepareRequest): Promise<PrepareResponse>
  execute(request: ExecuteRequest): Promise<ExecuteResponse>
}

const knownErrorCodes = new Set<string>(errorCodes)

const finitePlainDecimalSchema = z.string()
  .min(1)
  .max(1_024)
  .regex(/^-?\d+(?:\.\d+)?$/)
  .refine((value) => {
    try {
      return new Decimal(value).isFinite()
    } catch {
      return false
    }
  })

const amountSchema = finitePlainDecimalSchema.refine((value) => new Decimal(value).greaterThan(0))
const isoDateSchema = z.string().refine((value) => (
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && !Number.isNaN(Date.parse(value))
))
const completedTimeSchema = z.string().min(1).max(128)
const errorCodeSchema = z.enum(errorCodes)
const meResponseSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  balance: finitePlainDecimalSchema,
}).strict()
const publicConfigResponseSchema = z.object({
  sub2api_relogin_url: z.string().max(2_048).refine((value) => {
    try {
      const url = new URL(value)
      const redirect = url.searchParams.get('redirect')
      return ['http:', 'https:'].includes(url.protocol)
        && url.username === ''
        && url.password === ''
        && url.hash === ''
        && url.pathname === '/balance-code-relogin'
        && [...url.searchParams.keys()].length === 1
        && redirect !== null
        && /^\/custom\/[A-Za-z0-9_-]+$/.test(redirect)
    } catch {
      return false
    }
  }),
}).strict()
const prepareResponseSchema = z.object({
  operation_token: z.string().min(1),
  expires_at: isoDateSchema,
  amount: amountSchema,
  count: z.number().int().min(MIN_BATCH_COUNT).max(MAX_BATCH_COUNT),
  total_amount: amountSchema,
}).strict()
const completedCodeSchema = z.object({
  code: z.string().min(1),
  created_at: completedTimeSchema,
}).strict()
const completedResponseSchema = z.object({
    status: z.literal('completed'),
    operation_id: z.string().min(1),
    amount: amountSchema,
    count: z.number().int().min(MIN_BATCH_COUNT).max(MAX_BATCH_COUNT),
    total_amount: amountSchema,
    codes: z.array(completedCodeSchema).min(MIN_BATCH_COUNT).max(MAX_BATCH_COUNT),
  }).strict().refine((value) => {
    try {
      return value.codes.length === value.count
        && new Decimal(value.amount).mul(value.count).equals(value.total_amount)
    } catch {
      return false
    }
  })
const executeResponseSchema = z.union([
  completedResponseSchema,
  z.object({
    status: z.literal('pending'),
    operation_id: z.string().min(1),
    error: errorCodeSchema,
  }).strict(),
])

const safeMessages: Record<ErrorCode, string> = {
  SESSION_REQUIRED: '会话已失效',
  SESSION_INVALID: '会话已失效',
  SESSION_EXPIRED: '会话已失效',
  REDEEM_ACCESS_DENIED: '暂无余额兑换权限，请联系管理员',
  AMOUNT_INVALID: '请输入有效金额',
  AMOUNT_EXCEEDS_BALANCE: '兑换金额不能超过当前余额',
  OPERATION_TOKEN_INVALID: '操作已失效，请重新生成',
  OPERATION_TOKEN_EXPIRED: '操作已过期，请重新生成',
  OPERATION_TERMINATED: '本次操作已终止',
  CONVERSION_IN_PROGRESS: '兑换正在处理中',
  CONVERSION_PENDING: '兑换结果待确认',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  UPSTREAM_AUTH_FAILED: '服务认证失败，请联系管理员',
  UPSTREAM_IDEMPOTENCY_UNAVAILABLE: '兑换结果待确认',
  UPSTREAM_DATA_CONFLICT: '数据校验失败，请联系管理员',
  UPSTREAM_UNAVAILABLE: '服务暂时不可用',
  MANUAL_REVIEW_REQUIRED: '本次兑换需要人工确认',
}

export class ApiClientError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly requestId: string

  constructor(code: ErrorCode, status: number, requestId: string, message = safeMessages[code]) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseStableError(value: unknown): { code: ErrorCode; requestId: string } | null {
  if (!isRecord(value) || !isRecord(value.error)) return null
  const { code, message, request_id: requestId } = value.error
  if (
    typeof code !== 'string'
    || !knownErrorCodes.has(code)
    || typeof message !== 'string'
    || message.length === 0
    || message.length > 200
    || typeof requestId !== 'string'
    || requestId.length > 128
  ) return null
  return { code: code as ErrorCode, requestId }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

export function createApiClient(fetcher: Fetcher = globalThis.fetch.bind(globalThis)): ConversionApi {
  async function request<T>(
    path: string,
    method: 'GET' | 'POST',
    schema: z.ZodType<T> | null,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = { method, credentials: 'same-origin' }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }

    const response = await fetcher(path, init)
    if (response.status === 204) {
      if (schema === null) return undefined as T
      throw new ApiClientError('UPSTREAM_UNAVAILABLE', response.status, '')
    }
    const parsed = await parseJson(response)
    if (!response.ok) {
      const stable = parseStableError(parsed)
      if (stable !== null) {
        throw new ApiClientError(stable.code, response.status, stable.requestId)
      }
      throw new ApiClientError('UPSTREAM_UNAVAILABLE', response.status, '')
    }
    if (schema === null) throw new ApiClientError('UPSTREAM_UNAVAILABLE', response.status, '')

    const validated = schema.safeParse(parsed)
    if (!validated.success) throw new ApiClientError('UPSTREAM_UNAVAILABLE', response.status, '')
    return validated.data
  }

  return {
    config: () => request('/api/config', 'GET', publicConfigResponseSchema),
    exchange: (token) => request('/api/session/exchange', 'POST', meResponseSchema, { token }),
    me: () => request('/api/me', 'GET', meResponseSchema),
    logout: () => request<void>('/api/session/logout', 'POST', null),
    prepare: (body) => request('/api/conversions/prepare', 'POST', prepareResponseSchema, body),
    execute: (body) => request('/api/conversions/execute', 'POST', executeResponseSchema, body),
  }
}

export const apiClient = createApiClient()
