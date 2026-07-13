import {
  errorCodes,
  type ErrorCode,
  type ExecuteRequest,
  type ExecuteResponse,
  type MeResponse,
  type PrepareRequest,
  type PrepareResponse,
} from '../shared/contracts.js'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ConversionApi {
  exchange(token: string): Promise<MeResponse>
  me(): Promise<MeResponse>
  logout(): Promise<void>
  prepare(request: PrepareRequest): Promise<PrepareResponse>
  execute(request: ExecuteRequest): Promise<ExecuteResponse>
}

const knownErrorCodes = new Set<string>(errorCodes)

const safeMessages: Record<ErrorCode, string> = {
  SESSION_REQUIRED: '会话已失效',
  SESSION_INVALID: '会话已失效',
  SESSION_EXPIRED: '会话已失效',
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
  async function request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'same-origin' }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }

    const response = await fetcher(path, init)
    if (response.status === 204) return undefined as T
    const parsed = await parseJson(response)
    if (response.ok) return parsed as T

    const stable = parseStableError(parsed)
    if (stable !== null) {
      throw new ApiClientError(stable.code, response.status, stable.requestId)
    }
    throw new ApiClientError('UPSTREAM_UNAVAILABLE', response.status, '')
  }

  return {
    exchange: (token) => request('/api/session/exchange', 'POST', { token }),
    me: () => request('/api/me', 'GET'),
    logout: () => request('/api/session/logout', 'POST'),
    prepare: (body) => request('/api/conversions/prepare', 'POST', body),
    execute: (body) => request('/api/conversions/execute', 'POST', body),
  }
}

export const apiClient = createApiClient()
