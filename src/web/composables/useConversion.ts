import { Decimal } from 'decimal.js'
import { ref, type Ref } from 'vue'

import type { ErrorCode, ExecuteResponse, MeResponse } from '../../shared/contracts.js'
import type { ExecutableOperation, HistoryItem, PendingOperation } from '../../shared/storage-types.js'
import { ApiClientError, apiClient, type ConversionApi } from '../api.js'
import { browserCoordinator, type ConversionCoordinator } from '../coordinator.js'
import { calculateTotalAmount, normalizeCount } from '../conversion-input.js'
import { browserStorage, type ConversionStorage } from '../storage.js'

type CompletedResult = Extract<ExecuteResponse, { status: 'completed' }>
type PendingResult = Extract<ExecuteResponse, { status: 'pending' }>
export type SessionState = 'loading' | 'authenticated' | 'unauthorized' | 'expired' | 'error'

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
  storageReady: Ref<boolean>
  initialize(): Promise<void>
  refresh(): Promise<void>
  logout(): Promise<void>
  convert(amount: string, count?: number): Promise<void>
  resumePending(): Promise<void>
  clearHistory(): void
}

const sessionCodes = new Set<ErrorCode>(['SESSION_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED'])
const accessCodes = new Set<ErrorCode>(['REDEEM_ACCESS_DENIED'])
const retryableCodes = new Set<ErrorCode>([
  'RATE_LIMITED',
  'CONVERSION_IN_PROGRESS',
  'CONVERSION_PENDING',
  'UPSTREAM_IDEMPOTENCY_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
])
const deterministicPrepareCodes = new Set<ErrorCode>([
  'AMOUNT_INVALID',
  'AMOUNT_EXCEEDS_BALANCE',
])
const manualReviewExecuteCodes = new Set<ErrorCode>([
  'OPERATION_TOKEN_INVALID',
  'UPSTREAM_AUTH_FAILED',
  'UPSTREAM_DATA_CONFLICT',
  'MANUAL_REVIEW_REQUIRED',
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

function storedCount(operation: PendingOperation): number {
  return operation.count ?? 1
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

function coordinationFailure(): ConversionError {
  return {
    code: 'MANUAL_REVIEW_REQUIRED',
    message: '当前浏览器无法安全协调兑换操作',
    requestId: '',
    retryable: false,
  }
}

function conversionInProgress(): ConversionError {
  return {
    code: 'CONVERSION_IN_PROGRESS',
    message: '另一个页面正在处理兑换',
    requestId: '',
    retryable: true,
  }
}

function isExpired(operation: ExecutableOperation): boolean {
  return Date.parse(operation.expires_at) <= Date.now()
}

export function createUseConversion(
  api: ConversionApi,
  storage: ConversionStorage = browserStorage,
  coordinator: ConversionCoordinator = browserCoordinator,
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
  const storageReady = ref(false)
  let initialization: Promise<void> | null = null
  let pendingExchangeToken: string | null = null
  let safetyFailureActive = false

  function failStorage(): void {
    storageReady.value = false
    safetyFailureActive = true
    error.value = storageFailure()
  }

  function failCoordination(): void {
    storageReady.value = false
    safetyFailureActive = true
    error.value = coordinationFailure()
  }

  function failCoordinationBusy(): void {
    storageReady.value = false
    safetyFailureActive = true
    error.value = conversionInProgress()
  }

  function markStorageReady(): void {
    storageReady.value = true
    safetyFailureActive = false
  }

  function persistPending(value: PendingOperation): boolean {
    if (!storage.savePending(value)) {
      failStorage()
      return false
    }
    pendingOperation.value = value
    return true
  }

  function clearPendingRecovery(): boolean {
    if (!storage.clearPending()) {
      failStorage()
      return false
    }
    pendingOperation.value = null
    return true
  }

  function toManualReview(value: ExecutableOperation): PendingOperation {
    return {
      version: 2,
      operation_id: value.operation_id,
      amount: value.amount,
      count: storedCount(value),
      state: 'expired',
      expires_at: value.expires_at,
    }
  }

  function expirePending(value: ExecutableOperation): void {
    const expired = toManualReview(value)
    pendingOperation.value = expired
    if (!storage.savePending(expired)) {
      if (storage.clearPending()) storage.savePending(expired)
      failStorage()
      return
    }
    error.value = {
      code: 'MANUAL_REVIEW_REQUIRED',
      message: '本次兑换需要管理员核对',
      requestId: '',
      retryable: false,
    }
  }

  async function hydrateLocalState(): Promise<void> {
    try {
      conversionHistory.value = storage.loadHistory()
      const stored = storage.loadPending()
      pendingOperation.value = stored
      if (!coordinator.isAvailable()) {
        failCoordination()
        return
      }
      if (stored !== null && (stored.state === 'ready' || stored.state === 'pending') && isExpired(stored)) {
        const coordination = await coordinator.runExclusive(async () => {
          const shared = loadSharedPending()
          if (shared === undefined
            || shared === null
            || shared.operation_id !== stored.operation_id) return
          if ((shared.state === 'ready' || shared.state === 'pending') && isExpired(shared)) {
            expirePending(shared)
          }
        })
        if (coordination === 'busy') failCoordinationBusy()
        else if (coordination === 'unavailable') failCoordination()
        return
      }
      markStorageReady()
    } catch {
      pendingOperation.value = null
      failStorage()
    }
  }

  function loadSharedPending(): PendingOperation | null | undefined {
    try {
      const stored = storage.loadPending()
      pendingOperation.value = stored
      markStorageReady()
      return stored
    } catch {
      failStorage()
      return undefined
    }
  }

  function clearCompletedPending(operationId: string): boolean {
    const stored = loadSharedPending()
    if (stored === undefined) return false
    if (stored === null || stored.operation_id !== operationId) {
      error.value = {
        code: 'MANUAL_REVIEW_REQUIRED',
        message: '共享恢复状态已变更，请管理员核对',
        requestId: '',
        retryable: false,
      }
      return false
    }
    return clearPendingRecovery()
  }

  async function loadProfile(): Promise<void> {
    profile.value = await api.me()
    session.value = 'authenticated'
  }

  function handleError(caught: unknown): void {
    const safeError = toConversionError(caught)
    if (accessCodes.has(safeError.code)) {
      session.value = 'unauthorized'
      profile.value = null
    } else if (sessionCodes.has(safeError.code)) {
      pendingExchangeToken = null
      session.value = 'expired'
      profile.value = null
    } else if (session.value === 'loading') {
      session.value = 'error'
    }
    if (!safetyFailureActive) error.value = safeError
  }

  async function refreshProfileAfterCompletion(): Promise<void> {
    try {
      await loadProfile()
    } catch (caught) {
      handleError(caught)
    }
  }

  function initialize(): Promise<void> {
    if (initialization !== null) return initialization
    initialization = (async () => {
      loading.value = true
      error.value = null
      await hydrateLocalState()
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
      await hydrateLocalState()
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
    const items = response.codes.map((entry, index): HistoryItem => ({
      version: 2,
      history_id: `${response.operation_id}:${index + 1}`,
      operation_id: response.operation_id,
      batch_index: index + 1,
      batch_size: response.count,
      amount: response.amount,
      code: entry.code,
      created_at: entry.created_at,
    }))
    let currentHistory: HistoryItem[]
    try {
      currentHistory = storage.loadHistory()
      markStorageReady()
    } catch {
      failStorage()
      return false
    }
    const chronological = [...currentHistory].reverse()
    chronological.push(...items)
    if (!storage.saveHistory(chronological)) {
      failStorage()
      return false
    }
    const newIds = new Set(items.map(({ history_id }) => history_id))
    conversionHistory.value = [
      ...items.reverse(),
      ...currentHistory.filter((entry) => !newIds.has(entry.history_id)),
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
        const count = storedCount(operation)
        if (response.count !== count) throw conversionConflict()
        if (!amountsEqual(response.total_amount, calculateTotalAmount(operation.amount, count))) {
          throw conversionConflict()
        }
        if (!publishHistory(response)) return
        if (!clearCompletedPending(operation.operation_id)) return
        result.value = response
        pending.value = null
        await refreshProfileAfterCompletion()
      } else {
        if (response.error === 'MANUAL_REVIEW_REQUIRED') {
          expirePending(operation)
          pending.value = null
          result.value = null
          return
        }
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
      if (caught instanceof ApiClientError) {
        if (caught.code === 'OPERATION_TERMINATED') {
          pendingOperation.value = toManualReview(operation)
          if (clearPendingRecovery()) handleError(caught)
          return
        }
        if (caught.code === 'OPERATION_TOKEN_EXPIRED' || manualReviewExecuteCodes.has(caught.code)) {
          expirePending(operation)
          return
        }
      }
      if (!(caught instanceof ApiClientError) || retryableCodes.has(caught.code)) {
        if (!persistPending({ ...operation, state: 'pending' })) return
      }
      handleError(caught)
    }
  }

  async function prepareAndExecute(operation: Extract<PendingOperation, { state: 'preparing' }>): Promise<void> {
    try {
      const prepared = await api.prepare({
        operation_id: operation.operation_id,
        amount: operation.amount,
        count: storedCount(operation),
      })
      if (!amountsEqual(prepared.amount, operation.amount)) throw conversionConflict()
      const count = storedCount(operation)
      if (prepared.count !== count) throw conversionConflict()
      if (!amountsEqual(prepared.total_amount, calculateTotalAmount(operation.amount, count))) {
        throw conversionConflict()
      }
      const ready: ExecutableOperation = {
        version: 2,
        operation_id: operation.operation_id,
        amount: operation.amount,
        count,
        state: 'ready',
        operation_token: prepared.operation_token,
        expires_at: prepared.expires_at,
      }
      if (!persistPending(ready)) return
      await executePrepared(ready)
    } catch (caught) {
      if (caught instanceof ApiClientError && deterministicPrepareCodes.has(caught.code)) {
        if (clearPendingRecovery()) handleError(caught)
        return
      }
      handleError(caught)
    }
  }

  async function convert(rawAmount: string, rawCount = 1): Promise<void> {
    if (busy.value || safetyFailureActive || pendingOperation.value?.state === 'expired') return
    busy.value = true
    error.value = null
    try {
      const coordination = await coordinator.runExclusive(async () => {
        const shared = loadSharedPending()
        if (shared === undefined) return
        if (shared !== null) {
          if ((shared.state === 'ready' || shared.state === 'pending') && isExpired(shared)) {
            expirePending(shared)
          } else {
            error.value = conversionInProgress()
          }
          return
        }
        const amount = normalizeAmount(rawAmount)
        const count = normalizeCount(String(rawCount))
        const operationId = crypto.randomUUID()
        const operation: PendingOperation = {
          version: 2,
          operation_id: operationId,
          amount,
          count,
          state: 'preparing',
        }
        if (!persistPending(operation)) return
        result.value = null
        pending.value = null
        await prepareAndExecute(operation)
      })
      if (coordination === 'busy') error.value = conversionInProgress()
      else if (coordination === 'unavailable') failCoordination()
    } catch (caught) {
      handleError(caught)
    } finally {
      busy.value = false
    }
  }

  async function resumePending(): Promise<void> {
    if (busy.value || safetyFailureActive || pendingOperation.value?.state === 'expired') return
    busy.value = true
    try {
      const coordination = await coordinator.runExclusive(async () => {
        const operation = loadSharedPending()
        if (operation === undefined || operation === null || operation.state === 'expired') return
        error.value = null
        result.value = null
        pending.value = null
        if ((operation.state === 'ready' || operation.state === 'pending') && isExpired(operation)) {
          expirePending(operation)
        } else if (operation.state === 'preparing') {
          await prepareAndExecute(operation)
        } else {
          if (!persistPending(operation)) return
          await executePrepared(operation)
        }
      })
      if (coordination === 'busy') error.value = conversionInProgress()
      else if (coordination === 'unavailable') failCoordination()
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
    storageReady,
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
