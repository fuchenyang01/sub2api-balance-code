// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversionApi } from '../../src/web/api.js'
import { ApiClientError, createApiClient } from '../../src/web/api.js'
import { createUseConversion } from '../../src/web/composables/useConversion.js'

const profile = { id: 7, username: 'alice', balance: '12.50000000' }
const operationId = '123e4567-e89b-42d3-a456-426614174000'

function api(overrides: Partial<ConversionApi> = {}): ConversionApi {
  return {
    exchange: vi.fn().mockResolvedValue(profile),
    me: vi.fn().mockResolvedValue(profile),
    logout: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn().mockResolvedValue({
      operation_token: 'operation-secret',
      expires_at: '2026-07-13T01:00:00.000Z',
      amount: '1.25',
    }),
    execute: vi.fn().mockResolvedValue({
      status: 'completed',
      operation_id: operationId,
      amount: '1.25',
      code: 'CODE-123',
      created_at: '2026-07-13T00:00:00.000Z',
    }),
    ...overrides,
  }
}

describe('useConversion initialization', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-ui-mode')
    document.documentElement.lang = ''
    history.replaceState(null, '', '/')
  })

  it('exchanges a URL token once, removes sensitive query data, preserves safe data, then loads live profile', async () => {
    history.replaceState(
      null,
      '',
      '/?token=jwt-secret&user_id=99&theme=dark&lang=zh-CN&ui_mode=compact&source=portal',
    )
    const client = api()
    const conversion = createUseConversion(client)

    await Promise.all([conversion.initialize(), conversion.initialize()])
    await conversion.initialize()

    expect(client.exchange).toHaveBeenCalledTimes(1)
    expect(client.exchange).toHaveBeenCalledWith('jwt-secret')
    expect(client.me).toHaveBeenCalledTimes(1)
    expect(vi.mocked(client.exchange).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.me).mock.invocationCallOrder[0] ?? 0,
    )
    expect(location.search).toBe('?theme=dark&lang=zh-CN&ui_mode=compact&source=portal')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.uiMode).toBe('compact')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(conversion.profile.value).toEqual(profile)
    expect(conversion.session.value).toBe('authenticated')
  })

  it('uses the cookie session without exchanging when no token is present', async () => {
    history.replaceState(null, '', '/?theme=light&lang=en-US&ui_mode=iframe')
    const client = api()
    const conversion = createUseConversion(client)

    await conversion.initialize()

    expect(client.exchange).not.toHaveBeenCalled()
    expect(client.me).toHaveBeenCalledTimes(1)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.uiMode).toBe('iframe')
    expect(document.documentElement.lang).toBe('en-US')
  })

  it.each(['SESSION_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED'] as const)(
    'surfaces %s as an expired session without exposing unsafe detail',
    async (code) => {
      const client = api({
        me: vi.fn().mockRejectedValue(new ApiClientError(code, 401, 'request-1', '会话已失效')),
      })
      const conversion = createUseConversion(client)

      await conversion.initialize()

      expect(conversion.session.value).toBe('expired')
      expect(conversion.error.value).toMatchObject({ code, message: '会话已失效' })
    },
  )

  it('keeps a transient initialization failure distinct from an expired session', async () => {
    const client = api({
      me: vi.fn().mockRejectedValue(
        new ApiClientError('UPSTREAM_UNAVAILABLE', 503, 'request-2', '服务暂时不可用'),
      ),
    })
    const conversion = createUseConversion(client)

    await conversion.initialize()

    expect(conversion.session.value).toBe('error')
    expect(conversion.error.value).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE', message: '服务暂时不可用', retryable: true,
    })
  })
})

describe('useConversion conversion', () => {
  afterEach(() => vi.restoreAllMocks())

  it('creates an operation UUID only after confirmation, prepares, executes, and saves completion', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      calls.push('uuid')
      return operationId
    })
    const client = api({
      prepare: vi.fn().mockImplementation(async (request) => {
        calls.push(`prepare:${request.operation_id}:${request.amount}`)
        return {
          operation_token: 'operation-secret',
          expires_at: '2026-07-13T01:00:00.000Z',
          amount: request.amount,
        }
      }),
      execute: vi.fn().mockImplementation(async (request) => {
        calls.push(`execute:${request.operation_token}`)
        return {
          status: 'completed',
          operation_id: operationId,
          amount: '1.25',
          code: 'CODE-123',
          created_at: '2026-07-13T00:00:00.000Z',
        }
      }),
    })
    const conversion = createUseConversion(client)

    await conversion.convert('001.25000000')

    expect(calls).toEqual([
      'uuid',
      `prepare:${operationId}:1.25`,
      'execute:operation-secret',
    ])
    expect(conversion.result.value).toMatchObject({ status: 'completed', code: 'CODE-123' })
    expect(conversion.pending.value).toBeNull()
  })

  it('stores a pending response without a code and does not expose a previous completion', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const client = api({
      execute: vi.fn().mockResolvedValue({
        status: 'pending',
        operation_id: operationId,
        error: 'CONVERSION_PENDING',
      }),
    })
    const conversion = createUseConversion(client)

    await conversion.convert('2.00000000')

    expect(conversion.pending.value).toEqual({
      status: 'pending',
      operation_id: operationId,
      error: 'CONVERSION_PENDING',
    })
    expect(conversion.pending.value).not.toHaveProperty('code')
    expect(conversion.result.value).toBeNull()
  })

  it('keeps existing state and marks rate limiting as retryable', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const client = api({
      prepare: vi.fn().mockRejectedValue(
        new ApiClientError('RATE_LIMITED', 429, 'request-rate', '请求过于频繁'),
      ),
    })
    const conversion = createUseConversion(client)
    conversion.pending.value = {
      status: 'pending',
      operation_id: 'existing-operation',
      error: 'CONVERSION_PENDING',
    }

    await conversion.convert('1')

    expect(conversion.pending.value?.operation_id).toBe('existing-operation')
    expect(conversion.error.value).toMatchObject({
      code: 'RATE_LIMITED',
      message: '请求过于频繁',
      retryable: true,
    })
  })
})

describe('API client', () => {
  it('uses same-origin credentials and JSON bodies for all requests', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(profile), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(profile), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        operation_token: 'operation-secret',
        expires_at: '2026-07-13T01:00:00.000Z',
        amount: '1',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING',
      }), { status: 202 }))
    const client = createApiClient(fetcher)

    await client.exchange('jwt-secret')
    await client.me()
    await client.logout()
    await client.prepare({ operation_id: operationId, amount: '1' })
    await client.execute({ operation_token: 'operation-secret' })

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/session/exchange',
      '/api/me',
      '/api/session/logout',
      '/api/conversions/prepare',
      '/api/conversions/execute',
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(init.credentials).toBe('same-origin')
      if (init.body !== undefined) {
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
      }
    }
  })

  it.each([
    ['not json', 'RAW-SECRET-CODE'],
    ['unknown json', JSON.stringify({ detail: 'RAW-SECRET-JWT' })],
  ])('returns a typed safe error for %s without reflecting the response body', async (_name, body) => {
    const client = createApiClient(vi.fn().mockResolvedValue(
      new Response(body, { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    ))

    const error = await client.me().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiClientError)
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 500, requestId: '' })
    expect((error as Error).message).toBe('服务暂时不可用')
    expect((error as Error).message).not.toContain(body)
  })

  it('maps a stable API error code to local copy without retaining response messages', async () => {
    const client = createApiClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'RATE_LIMITED', message: 'Too many requests from upstream', request_id: 'request-7' },
      leaked: 'RAW-SECRET',
    }), { status: 429, headers: { 'Content-Type': 'application/json' } })))

    const error = await client.me().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiClientError)
    expect(error).toMatchObject({
      code: 'RATE_LIMITED', status: 429, requestId: 'request-7', message: '请求过于频繁，请稍后重试',
    })
    expect((error as Error).message).not.toContain('Too many requests from upstream')
    expect(error).not.toHaveProperty('leaked')
  })
})
