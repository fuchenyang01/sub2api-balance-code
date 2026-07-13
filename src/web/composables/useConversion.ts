import { Decimal } from 'decimal.js'
import { ref, type Ref } from 'vue'

import type { ErrorCode, ExecuteResponse, MeResponse } from '../../shared/contracts.js'
import { ApiClientError, apiClient, type ConversionApi } from '../api.js'

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
  error: Ref<ConversionError | null>
  loading: Ref<boolean>
  busy: Ref<boolean>
  initialize(): Promise<void>
  refresh(): Promise<void>
  logout(): Promise<void>
  convert(amount: string): Promise<void>
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

export function createUseConversion(api: ConversionApi): ConversionController {
  const session = ref<SessionState>('loading')
  const profile = ref<MeResponse | null>(null)
  const result = ref<CompletedResult | null>(null)
  const pending = ref<PendingResult | null>(null)
  const error = ref<ConversionError | null>(null)
  const loading = ref(false)
  const busy = ref(false)
  let initialization: Promise<void> | null = null
  let pendingExchangeToken: string | null = null

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

  async function convert(rawAmount: string): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = null
    try {
      const amount = normalizeAmount(rawAmount)
      const operationId = crypto.randomUUID()
      const prepared = await api.prepare({ operation_id: operationId, amount })
      const response = await api.execute({ operation_token: prepared.operation_token })
      if (response.status === 'completed') {
        result.value = response
        pending.value = null
      } else {
        pending.value = {
          status: 'pending',
          operation_id: response.operation_id,
          error: response.error,
        }
        result.value = null
      }
    } catch (caught) {
      handleError(caught)
    } finally {
      busy.value = false
    }
  }

  return {
    session,
    profile,
    result,
    pending,
    error,
    loading,
    busy,
    initialize,
    refresh,
    logout,
    convert,
  }
}

let singleton: ConversionController | null = null

export function useConversion(): ConversionController {
  singleton ??= createUseConversion(apiClient)
  return singleton
}
