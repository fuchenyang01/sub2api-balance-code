// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversionApi } from '../../src/web/api.js'
import { ApiClientError, createApiClient } from '../../src/web/api.js'
import { createUseConversion } from '../../src/web/composables/useConversion.js'
import type { ConversionCoordinator } from '../../src/web/coordinator.js'
import { browserStorage, loadHistory, type ConversionStorage } from '../../src/web/storage.js'
import type { HistoryItem, PendingOperation } from '../../src/shared/storage-types.js'

const profile = { id: 7, username: 'alice', balance: '12.50000000' }
const operationId = '123e4567-e89b-42d3-a456-426614174000'
const createdAt = '2026-07-14T00:00:00.000Z'
const expiresAt = '2099-07-13T01:00:00.000Z'

function batchCodes(count: number): Array<{ code: string; created_at: string }> {
  return Array.from({ length: count }, (_, index) => ({
    code: `CODE-${index + 1}`,
    created_at: createdAt,
  }))
}

function completedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'completed',
    operation_id: operationId,
    amount: '2.5',
    count: 2,
    total_amount: '5',
    codes: batchCodes(2),
    ...overrides,
  }
}

function fetchResponse(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn().mockImplementation(async (_name, _options, callback) => (
        callback({ name: 'sub2api-code:conversion:v1', mode: 'exclusive' })
      )),
    },
  })
})

function api(overrides: Partial<ConversionApi> = {}): ConversionApi {
  return {
    exchange: vi.fn().mockResolvedValue(profile),
    me: vi.fn().mockResolvedValue(profile),
    logout: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn().mockResolvedValue({
      operation_token: 'operation-secret',
      expires_at: expiresAt,
      amount: '1.25',
      count: 1,
      total_amount: '1.25',
    }),
    execute: vi.fn().mockResolvedValue({
      status: 'completed',
      operation_id: operationId,
      amount: '1.25',
      count: 1,
      total_amount: '1.25',
      codes: [{ code: 'CODE-123', created_at: '2026-07-13T00:00:00.000Z' }],
    }),
    ...overrides,
  }
}

describe('batch conversion contracts', () => {
  it('parses an exact completed batch', async () => {
    const client = createApiClient(fetchResponse(completedPayload()))

    await expect(client.execute({ operation_token: 'operation-secret' })).resolves.toMatchObject({
      count: 2,
      codes: [{ code: 'CODE-1' }, { code: 'CODE-2' }],
    })
  })

  it.each([
    { count: 2, codes: [{ code: 'ONLY-ONE', created_at: createdAt }] },
    { count: 1, total_amount: '9', codes: [{ code: 'CODE-1', created_at: createdAt }] },
  ])('rejects inconsistent completed batch %#', async (override) => {
    const client = createApiClient(fetchResponse(completedPayload(override)))

    const error = await client.execute({ operation_token: 'operation-secret' })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
  })

  it('prepares and executes one batch then publishes every code and refreshes once', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const prepare = vi.fn().mockResolvedValue({
      operation_token: 'operation-secret',
      expires_at: expiresAt,
      amount: '2.5',
      count: 3,
      total_amount: '7.5',
    })
    const execute = vi.fn().mockResolvedValue({
      status: 'completed',
      operation_id: operationId,
      amount: '2.5',
      count: 3,
      total_amount: '7.5',
      codes: batchCodes(3),
    })
    const me = vi.fn().mockResolvedValue({ ...profile, balance: '5' })
    const store = storage()
    const conversion = createUseConversion(api({ prepare, execute, me }), store)

    await conversion.convert('2.5', 3)

    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledWith({ operation_id: operationId, amount: '2.5', count: 3 })
    expect(execute).toHaveBeenCalledOnce()
    expect(me).toHaveBeenCalledOnce()
    expect(conversion.result.value?.codes).toHaveLength(3)
    expect(conversion.history.value.filter((item) => item.operation_id === operationId)).toHaveLength(3)
  })

  it.each([
    { count: 2, total_amount: '7.5' },
    { count: 3, total_amount: '9' },
  ])('does not execute when prepare returns inconsistent batch metadata %#', async (override) => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const execute = vi.fn()
    const prepare = vi.fn().mockResolvedValue(Object.assign({
      operation_token: 'operation-secret',
      expires_at: expiresAt,
      amount: '2.5',
      count: 3,
      total_amount: '7.5',
    }, override))
    const conversion = createUseConversion(api({ prepare, execute }), storage())

    await conversion.convert('2.5', 3)

    expect(execute).not.toHaveBeenCalled()
    expect(conversion.result.value).toBeNull()
    expect(conversion.error.value).toMatchObject({ code: 'UPSTREAM_DATA_CONFLICT' })
  })

  it('does not expose any code or clear recovery when a batch history write fails', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const clearPending = vi.fn()
    const saveHistory = vi.fn().mockReturnValue(false)
    const conversion = createUseConversion(api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret', expires_at: expiresAt,
        amount: '2.5', count: 3, total_amount: '7.5',
      }),
      execute: vi.fn().mockResolvedValue({
        status: 'completed', operation_id: operationId,
        amount: '2.5', count: 3, total_amount: '7.5', codes: batchCodes(3),
      }),
    }), storage({ saveHistory, clearPending }))

    await conversion.convert('2.5', 3)

    expect(saveHistory).toHaveBeenCalledOnce()
    expect(clearPending).not.toHaveBeenCalled()
    expect(conversion.result.value).toBeNull()
    expect(conversion.history.value).toEqual([])
    expect(conversion.pendingOperation.value).toMatchObject({
      operation_id: operationId, count: 3, state: 'ready',
    })
  })
})

function storage(
  overrides: Partial<ConversionStorage> = {},
): ConversionStorage {
  let current: PendingOperation | null = null
  let history: HistoryItem[] = []
  const customLoadPending = overrides.loadPending
  const customSavePending = overrides.savePending
  const customClearPending = overrides.clearPending
  const customLoadHistory = overrides.loadHistory
  const customSaveHistory = overrides.saveHistory
  const customClearHistory = overrides.clearHistory
  let customPendingSnapshot = customLoadPending !== undefined
  return {
    loadPending: vi.fn().mockImplementation(() => (
      customPendingSnapshot ? customLoadPending!() : current
    )),
    savePending: vi.fn().mockImplementation((value: PendingOperation) => {
      const saved = customSavePending === undefined ? true : customSavePending(value)
      if (saved) {
        current = value
        customPendingSnapshot = false
      }
      return saved
    }),
    clearPending: vi.fn().mockImplementation(() => {
      const cleared = customClearPending === undefined ? true : customClearPending()
      if (cleared) {
        current = null
        customPendingSnapshot = false
      }
      return cleared
    }),
    loadHistory: vi.fn().mockImplementation(() => (
      customLoadHistory === undefined ? history : customLoadHistory()
    )),
    saveHistory: vi.fn().mockImplementation((value: HistoryItem[]) => {
      const saved = customSaveHistory === undefined ? true : customSaveHistory(value)
      if (saved) history = [...value].reverse()
      return saved
    }),
    clearHistory: vi.fn().mockImplementation(() => {
      const cleared = customClearHistory === undefined ? true : customClearHistory()
      if (cleared) history = []
      return cleared
    }),
  }
}

function exclusiveCoordinator(): ConversionCoordinator {
  let locked = false
  return {
    isAvailable: () => true,
    async runExclusive(work) {
      if (locked) return 'busy'
      locked = true
      try {
        await work()
        return 'acquired'
      } finally {
        locked = false
      }
    },
  }
}

function sharedStorage(initial: PendingOperation | null = null): {
  store: ConversionStorage
  pending: () => PendingOperation | null
  replacePending: (value: PendingOperation | null) => void
  clearPending: ReturnType<typeof vi.fn>
} {
  let current = initial
  let history: HistoryItem[] = []
  const clearPending = vi.fn().mockImplementation(() => {
    current = null
    return true
  })
  return {
    pending: () => current,
    replacePending: (value) => { current = value },
    clearPending,
    store: {
      loadPending: vi.fn().mockImplementation(() => current),
      savePending: vi.fn().mockImplementation((value: PendingOperation) => {
        current = value
        return true
      }),
      clearPending,
      loadHistory: vi.fn().mockImplementation(() => history),
      saveHistory: vi.fn().mockImplementation((value: HistoryItem[]) => {
        history = [...value].reverse()
        return true
      }),
      clearHistory: vi.fn().mockReturnValue(true),
    },
  }
}

describe('useConversion initialization', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-ui-mode')
    document.documentElement.lang = ''
    history.replaceState(null, '', '/')
  })

  afterEach(() => {
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

  it('keeps an access-denied URL token in memory and retries it on refresh', async () => {
    history.replaceState(null, '', '/?token=user-jwt')
    const exchange = vi.fn()
      .mockRejectedValueOnce(new ApiClientError('REDEEM_ACCESS_DENIED', 403, 'denied'))
      .mockResolvedValueOnce(profile)
    const me = vi.fn().mockResolvedValue(profile)
    const conversion = createUseConversion(api({ exchange, me }))

    await conversion.initialize()

    expect(location.search).toBe('')
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(me).not.toHaveBeenCalled()
    expect(conversion.session.value).toBe('unauthorized')
    expect(conversion.profile.value).toBeNull()

    await conversion.refresh()

    expect(exchange).toHaveBeenCalledTimes(2)
    expect(exchange).toHaveBeenLastCalledWith('user-jwt')
    expect(me).toHaveBeenCalledTimes(1)
    expect(conversion.session.value).toBe('authenticated')
    expect(conversion.profile.value).toEqual(profile)
  })

  it('preserves pending recovery when an authenticated profile refresh loses access', async () => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: 'pending-access-check',
      amount: '2.5',
      count: 1,
      state: 'ready',
      operation_token: 'pending-secret',
      expires_at: expiresAt,
    }
    const shared = sharedStorage(ready)
    const me = vi.fn()
      .mockResolvedValueOnce(profile)
      .mockRejectedValueOnce(new ApiClientError('REDEEM_ACCESS_DENIED', 403, 'denied'))
    const conversion = createUseConversion(api({ me }), shared.store)

    await conversion.initialize()
    await conversion.refresh()

    expect(conversion.session.value).toBe('unauthorized')
    expect(conversion.profile.value).toBeNull()
    expect(conversion.pendingOperation.value).toEqual(ready)
    expect(shared.pending()).toEqual(ready)
    expect(shared.clearPending).not.toHaveBeenCalled()
  })

  it('marks redemption access denial as non-retryable', async () => {
    const conversion = createUseConversion(api({
      me: vi.fn().mockRejectedValue(new ApiClientError('REDEEM_ACCESS_DENIED', 403, 'denied')),
    }))

    await conversion.initialize()

    expect(conversion.error.value).toMatchObject({
      code: 'REDEEM_ACCESS_DENIED',
      retryable: false,
    })
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

  it('allows only one controller to create an operation while the cross-page lock is held', async () => {
    const secondOperationId = '223e4567-e89b-42d3-a456-426614174000'
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(operationId)
      .mockReturnValueOnce(secondOperationId)
    const shared = sharedStorage()
    const coordinator = exclusiveCoordinator()
    let releasePrepare!: () => void
    let enteredPrepare!: () => void
    const entered = new Promise<void>((resolve) => { enteredPrepare = resolve })
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve })
    const prepareA = vi.fn().mockImplementation(async () => {
      enteredPrepare()
      await gate
      return {
        operation_token: 'secret-a', expires_at: expiresAt,
        amount: '1', count: 1, total_amount: '1',
      }
    })
    const prepareB = vi.fn().mockResolvedValue({
      operation_token: 'secret-b', expires_at: expiresAt,
      amount: '2', count: 1, total_amount: '2',
    })
    const conversionA = createUseConversion(api({
      prepare: prepareA,
      execute: vi.fn().mockResolvedValue({
        status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING',
      }),
    }), shared.store, coordinator)
    const conversionB = createUseConversion(api({ prepare: prepareB }), shared.store, coordinator)

    const runningA = conversionA.convert('1')
    await entered
    await conversionB.convert('2')

    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(prepareB).not.toHaveBeenCalled()
    expect(shared.pending()).toMatchObject({ operation_id: operationId, state: 'preparing' })
    expect(conversionB.error.value).toMatchObject({ code: 'CONVERSION_IN_PROGRESS' })

    releasePrepare()
    await runningA
  })

  it('allows only one controller to resume the same shared token', async () => {
    const ready: PendingOperation = {
      version: 2, operation_id: operationId, amount: '1', count: 1, state: 'ready',
      operation_token: 'shared-secret', expires_at: '2099-07-13T01:00:00.000Z',
    }
    const shared = sharedStorage(ready)
    const coordinator = exclusiveCoordinator()
    let releaseExecute!: () => void
    let enteredExecute!: () => void
    const entered = new Promise<void>((resolve) => { enteredExecute = resolve })
    const gate = new Promise<void>((resolve) => { releaseExecute = resolve })
    const executeA = vi.fn().mockImplementation(async () => {
      enteredExecute()
      await gate
      return { status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING' }
    })
    const executeB = vi.fn()
    const conversionA = createUseConversion(api({ execute: executeA }), shared.store, coordinator)
    const conversionB = createUseConversion(api({ execute: executeB }), shared.store, coordinator)
    await conversionA.initialize()
    await conversionB.initialize()

    const runningA = conversionA.resumePending()
    await entered
    await conversionB.resumePending()

    expect(executeA).toHaveBeenCalledTimes(1)
    expect(executeB).not.toHaveBeenCalled()
    expect(conversionB.error.value).toMatchObject({ code: 'CONVERSION_IN_PROGRESS' })

    releaseExecute()
    await runningA
  })

  it('does not overwrite a newer shared operation while downgrading expired recovery', async () => {
    const expired: PendingOperation = {
      version: 2, operation_id: operationId, amount: '1', count: 1, state: 'ready',
      operation_token: 'old-secret', expires_at: '2020-07-13T01:00:00.000Z',
    }
    const replacement: PendingOperation = {
      version: 2, operation_id: 'new-operation', amount: '2', count: 1, state: 'preparing',
    }
    const shared = sharedStorage(expired)
    const coordinator: ConversionCoordinator = {
      isAvailable: () => true,
      async runExclusive(work) {
        shared.replacePending(replacement)
        await work()
        return 'acquired'
      },
    }
    const conversion = createUseConversion(api(), shared.store, coordinator)

    await conversion.initialize()

    expect(shared.store.savePending).not.toHaveBeenCalled()
    expect(shared.pending()).toEqual(replacement)
    expect(conversion.pendingOperation.value).toEqual(replacement)
    expect(conversion.storageReady.value).toBe(true)
  })

  it('does not downgrade expired recovery while the cross-page lock is busy', async () => {
    const expired: PendingOperation = {
      version: 2, operation_id: operationId, amount: '1', count: 1, state: 'ready',
      operation_token: 'old-secret', expires_at: '2020-07-13T01:00:00.000Z',
    }
    const shared = sharedStorage(expired)
    const coordinator: ConversionCoordinator = {
      isAvailable: () => true,
      runExclusive: vi.fn().mockResolvedValue('busy'),
    }
    const prepare = vi.fn()
    const conversion = createUseConversion(api({ prepare }), shared.store, coordinator)

    await conversion.initialize()
    await conversion.convert('2')

    expect(shared.store.savePending).not.toHaveBeenCalled()
    expect(shared.pending()).toEqual(expired)
    expect(conversion.pendingOperation.value).toEqual(expired)
    expect(conversion.storageReady.value).toBe(false)
    expect(conversion.error.value).toMatchObject({ code: 'CONVERSION_IN_PROGRESS' })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('fails closed without Web Locks support', async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const prepare = vi.fn()
    const unavailable: ConversionCoordinator = {
      isAvailable: () => false,
      runExclusive: vi.fn().mockResolvedValue('unavailable'),
    }
    const conversion = createUseConversion(api({ prepare }), storage(), unavailable)

    await conversion.convert('1')

    expect(randomUUID).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(conversion.error.value).toMatchObject({ code: 'MANUAL_REVIEW_REQUIRED' })
  })

  it('requires an explicit refresh after hydration storage access fails', async () => {
    const existing: PendingOperation = {
      version: 2, operation_id: 'existing-operation', amount: '1', count: 1, state: 'preparing',
    }
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const prepare = vi.fn()
    const savePending = vi.fn().mockReturnValue(true)
    const loadPending = vi.fn()
      .mockImplementationOnce(() => { throw new Error('storage blocked') })
      .mockReturnValue(existing)
    const conversion = createUseConversion(api({ prepare }), storage({
      loadPending,
      savePending,
    }), exclusiveCoordinator())

    await conversion.initialize()
    expect(conversion.storageReady.value).toBe(false)
    await conversion.convert('2')

    expect(randomUUID).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(savePending).not.toHaveBeenCalled()
    expect(loadPending).toHaveBeenCalledTimes(1)
    expect(conversion.pendingOperation.value).toBeNull()
    expect(conversion.error.value).toMatchObject({
      code: 'MANUAL_REVIEW_REQUIRED', message: '无法保存本地恢复信息，请稍后重试',
    })

    await conversion.refresh()
    await conversion.convert('2')

    expect(randomUUID).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(savePending).not.toHaveBeenCalled()
    expect(conversion.pendingOperation.value).toEqual(existing)
    expect(conversion.storageReady.value).toBe(true)
    expect(conversion.error.value).toMatchObject({ code: 'CONVERSION_IN_PROGRESS' })
  })

  it('fails closed when shared pending cannot be read inside the lock', async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const prepare = vi.fn()
    const savePending = vi.fn().mockReturnValue(true)
    const conversion = createUseConversion(api({ prepare }), storage({
      loadPending: vi.fn().mockImplementation(() => { throw new Error('storage blocked') }),
      savePending,
    }), exclusiveCoordinator())

    await conversion.convert('1')

    expect(randomUUID).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(savePending).not.toHaveBeenCalled()
    expect(conversion.storageReady.value).toBe(false)
    expect(conversion.error.value).toMatchObject({
      code: 'MANUAL_REVIEW_REQUIRED', message: '无法保存本地恢复信息，请稍后重试',
    })
  })

  it('does not clear a different operation that appears before completed cleanup', async () => {
    const ready: PendingOperation = {
      version: 2, operation_id: operationId, amount: '1', count: 1, state: 'ready',
      operation_token: 'shared-secret', expires_at: '2099-07-13T01:00:00.000Z',
    }
    const replacement: PendingOperation = {
      version: 2, operation_id: 'other-operation', amount: '2', count: 1, state: 'preparing',
    }
    const shared = sharedStorage(ready)
    shared.store.saveHistory = vi.fn().mockImplementation(() => {
      shared.replacePending(replacement)
      return true
    })
    const conversion = createUseConversion(api({
      execute: vi.fn().mockResolvedValue({
        status: 'completed', operation_id: operationId, amount: '1', count: 1,
        total_amount: '1', codes: [{ code: 'CODE-A', created_at: 'upstream-time-value' }],
      }),
    }), shared.store, exclusiveCoordinator())
    await conversion.initialize()

    await conversion.resumePending()

    expect(shared.clearPending).not.toHaveBeenCalled()
    expect(shared.pending()).toEqual(replacement)
    expect(conversion.pendingOperation.value).toEqual(replacement)
    expect(conversion.error.value).toMatchObject({ code: 'MANUAL_REVIEW_REQUIRED' })
  })

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
          expires_at: '2099-07-13T01:00:00.000Z',
          amount: request.amount,
          count: request.count,
          total_amount: request.amount,
        }
      }),
      execute: vi.fn().mockImplementation(async (request) => {
        calls.push(`execute:${request.operation_token}`)
        return {
          status: 'completed',
          operation_id: operationId,
          amount: '1.25',
          count: 1,
          total_amount: '1.25',
          codes: [{ code: 'CODE-123', created_at: '2026-07-13T00:00:00.000Z' }],
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
    expect(conversion.result.value).toMatchObject({
      status: 'completed', codes: [{ code: 'CODE-123' }],
    })
    expect(conversion.pending.value).toBeNull()
  })

  it('reloads the live profile after a completed conversion', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const me = vi.fn().mockResolvedValue({ ...profile, balance: '11.25' })
    const conversion = createUseConversion(
      api({ me }),
      storage(),
      exclusiveCoordinator(),
    )

    await conversion.convert('1.25')

    expect(me).toHaveBeenCalledTimes(1)
    expect(conversion.profile.value).toEqual({ ...profile, balance: '11.25' })
    expect(conversion.result.value).toMatchObject({
      status: 'completed', codes: [{ code: 'CODE-123' }],
    })
    expect(conversion.pendingOperation.value).toBeNull()
  })

  it('keeps a completed result terminal when the balance refresh fails', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const me = vi.fn().mockRejectedValue(
      new ApiClientError('UPSTREAM_UNAVAILABLE', 503, 'profile-refresh'),
    )
    const conversion = createUseConversion(
      api({ me }),
      storage(),
      exclusiveCoordinator(),
    )

    await conversion.convert('1.25')

    expect(me).toHaveBeenCalledTimes(1)
    expect(conversion.result.value).toMatchObject({
      status: 'completed', codes: [{ code: 'CODE-123' }],
    })
    expect(conversion.pendingOperation.value).toBeNull()
    expect(conversion.error.value).toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      requestId: 'profile-refresh',
    })
  })

  it('persists preparing and ready before writes, then history before clearing pending', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const store = storage({
      savePending: vi.fn().mockImplementation((value: PendingOperation) => {
        calls.push(`save-pending:${value.state}:${'operation_token' in value ? value.operation_token : ''}`)
        return true
      }),
      loadHistory: vi.fn().mockImplementation(() => {
        calls.push('load-history')
        return []
      }),
      saveHistory: vi.fn().mockImplementation((items: HistoryItem[]) => {
        calls.push(`save-history:${items.at(-1)?.code}`)
        return true
      }),
      clearPending: vi.fn().mockImplementation(() => {
        calls.push('clear-pending')
        return true
      }),
    })
    const client = api({
      prepare: vi.fn().mockImplementation(async () => {
        calls.push('prepare')
        return {
          operation_token: 'operation-secret', expires_at: expiresAt,
          amount: '1.25', count: 1, total_amount: '1.25',
        }
      }),
      execute: vi.fn().mockImplementation(async () => {
        calls.push('execute')
        return {
          status: 'completed', operation_id: operationId, amount: '1.25', count: 1,
          total_amount: '1.25',
          codes: [{ code: 'CODE-123', created_at: '2026-07-13T00:00:00.000Z' }],
        }
      }),
    })

    await createUseConversion(client, store).convert('1.25')

    expect(calls).toEqual([
      'save-pending:preparing:',
      'prepare',
      'save-pending:ready:operation-secret',
      'execute',
      'load-history',
      'save-history:CODE-123',
      'clear-pending',
    ])
  })

  it('stops before prepare or execute when recovery metadata cannot be persisted', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const prepare = vi.fn()
    const execute = vi.fn()
    const conversion = createUseConversion(api({ prepare, execute }), storage({
      savePending: vi.fn().mockReturnValue(false),
    }))

    await conversion.convert('1')

    expect(prepare).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(conversion.error.value?.code).toBe('MANUAL_REVIEW_REQUIRED')
  })

  it('stops before execute when the prepared token cannot be persisted', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const execute = vi.fn()
    const savePending = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const prepare = vi.fn().mockResolvedValue({
      operation_token: 'operation-secret', expires_at: expiresAt,
      amount: '1', count: 1, total_amount: '1',
    })
    const conversion = createUseConversion(api({ prepare, execute }), storage({ savePending }))

    await conversion.convert('1')

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(conversion.pendingOperation.value?.state).toBe('preparing')
    expect(conversion.error.value?.code).toBe('MANUAL_REVIEW_REQUIRED')
  })

  it.each(['AMOUNT_INVALID', 'AMOUNT_EXCEEDS_BALANCE'] as const)(
    'clears preparing after deterministic %s and allows a corrected new operation',
    async (code) => {
      const correctedOperationId = '223e4567-e89b-42d3-a456-426614174000'
      const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID')
        .mockReturnValueOnce(operationId)
        .mockReturnValueOnce(correctedOperationId)
      const prepare = vi.fn()
        .mockRejectedValueOnce(new ApiClientError(code, 400, 'request-amount'))
        .mockResolvedValueOnce({
          operation_token: 'corrected-secret',
          expires_at: '2099-07-13T01:00:00.000Z',
          amount: '2',
          count: 1,
          total_amount: '2',
        })
      const execute = vi.fn().mockResolvedValue({
        status: 'pending', operation_id: correctedOperationId, error: 'CONVERSION_PENDING',
      })
      const clearPending = vi.fn().mockReturnValue(true)
      const conversion = createUseConversion(api({ prepare, execute }), storage({ clearPending }))

      await conversion.convert('1')

      expect(clearPending).toHaveBeenCalledTimes(1)
      expect(conversion.pendingOperation.value).toBeNull()
      expect(conversion.error.value).toMatchObject({ code })

      await conversion.convert('2')

      expect(randomUUID).toHaveBeenCalledTimes(2)
      expect(prepare).toHaveBeenLastCalledWith({
        operation_id: correctedOperationId, amount: '2', count: 1,
      })
      expect(execute).toHaveBeenCalledWith({ operation_token: 'corrected-secret' })
    },
  )

  it('keeps preparing and storage failure priority when deterministic prepare cleanup fails', async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const prepare = vi.fn().mockRejectedValue(
      new ApiClientError('AMOUNT_INVALID', 400, 'request-amount'),
    )
    const clearPending = vi.fn().mockReturnValue(false)
    const conversion = createUseConversion(api({ prepare }), storage({ clearPending }))

    await conversion.convert('1')
    await conversion.convert('2')

    expect(clearPending).toHaveBeenCalledTimes(1)
    expect(conversion.pendingOperation.value).toEqual({
      version: 2, operation_id: operationId, amount: '1', count: 1, state: 'preparing',
    })
    expect(conversion.error.value).toMatchObject({
      code: 'MANUAL_REVIEW_REQUIRED',
      message: '无法保存本地恢复信息，请稍后重试',
    })
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['pending response', null],
    ['uncertain network error', new TypeError('network failed')],
  ] as const)('retains the same operation and token after a %s', async (_name, failure) => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const saved: PendingOperation[] = []
    const store = storage({
      savePending: vi.fn().mockImplementation((value: PendingOperation) => {
        saved.push(value)
        return true
      }),
    })
    const execute = failure === null
      ? vi.fn().mockResolvedValue({ status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING' })
      : vi.fn().mockRejectedValue(failure)
    const conversion = createUseConversion(api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'same-operation-secret', expires_at: expiresAt,
        amount: '1', count: 1, total_amount: '1',
      }),
      execute,
    }), store)

    await conversion.convert('1')

    expect(saved.at(-1)).toEqual({
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'pending',
      operation_token: 'same-operation-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    })
    expect(conversion.pendingOperation.value).toEqual(saved.at(-1))
  })

  it('turns a pending MANUAL_REVIEW_REQUIRED response into tokenless manual review', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const shared = sharedStorage()
    const execute = vi.fn().mockResolvedValue({
      status: 'pending', operation_id: operationId, error: 'MANUAL_REVIEW_REQUIRED',
    })
    const conversion = createUseConversion(api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'must-be-removed', expires_at: expiresAt,
        amount: '1', count: 1, total_amount: '1',
      }),
      execute,
    }), shared.store, exclusiveCoordinator())

    await conversion.convert('1')
    await conversion.resumePending()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(shared.pending()).toEqual({
      version: 2, operation_id: operationId, amount: '1', count: 1, state: 'expired',
      expires_at: '2099-07-13T01:00:00.000Z',
    })
    expect(conversion.pendingOperation.value).toEqual(shared.pending())
    expect(conversion.pendingOperation.value).not.toHaveProperty('operation_token')
    expect(conversion.result.value).toBeNull()
    expect(conversion.error.value).toMatchObject({ code: 'MANUAL_REVIEW_REQUIRED' })
  })

  it('clears a previous code after the next persisted operation has an uncertain execute failure', async () => {
    const secondOperationId = '223e4567-e89b-42d3-a456-426614174000'
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(operationId)
      .mockReturnValueOnce(secondOperationId)
    const saved: PendingOperation[] = []
    const store = storage({
      savePending: vi.fn().mockImplementation((value: PendingOperation) => {
        saved.push(value)
        return true
      }),
    })
    const prepare = vi.fn()
      .mockResolvedValueOnce({
        operation_token: 'first-secret', expires_at: expiresAt,
        amount: '1', count: 1, total_amount: '1',
      })
      .mockResolvedValueOnce({
        operation_token: 'second-secret', expires_at: expiresAt,
        amount: '2', count: 1, total_amount: '2',
      })
    const execute = vi.fn()
      .mockResolvedValueOnce({
        status: 'completed', operation_id: operationId, amount: '1', count: 1,
        total_amount: '1',
        codes: [{ code: 'CODE-FIRST', created_at: '2026-07-13T00:00:00.000Z' }],
      })
      .mockRejectedValueOnce(new TypeError('network failed'))
    const conversion = createUseConversion(api({ prepare, execute }), store)

    await conversion.convert('1')
    expect(conversion.result.value?.codes[0]?.code).toBe('CODE-FIRST')

    await conversion.convert('2')

    expect(conversion.result.value).toBeNull()
    expect(conversion.pending.value).toBeNull()
    expect(conversion.pendingOperation.value).toEqual({
      version: 2,
      operation_id: secondOperationId,
      amount: '2',
      count: 1,
      state: 'pending',
      operation_token: 'second-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    })
    expect(saved.at(-1)).toEqual(conversion.pendingOperation.value)
    expect(conversion.error.value).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
    expect(JSON.stringify({ result: conversion.result.value, pending: conversion.pending.value }))
      .not.toContain('CODE-FIRST')
  })

  it('keeps a previous code when the next preparing operation cannot be persisted', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(operationId)
      .mockReturnValueOnce('223e4567-e89b-42d3-a456-426614174000')
    const savePending = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const conversion = createUseConversion(api(), storage({ savePending }))

    await conversion.convert('1.25')
    expect(conversion.result.value?.codes[0]?.code).toBe('CODE-123')

    await conversion.convert('2')

    expect(conversion.result.value?.codes[0]?.code).toBe('CODE-123')
    expect(conversion.pendingOperation.value).toBeNull()
    expect(conversion.error.value).toMatchObject({ code: 'MANUAL_REVIEW_REQUIRED' })
  })

  it('loads pending recovery metadata without automatically calling prepare or execute', async () => {
    const pending: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'same-operation-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    const prepare = vi.fn()
    const execute = vi.fn()
    const conversion = createUseConversion(api({ prepare, execute }), storage({
      loadPending: vi.fn().mockReturnValue(pending),
    }))

    await conversion.initialize()

    expect(conversion.pendingOperation.value).toEqual(pending)
    expect(prepare).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    { version: 2 as const, operation_id: operationId, amount: '1', count: 1, state: 'preparing' as const },
    {
      version: 2 as const, operation_id: operationId, amount: '1', count: 1, state: 'ready' as const,
      operation_token: 'operation-secret', expires_at: '2099-07-13T01:00:00.000Z',
    },
    {
      version: 2 as const, operation_id: operationId, amount: '1', count: 1, state: 'pending' as const,
      operation_token: 'operation-secret', expires_at: '2099-07-13T01:00:00.000Z',
    },
    {
      version: 2 as const, operation_id: operationId, amount: '1', count: 1, state: 'expired' as const,
      expires_at: '2020-07-13T01:00:00.000Z',
    },
  ])('does not overwrite an unresolved $state operation with a new conversion', async (existing) => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('223e4567-e89b-42d3-a456-426614174000')
    const prepare = vi.fn()
    const execute = vi.fn()
    const store = storage({ loadPending: vi.fn().mockReturnValue(existing) })
    const conversion = createUseConversion(api({ prepare, execute }), store)

    await conversion.convert('2')

    expect(randomUUID).not.toHaveBeenCalled()
    expect(store.savePending).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(conversion.pendingOperation.value).toEqual(existing)
  })

  it('resumes preparing with the same operation ID and ready with the same operation token', async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const preparing: PendingOperation = {
      version: 2, operation_id: operationId, amount: '1', count: 1, state: 'preparing',
    }
    const prepare = vi.fn().mockResolvedValue({
      operation_token: 'same-operation-secret', expires_at: expiresAt,
      amount: '1', count: 1, total_amount: '1',
    })
    const execute = vi.fn().mockResolvedValue({ status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING' })
    const store = storage({ loadPending: vi.fn().mockReturnValue(preparing) })
    const conversion = createUseConversion(api({ prepare, execute }), store)
    await conversion.initialize()

    await conversion.resumePending()

    expect(prepare).toHaveBeenCalledWith({ operation_id: operationId, amount: '1', count: 1 })
    expect(execute).toHaveBeenCalledWith({ operation_token: 'same-operation-secret' })
    expect(randomUUID).not.toHaveBeenCalled()
  })

  it('resumes ready directly with the stored token without preparing a new operation', async () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'stored-operation-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    const prepare = vi.fn()
    const execute = vi.fn().mockResolvedValue({
      status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING',
    })
    const store = storage({
      loadPending: vi.fn().mockReturnValue(ready),
    })
    const conversion = createUseConversion(api({ prepare, execute }), store)
    await conversion.initialize()

    await conversion.resumePending()

    expect(prepare).not.toHaveBeenCalled()
    expect(store.savePending).toHaveBeenNthCalledWith(1, ready)
    expect(execute).toHaveBeenCalledWith({ operation_token: 'stored-operation-secret' })
    expect(randomUUID).not.toHaveBeenCalled()
  })

  it('converts an expired token to minimal manual-review metadata and never executes it', async () => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'expired-operation-secret',
      expires_at: '2020-07-13T01:00:00.000Z',
    }
    const execute = vi.fn()
    const savePending = vi.fn().mockReturnValue(true)
    const conversion = createUseConversion(api({ execute }), storage({
      loadPending: vi.fn().mockReturnValue(ready),
      savePending,
    }))

    await conversion.initialize()
    await conversion.resumePending()

    expect(conversion.pendingOperation.value).toEqual({
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'expired',
      expires_at: '2020-07-13T01:00:00.000Z',
    })
    expect(JSON.stringify(conversion.pendingOperation.value)).not.toContain('expired-operation-secret')
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps expired manual-review state in memory when expiry downgrade persistence fails', async () => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'expired-operation-secret',
      expires_at: '2020-07-13T01:00:00.000Z',
    }
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('223e4567-e89b-42d3-a456-426614174000')
    const prepare = vi.fn()
    const savePending = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true)
    const clearPending = vi.fn().mockReturnValue(true)
    const conversion = createUseConversion(api({ prepare }), storage({
      loadPending: vi.fn().mockReturnValue(ready),
      savePending,
      clearPending,
    }))

    await conversion.initialize()

    expect(conversion.pendingOperation.value).toEqual({
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'expired',
      expires_at: '2020-07-13T01:00:00.000Z',
    })
    expect(JSON.stringify(conversion.pendingOperation.value)).not.toContain('expired-operation-secret')
    expect(conversion.error.value).toMatchObject({ code: 'MANUAL_REVIEW_REQUIRED' })

    await conversion.convert('2')

    expect(randomUUID).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(clearPending).toHaveBeenCalledTimes(1)
    expect(savePending).toHaveBeenCalledTimes(2)
    expect(savePending).toHaveBeenLastCalledWith(conversion.pendingOperation.value)
  })

  it('clears a terminated operation and never executes it again on resume', async () => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'terminated-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    const execute = vi.fn().mockRejectedValue(
      new ApiClientError('OPERATION_TERMINATED', 409, 'request-terminated'),
    )
    const clearPending = vi.fn().mockReturnValue(true)
    const conversion = createUseConversion(api({ execute }), storage({
      loadPending: vi.fn().mockReturnValue(ready),
      clearPending,
    }))
    await conversion.initialize()

    await conversion.resumePending()
    await conversion.resumePending()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(clearPending).toHaveBeenCalledTimes(1)
    expect(conversion.pendingOperation.value).toBeNull()
    expect(conversion.error.value).toMatchObject({ code: 'OPERATION_TERMINATED' })
  })

  it.each([
    'OPERATION_TOKEN_INVALID',
    'UPSTREAM_AUTH_FAILED',
    'UPSTREAM_DATA_CONFLICT',
    'MANUAL_REVIEW_REQUIRED',
  ] as const)('converts non-retryable execute error %s to tokenless manual review', async (code) => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'unsafe-to-retry-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    const saved: PendingOperation[] = []
    const execute = vi.fn().mockRejectedValue(new ApiClientError(code, 409, 'request-review'))
    const conversion = createUseConversion(api({ execute }), storage({
      loadPending: vi.fn().mockReturnValue(ready),
      savePending: vi.fn().mockImplementation((value: PendingOperation) => {
        saved.push(value)
        return true
      }),
    }))
    await conversion.initialize()

    await conversion.resumePending()
    await conversion.resumePending()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(saved.at(-1)).toEqual({
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'expired',
      expires_at: '2099-07-13T01:00:00.000Z',
    })
    expect(conversion.pendingOperation.value).toEqual(saved.at(-1))
    expect(JSON.stringify(conversion.pendingOperation.value)).not.toContain('unsafe-to-retry-secret')
    expect(conversion.error.value).toMatchObject({ code: 'MANUAL_REVIEW_REQUIRED' })
  })

  it('keeps terminated manual-review state in memory when clearing storage fails', async () => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'terminated-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const execute = vi.fn().mockRejectedValue(
      new ApiClientError('OPERATION_TERMINATED', 409, 'request-terminated'),
    )
    const conversion = createUseConversion(api({ execute }), storage({
      loadPending: vi.fn().mockReturnValue(ready),
      clearPending: vi.fn().mockReturnValue(false),
    }))
    await conversion.initialize()

    await conversion.resumePending()
    await conversion.resumePending()
    await conversion.convert('2')

    expect(execute).toHaveBeenCalledTimes(1)
    expect(randomUUID).not.toHaveBeenCalled()
    expect(conversion.pendingOperation.value).toEqual({
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'expired',
      expires_at: '2099-07-13T01:00:00.000Z',
    })
    expect(conversion.error.value).toMatchObject({
      code: 'MANUAL_REVIEW_REQUIRED',
      message: '无法保存本地恢复信息，请稍后重试',
    })
  })

  it('keeps tokenless manual-review state and storage error priority when downgrade save fails', async () => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'invalid-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    const execute = vi.fn().mockRejectedValue(
      new ApiClientError('OPERATION_TOKEN_INVALID', 400, 'request-invalid'),
    )
    const conversion = createUseConversion(api({ execute }), storage({
      loadPending: vi.fn().mockReturnValue(ready),
      savePending: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
    }))
    await conversion.initialize()

    await conversion.resumePending()
    await conversion.resumePending()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(conversion.pendingOperation.value).toEqual({
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'expired',
      expires_at: '2099-07-13T01:00:00.000Z',
    })
    expect(conversion.error.value).toMatchObject({
      code: 'MANUAL_REVIEW_REQUIRED',
      message: '无法保存本地恢复信息，请稍后重试',
    })
  })

  it('does not revive a manual-review token when downgrade save and clear both fail', async () => {
    const ready: PendingOperation = {
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'ready',
      operation_token: 'must-not-revive',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    let current: PendingOperation | null = ready
    let writes = 0
    const savePending = vi.fn().mockImplementation((value: PendingOperation) => {
      writes += 1
      if (writes !== 1) return false
      current = value
      return true
    })
    const clearPending = vi.fn().mockReturnValue(false)
    const store: ConversionStorage = {
      loadPending: vi.fn().mockImplementation(() => current),
      savePending,
      clearPending,
      loadHistory: vi.fn().mockReturnValue([]),
      saveHistory: vi.fn().mockReturnValue(true),
      clearHistory: vi.fn().mockReturnValue(true),
    }
    const execute = vi.fn().mockRejectedValue(
      new ApiClientError('MANUAL_REVIEW_REQUIRED', 409, 'request-review'),
    )
    const first = createUseConversion(api({ execute }), store)
    await first.initialize()

    await first.resumePending()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(clearPending).toHaveBeenCalledTimes(1)
    expect(current).toEqual(ready)
    expect(first.storageReady.value).toBe(false)

    const second = createUseConversion(api({ execute }), store)
    await second.initialize()
    await second.resumePending()

    expect(savePending).toHaveBeenLastCalledWith(ready)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(second.storageReady.value).toBe(false)
    expect(second.error.value).toMatchObject({
      code: 'MANUAL_REVIEW_REQUIRED',
      message: '无法保存本地恢复信息，请稍后重试',
    })
  })

  it('does not clear pending when completed history cannot be persisted', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const clearPending = vi.fn()
    const conversion = createUseConversion(api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret', expires_at: expiresAt,
        amount: '1', count: 1, total_amount: '1',
      }),
      execute: vi.fn().mockResolvedValue({
        status: 'completed', operation_id: operationId, amount: '1', count: 1,
        total_amount: '1',
        codes: [{ code: 'CODE-123', created_at: '2026-07-13T00:00:00.000Z' }],
      }),
    }), storage({
      saveHistory: vi.fn().mockReturnValue(false),
      clearPending,
    }))

    await conversion.convert('1')

    expect(clearPending).not.toHaveBeenCalled()
    expect(conversion.pendingOperation.value?.operation_id).toBe(operationId)
    expect(conversion.result.value).toBeNull()
  })

  it('does not clear pending when completed history cannot be read', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const clearPending = vi.fn()
    const conversion = createUseConversion(api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret', expires_at: expiresAt,
        amount: '1', count: 1, total_amount: '1',
      }),
      execute: vi.fn().mockResolvedValue({
        status: 'completed', operation_id: operationId, amount: '1', count: 1,
        total_amount: '1',
        codes: [{ code: 'CODE-123', created_at: 'upstream-time-value' }],
      }),
    }), storage({
      loadHistory: vi.fn().mockImplementation(() => { throw new Error('storage blocked') }),
      clearPending,
    }), exclusiveCoordinator())

    await conversion.convert('1')

    expect(clearPending).not.toHaveBeenCalled()
    expect(conversion.pendingOperation.value).toMatchObject({ operation_id: operationId, state: 'ready' })
    expect(conversion.result.value).toBeNull()
    expect(conversion.error.value).toMatchObject({
      code: 'MANUAL_REVIEW_REQUIRED', message: '无法保存本地恢复信息，请稍后重试',
    })
  })

  it('persists and completes a code with an unparseable display timestamp', async () => {
    localStorage.clear()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const conversion = createUseConversion(api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret', expires_at: expiresAt,
        amount: '1', count: 1, total_amount: '1',
      }),
      execute: vi.fn().mockResolvedValue({
        status: 'completed', operation_id: operationId, amount: '1', count: 1,
        total_amount: '1',
        codes: [{ code: 'CODE-UPSTREAM', created_at: 'upstream-time-value' }],
      }),
    }), browserStorage, exclusiveCoordinator())

    await conversion.convert('1')

    expect(conversion.result.value?.codes[0]?.code).toBe('CODE-UPSTREAM')
    expect(loadHistory()).toEqual([{
      version: 2,
      history_id: `${operationId}:1`,
      operation_id: operationId,
      batch_index: 1,
      batch_size: 1,
      amount: '1',
      code: 'CODE-UPSTREAM',
      created_at: 'upstream-time-value',
    }])
    expect(conversion.pendingOperation.value).toBeNull()
  })

  it('stores a pending response without a code and does not expose a previous completion', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const client = api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret',
        expires_at: '2099-07-13T01:00:00.000Z',
        amount: '2.0',
        count: 1,
        total_amount: '2',
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

  it('clears stale pending display and keeps preparing recovery on rate limiting', async () => {
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

    expect(conversion.pending.value).toBeNull()
    expect(conversion.pendingOperation.value).toEqual({
      version: 2,
      operation_id: operationId,
      amount: '1',
      count: 1,
      state: 'preparing',
    })
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
        expires_at: '2099-07-13T01:00:00.000Z',
        amount: '2',
        count: 1,
        total_amount: '2',
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
        count: 1,
        total_amount: '1',
        codes: [{ code: 'MUST-NOT-DISPLAY', created_at: '2026-07-13T00:00:00.000Z' }],
      },
    ],
    [
      'completed amount',
      {
        status: 'completed' as const,
        operation_id: operationId,
        amount: '2',
        count: 1,
        total_amount: '2',
        codes: [{ code: 'MUST-NOT-DISPLAY', created_at: '2026-07-13T00:00:00.000Z' }],
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
  ])('rejects a mismatched %s and requires tokenless manual review', async (_name, response) => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
    const client = api({
      prepare: vi.fn().mockResolvedValue({
        operation_token: 'operation-secret',
        expires_at: '2099-07-13T01:00:00.000Z',
        amount: '1.0',
        count: 1,
        total_amount: '1',
      }),
      execute: vi.fn().mockResolvedValue(response),
    })
    const conversion = createUseConversion(client)

    await conversion.convert('1.00000000')

    expect(conversion.result.value).toBeNull()
    expect(conversion.pending.value).toBeNull()
    expect(conversion.pendingOperation.value).toMatchObject({
      operation_id: operationId,
      amount: '1',
      state: 'expired',
    })
    expect(conversion.pendingOperation.value).not.toHaveProperty('operation_token')
    expect(conversion.error.value).toMatchObject({ code: 'MANUAL_REVIEW_REQUIRED' })
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
        expires_at: '2099-07-13T01:00:00.000Z',
        amount: '1',
        count: 1,
        total_amount: '1',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING',
      }), { status: 202 }))
    const client = createApiClient(fetcher)

    await client.exchange('jwt-secret')
    await client.me()
    await client.logout()
    await client.prepare({ operation_id: operationId, amount: '1', count: 1 })
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
      (client: ConversionApi) => client.prepare({ operation_id: operationId, amount: '1', count: 1 }),
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
      count: 1,
      total_amount: '1',
      codes: [{ code: 'CODE-123', created_at: '2026-07-13 00:00:00' }],
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
