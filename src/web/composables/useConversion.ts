import { Decimal } from 'decimal.js'
import { ref, type Ref } from 'vue'

import type { ErrorCode, ExecuteResponse, MeResponse } from '../../shared/contracts.js'
import type { ExecutableOperation, HistoryItem, PendingOperation } from '../../shared/storage-types.js'
import { ApiClientError, apiClient, type ConversionApi } from '../api.js'
import { browserStorage, type ConversionStorage } from '../storage.js'

type CompletedResult = Extract<ExecuteResponse, { status: 'completed' }>
type PendingResult = Extract<ExecuteResponse, { status: 'pending' }>
export type SessionState = 'loading' | 'authenticated' | 'expired' | 'error'

export interface ConversionError {
  code: ErrorCode
  message: string
  requestId: string
  retryable: boolean
}

export interface ConversionController {
  session: Ref<SessionState>
  profile: Ref<MeResponse | null>
  result: Ref<CompletedResult | null>
  pending: Ref<PendingResult | null>
  pendingOperation: Ref<PendingOperation | null>
  history: Ref<HistoryItem[]>
  error: Ref<ConversionError | null>
  loading: Ref<boolean>
  busy: Ref<boolean>
  initialize(): Promise<void>
  refresh(): Promise<void>
  logout(): Promise<void>
  convert(amount: string): Promise<void>
  resumePending(): Promise<void>
  clearHistory(): void
}

const sessionCodes = new Set<ErrorCode>(['SESSION_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED'])
const retryableCodes = new Set<ErrorCode>([
  'RATE_LIMITED',
  'CONVERSION_IN_PROGRESS',
  'CONVERSION_PENDING',
  'UPSTREAM_IDEMPOTENCY_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
])

export function normalizeAmount(raw: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(raw) || raw.includes('e') || raw.includes('E')) {
    throw new Error('invalid amount')
  }
  const amount = new Decimal(raw)
  if (!amount.isFinite()) throw new Error('invalid amount')
  return amount.toFixed()
}

export function isValidAmount(raw: string, balance: string): boolean {
  if (!/^\d+(?:\.\d{1,8})?$/.test(raw)) return false
  try {
    const amount = new Decimal(raw)
    const currentBalance = new Decimal(balance)
    return amount.isFinite()
      && currentBalance.isFinite()
      && amount.greaterThan(0)
      && amount.decimalPlaces() <= 8
      && amount.lessThanOrEqualTo(currentBalance)
  } catch {
    return false
  }
}

function applyUrlPreferences(url: URL): void {
  const theme = url.searchParams.get('theme')
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme

  const mode = url.searchParams.get('ui_mode')
  if (mode === 'iframe' || mode === 'compact') document.documentElement.dataset.uiMode = mode

  const lang = url.searchParams.get('lang')?.toLowerCase()
  const normalizedLang: Record<string, string> = {
    zh: 'zh-CN',
    'zh-cn': 'zh-CN',
    'zh-hans': 'zh-CN',
    en: 'en-US',
    'en-us': 'en-US',
  }
  if (lang !== undefined && normalizedLang[lang] !== undefined) {
    document.documentElement.lang = normalizedLang[lang]
  }
}

function cleanSensitiveQuery(url: URL): void {
  url.searchParams.delete('token')
  url.searchParams.delete('user_id')
  const next = `${url.pathname}${url.search}${url.hash}`
  history.replaceState(history.state, '', next)
}

function toConversionError(caught: unknown): ConversionError {
  if (caught instanceof ApiClientError) {
    return {
      code: caught.code,
      message: caught.message,
      requestId: caught.requestId,
      retryable: retryableCodes.has(caught.code),
    }
  }
  return {
    code: 'UPSTREAM_UNAVAILABLE',
    message: '服务暂时不可用',
    requestId: '',
    retryable: true,
  }
}

function amountsEqual(left: string, right: string): boolean {
  try {
    return new Decimal(left).equals(new Decimal(right))
  } catch {
    return false
  }
}

function conversionConflict(): ApiClientError {
  return new ApiClientError('UPSTREAM_DATA_CONFLICT', 502, '')
}

function storageFailure(): ConversionError {
  return {
    code: 'MANUAL_REVIEW_REQUIRED',
    message: '无法保存本地恢复信息，请稍后重试',
    requestId: '',
    retryable: false,
  }
}

function isExpired(operation: ExecutableOperation): boolean {
  return Date.parse(operation.expires_at) <= Date.now()
}

export function createUseConversion(
  api: ConversionApi,
  storage: ConversionStorage = browserStorage,
): ConversionController {
  const session = ref<SessionState>('loading')
  const profile = ref<MeResponse | null>(null)
  const result = ref<CompletedResult | null>(null)
  const pending = ref<PendingResult | null>(null)
  const pendingOperation = ref<PendingOperation | null>(null)
  const conversionHistory = ref<HistoryItem[]>([])
  const error = ref<ConversionError | null>(null)
  const loading = ref(false)
  const busy = ref(false)
  let initialization: Promise<void> | null = null
  let pendingExchangeToken: string | null = null

  function failStorage(): void {
    error.value = storageFailure()
  }

  function persistPending(value: PendingOperation): boolean {
    if (!storage.savePending(value)) {
      failStorage()
      return false
    }
    pendingOperation.value = value
    return true
  }

  function expirePending(value: ExecutableOperation): void {
    const expired: PendingOperation = {
      version: 1,
      operation_id: value.operation_id,
      amount: value.amount,
      state: 'expired',
      expires_at: value.expires_at,
    }
    if (persistPending(expired)) {
      error.value = {
        code: 'MANUAL_REVIEW_REQUIRED',
        message: '本次兑换需要管理员核对',
        requestId: '',
        retryable: false,
      }
    }
  }

  function hydrateLocalState(): void {
    conversionHistory.value = storage.loadHistory()
    const stored = storage.loadPending()
    if (stored !== null && (stored.state === 'ready' || stored.state === 'pending') && isExpired(stored)) {
      expirePending(stored)
      return
    }
    pendingOperation.value = stored
  }

  async function loadProfile(): Promise<void> {
    profile.value = await api.me()
    session.value = 'authenticated'
  }

  function handleError(caught: unknown): void {
    const safeError = toConversionError(caught)
    error.value = safeError
    if (sessionCodes.has(safeError.code)) {
      pendingExchangeToken = null
      session.value = 'expired'
      profile.value = null
    } else if (session.value === 'loading') {
      session.value = 'error'
    }
  }

  function initialize(): Promise<void> {
    if (initialization !== null) return initialization
    initialization = (async () => {
      loading.value = true
      error.value = null
      hydrateLocalState()
      const url = new URL(window.location.href)
      applyUrlPreferences(url)
      const token = url.searchParams.get('token')
      if (url.searchParams.has('token') || url.searchParams.has('user_id')) {
        cleanSensitiveQuery(url)
      }
      if (token !== null && token.length > 0) pendingExchangeToken = token
      try {
        if (pendingExchangeToken !== null) {
          await api.exchange(pendingExchangeToken)
          pendingExchangeToken = null
        }
        await loadProfile()
      } catch (caught) {
        handleError(caught)
      } finally {
        loading.value = false
      }
    })()
    return initialization
  }

  async function refresh(): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = null
    try {
      if (pendingExchangeToken !== null) {
        await api.exchange(pendingExchangeToken)
        pendingExchangeToken = null
      }
      await loadProfile()
    } catch (caught) {
      handleError(caught)
    } finally {
      busy.value = false
    }
  }

  async function logout(): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = null
    try {
      await api.logout()
      profile.value = null
      session.value = 'expired'
    } catch (caught) {
      handleError(caught)
    } finally {
      busy.value = false
    }
  }

  function publishHistory(response: CompletedResult): boolean {
    const item: HistoryItem = {
      version: 1,
      operation_id: response.operation_id,
      amount: response.amount,
      code: response.code,
      created_at: response.created_at,
    }
    const currentHistory = storage.loadHistory()
    const chronological = [...currentHistory].reverse()
    chronological.push(item)
    if (!storage.saveHistory(chronological)) {
      failStorage()
      return false
    }
    conversionHistory.value = [
      item,
      ...currentHistory.filter((entry) => entry.operation_id !== item.operation_id),
    ].slice(0, 100)
    return true
  }

  async function executePrepared(operation: ExecutableOperation): Promise<void> {
    if (isExpired(operation)) {
      expirePending(operation)
      return
    }
    try {
      const response = await api.execute({ operation_token: operation.operation_token })
      if (response.operation_id !== operation.operation_id) throw conversionConflict()
      if (response.status === 'completed') {
        if (!amountsEqual(response.amount, operation.amount)) throw conversionConflict()
        if (!publishHistory(response)) return
        if (storage.clearPending()) pendingOperation.value = null
        else failStorage()
        result.value = response
        pending.value = null
      } else {
        const next: PendingOperation = { ...operation, state: 'pending' }
        persistPending(next)
        pending.value = {
          status: 'pending',
          operation_id: response.operation_id,
          error: response.error,
        }
        result.value = null
      }
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === 'OPERATION_TOKEN_EXPIRED') {
        expirePending(operation)
      } else {
        if (!(caught instanceof ApiClientError) || retryableCodes.has(caught.code)) {
          persistPending({ ...operation, state: 'pending' })
        }
        handleError(caught)
      }
    }
  }

  async function prepareAndExecute(operation: Extract<PendingOperation, { state: 'preparing' }>): Promise<void> {
    try {
      const prepared = await api.prepare({
        operation_id: operation.operation_id,
        amount: operation.amount,
      })
      if (!amountsEqual(prepared.amount, operation.amount)) throw conversionConflict()
      const ready: ExecutableOperation = {
        version: 1,
        operation_id: operation.operation_id,
        amount: operation.amount,
        state: 'ready',
        operation_token: prepared.operation_token,
        expires_at: prepared.expires_at,
      }
      if (!persistPending(ready)) return
      await executePrepared(ready)
    } catch (caught) {
      handleError(caught)
    }
  }

  async function convert(rawAmount: string): Promise<void> {
    if (busy.value || pendingOperation.value !== null) return
    busy.value = true
    error.value = null
    try {
      const amount = normalizeAmount(rawAmount)
      const operationId = crypto.randomUUID()
      const operation: PendingOperation = {
        version: 1,
        operation_id: operationId,
        amount,
        state: 'preparing',
      }
      if (!persistPending(operation)) return
      await prepareAndExecute(operation)
    } catch (caught) {
      handleError(caught)
    } finally {
      busy.value = false
    }
  }

  async function resumePending(): Promise<void> {
    if (busy.value || pendingOperation.value === null) return
    busy.value = true
    error.value = null
    try {
      const operation = pendingOperation.value
      if (operation.state === 'expired') {
        error.value = {
          code: 'MANUAL_REVIEW_REQUIRED',
          message: '本次兑换需要管理员核对',
          requestId: '',
          retryable: false,
        }
      } else if (operation.state === 'preparing') {
        await prepareAndExecute(operation)
      } else {
        await executePrepared(operation)
      }
    } finally {
      busy.value = false
    }
  }

  function clearHistory(): void {
    if (storage.clearHistory()) conversionHistory.value = []
    else failStorage()
  }

  return {
    session,
    profile,
    result,
    pending,
    pendingOperation,
    history: conversionHistory,
    error,
    loading,
    busy,
    initialize,
    refresh,
    logout,
    convert,
    resumePending,
    clearHistory,
  }
}

let singleton: ConversionController | null = null

export function useConversion(): ConversionController {
  singleton ??= createUseConversion(apiClient)
  return singleton
}
