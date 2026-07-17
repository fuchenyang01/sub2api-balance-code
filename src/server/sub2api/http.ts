import { z, type ZodType } from 'zod'

export type UpstreamErrorKind =
  | 'auth'
  | 'not-found'
  | 'insufficient-balance'
  | 'idempotency-in-progress'
  | 'idempotency-store-unavailable'
  | 'timeout'
  | 'network'
  | 'invalid-response'
  | 'http'

interface UpstreamErrorOptions {
  status?: number
  reason?: string
  cause?: unknown
}

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind
  readonly status?: number
  readonly reason?: string

  constructor(kind: UpstreamErrorKind, message: string, options: UpstreamErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    Object.defineProperty(this, 'name', { value: 'UpstreamError', configurable: true })
    this.kind = kind
    if (options.status !== undefined) this.status = options.status
    if (options.reason !== undefined) this.reason = options.reason
  }
}

export function isUpstreamError(
  error: unknown,
  kind?: UpstreamErrorKind,
): error is UpstreamError {
  return error instanceof UpstreamError && (kind === undefined || error.kind === kind)
}

interface UpstreamRequestOptions<T> {
  url: string
  init?: RequestInit
  timeoutMs: number
  dataSchema: ZodType<T>
  fetchImpl?: typeof fetch
  sensitiveValues?: readonly string[]
}

const errorEnvelopeSchema = z.object({
  code: z.union([z.number(), z.string()]),
  message: z.string().optional(),
  reason: z.string().optional(),
  data: z.unknown().optional(),
})

const successEnvelopeSchema = errorEnvelopeSchema.extend({
  message: z.string(),
})

const MAX_UPSTREAM_TEXT_LENGTH = 1_024
const MAX_RESPONSE_BODY_BYTES = 64 * 1_024

function safeText(value: string, sensitiveValues: readonly string[]): string {
  let safe = value
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) safe = safe.split(sensitiveValue).join('[REDACTED]')
  }
  return safe.slice(0, MAX_UPSTREAM_TEXT_LENGTH)
}

async function readLimitedText(response: Response): Promise<string> {
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  let bytesRead = 0

  try {
    while (bytesRead < MAX_RESPONSE_BODY_BYTES) {
      const { done, value } = await reader.read()
      if (done) break

      const remaining = MAX_RESPONSE_BODY_BYTES - bytesRead
      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining)
      body += decoder.decode(chunk, { stream: true })
      bytesRead += chunk.byteLength

      if (chunk.byteLength < value.byteLength) {
        break
      }
    }
    if (bytesRead === MAX_RESPONSE_BODY_BYTES) await reader.cancel()
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function errorKind(status: number, reason: string | undefined, message: string): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not-found'
  if (reason === 'IDEMPOTENCY_IN_PROGRESS') return 'idempotency-in-progress'
  if (reason === 'IDEMPOTENCY_STORE_UNAVAILABLE') return 'idempotency-store-unavailable'
  if (
    reason === 'INSUFFICIENT_BALANCE' ||
    message.toLowerCase().includes('balance cannot be negative')
  ) {
    return 'insufficient-balance'
  }
  return 'http'
}

function invalidResponse(status: number, message: string): UpstreamError {
  return new UpstreamError('invalid-response', message, { status })
}

function transportFailure(error: unknown): UpstreamError {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new UpstreamError('timeout', 'Upstream request timed out', {
      cause: new Error('Upstream transport timeout'),
    })
  }
  return new UpstreamError('network', 'Upstream network request failed', {
    cause: new Error('Upstream transport failure'),
  })
}

export async function requestUpstream<T>(options: UpstreamRequestOptions<T>): Promise<T> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const sensitiveValues = options.sensitiveValues ?? []
  let response: Response

  try {
    response = await fetchImpl(options.url, {
      ...options.init,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    throw transportFailure(error)
  }

  let responseText: string
  try {
    responseText = await readLimitedText(response)
  } catch (error) {
    throw transportFailure(error)
  }

  const rawEnvelope = parseJson(responseText)
  const parsedErrorEnvelope = errorEnvelopeSchema.safeParse(rawEnvelope)
  if (!response.ok) {
    const envelope = parsedErrorEnvelope.success ? parsedErrorEnvelope.data : undefined
    const rawMessage = envelope?.message ?? 'Upstream HTTP request failed'
    const rawReason =
      envelope?.reason ?? (typeof envelope?.code === 'string' ? envelope.code : undefined)
    const message = safeText(rawMessage, sensitiveValues)
    const reason = rawReason === undefined ? undefined : safeText(rawReason, sensitiveValues)
    throw new UpstreamError(errorKind(response.status, rawReason, rawMessage), message, {
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  if (rawEnvelope === undefined) {
    throw invalidResponse(response.status, 'Upstream response was not valid JSON')
  }
  const parsedSuccessEnvelope = successEnvelopeSchema.safeParse(rawEnvelope)
  if (!parsedSuccessEnvelope.success) {
    throw invalidResponse(response.status, 'Upstream response envelope was invalid')
  }

  const envelope = parsedSuccessEnvelope.data
  if (envelope.code !== 0) {
    const message = safeText(
      envelope.message ?? 'Upstream success response had a nonzero code',
      sensitiveValues,
    )
    const reason =
      envelope.reason === undefined ? undefined : safeText(envelope.reason, sensitiveValues)
    throw new UpstreamError('invalid-response', message, {
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  const parsedData = options.dataSchema.safeParse(envelope.data)
  if (!parsedData.success) {
    throw invalidResponse(response.status, 'Upstream response data was invalid')
  }

  return parsedData.data
}
