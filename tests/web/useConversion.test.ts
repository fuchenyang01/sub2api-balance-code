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

  it('cleans a transiently failing URL token and retries the same in-memory token on refresh', async () => {
    history.replaceState(
      null,
      '',
      '/?token=jwt-retry-secret&user_id=99&theme=dark&source=portal',
    )
    const exchange = vi.fn()
      .mockRejectedValueOnce(
        new ApiClientError('UPSTREAM_UNAVAILABLE', 503, 'request-503', '服务暂时不可用'),
      )
      .mockResolvedValueOnce(profile)
    const me = vi.fn().mockResolvedValue(profile)
    const conversion = createUseConversion(api({ exchange, me }))

    await conversion.initialize()

    expect(location.search).toBe('?theme=dark&source=portal')
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(me).not.toHaveBeenCalled()
    expect(conversion.session.value).toBe('error')

    await conversion.refresh()

    expect(exchange).toHaveBeenCalledTimes(2)
    expect(exchange).toHaveBeenLastCalledWith('jwt-retry-secret')
    expect(me).toHaveBeenCalledTimes(1)
    expect(vi.mocked(exchange).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(me).mock.invocationCallOrder[0] ?? 0,
    )
    expect(conversion.session.value).toBe('authenticated')
    expect(conversion.profile.value).toEqual(profile)
  })

  it('removes empty token and user_id parameters before using the cookie session', async () => {
    history.replaceState(null, '', '/?token=&user_id=&theme=light&source=portal')
    const client = api()
    const conversion = createUseConversion(client)

    await conversion.initialize()

    expect(location.search).toBe('?theme=light&source=portal')
    expect(client.exchange).not.toHaveBeenCalled()
    expect(client.me).toHaveBeenCalledTimes(1)
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
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret',
        expires_at: '2026-07-13T01:00:00.000Z',
        amount: '2.0',
      }),
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

  it('does not execute when prepare returns a different decimal amount', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const execute = vi.fn()
    const client = api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret',
        expires_at: '2026-07-13T01:00:00.000Z',
        amount: '2',
      }),
      execute,
    })
    const conversion = createUseConversion(client)

    await conversion.convert('1.00000000')

    expect(execute).not.toHaveBeenCalled()
    expect(conversion.result.value).toBeNull()
    expect(conversion.pending.value).toBeNull()
    expect(conversion.error.value).toMatchObject({ code: 'UPSTREAM_DATA_CONFLICT' })
  })

  it.each([
    [
      'completed operation_id',
      {
        status: 'completed' as const,
        operation_id: 'different-operation',
        amount: '1',
        code: 'MUST-NOT-DISPLAY',
        created_at: '2026-07-13T00:00:00.000Z',
      },
    ],
    [
      'completed amount',
      {
        status: 'completed' as const,
        operation_id: operationId,
        amount: '2',
        code: 'MUST-NOT-DISPLAY',
        created_at: '2026-07-13T00:00:00.000Z',
      },
    ],
    [
      'pending operation_id',
      {
        status: 'pending' as const,
        operation_id: 'different-operation',
        error: 'CONVERSION_PENDING' as const,
      },
    ],
  ])('rejects a mismatched %s without publishing result state', async (_name, response) => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const client = api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret',
        expires_at: '2026-07-13T01:00:00.000Z',
        amount: '1.0',
      }),
      execute: vi.fn().mockResolvedValue(response),
    })
    const conversion = createUseConversion(client)

    await conversion.convert('1.00000000')

    expect(conversion.result.value).toBeNull()
    expect(conversion.pending.value).toBeNull()
    expect(conversion.error.value).toMatchObject({ code: 'UPSTREAM_DATA_CONFLICT' })
    expect(JSON.stringify(conversion.error.value)).not.toContain('MUST-NOT-DISPLAY')
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

  it.each([
    [
      'malformed me',
      new Response(JSON.stringify({ id: 0, username: 'alice', balance: '1' }), { status: 200 }),
      (client: ConversionApi) => client.me(),
    ],
    [
      'prepare 204',
      new Response(null, { status: 204 }),
      (client: ConversionApi) => client.prepare({ operation_id: operationId, amount: '1' }),
    ],
    [
      'completed execution without code',
      new Response(JSON.stringify({
        status: 'completed', operation_id: operationId, amount: '1',
        created_at: '2026-07-13T00:00:00.000Z',
      }), { status: 200 }),
      (client: ConversionApi) => client.execute({ operation_token: 'operation-secret' }),
    ],
    [
      'pending execution carrying a code',
      new Response(JSON.stringify({
        status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING',
        code: 'MUST-NOT-BE-RETAINED',
      }), { status: 202 }),
      (client: ConversionApi) => client.execute({ operation_token: 'operation-secret' }),
    ],
    [
      'logout 200 response',
      new Response(JSON.stringify({ unexpected: 'RAW-RESPONSE' }), { status: 200 }),
      (client: ConversionApi) => client.logout(),
    ],
  ] as const)('rejects a successful %s response with a safe typed error', async (_name, response, invoke) => {
    const client = createApiClient(vi.fn().mockResolvedValue(response))

    const error = await invoke(client).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiClientError)
    expect(error).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE', status: response.status, requestId: '', message: '服务暂时不可用',
    })
    expect((error as Error).message).not.toMatch(/MUST-NOT-BE-RETAINED|RAW-RESPONSE/)
  })

  it('accepts a finite negative plain-decimal balance from the profile contract', async () => {
    const client = createApiClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 7, username: 'alice', balance: '-1',
    }), { status: 200 })))

    await expect(client.me()).resolves.toEqual({ id: 7, username: 'alice', balance: '-1' })
  })

  it('keeps a completed code when created_at is a bounded non-ISO service string', async () => {
    const completed = {
      status: 'completed' as const,
      operation_id: operationId,
      amount: '1',
      code: 'CODE-123',
      created_at: '2026-07-13 00:00:00',
    }
    const client = createApiClient(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(completed), { status: 200 }),
    ))

    await expect(client.execute({ operation_token: 'operation-secret' })).resolves.toEqual(completed)
  })

  it.each([
    ['NaN', { id: 7, username: 'alice', balance: 'NaN' }],
    ['Infinity', { id: 7, username: 'alice', balance: 'Infinity' }],
    ['exponent', { id: 7, username: 'alice', balance: '1e2' }],
    ['empty', { id: 7, username: 'alice', balance: '' }],
    ['missing', { id: 7, username: 'alice' }],
    ['too long', { id: 7, username: 'alice', balance: '9'.repeat(1_025) }],
  ])('rejects a %s profile balance safely', async (_name, body) => {
    const client = createApiClient(vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    ))

    const error = await client.me().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 200, requestId: '' })
  })

  it.each(['', 'x'.repeat(129)])('rejects an empty or unbounded completed timestamp safely', async (createdAt) => {
    const client = createApiClient(vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', operation_id: operationId, amount: '1', code: 'CODE-123',
      created_at: createdAt,
    }), { status: 200 })))

    const error = await client.execute({ operation_token: 'operation-secret' }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 200, requestId: '' })
  })
})
