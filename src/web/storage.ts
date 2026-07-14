import type { HistoryItem, PendingOperation } from '../shared/storage-types.js'
import { MAX_BATCH_COUNT, MIN_BATCH_COUNT } from '../shared/contracts.js'

export const PENDING_KEY = 'sub2api-code:pending:v1'
export const HISTORY_KEY = 'sub2api-code:history:v1'

const HISTORY_LIMIT = 100

export class StorageAccessError extends Error {
  constructor() {
    super('Local storage is unavailable')
    this.name = 'StorageAccessError'
  }
}

export interface ConversionStorage {
  loadPending(): PendingOperation | null
  savePending(pending: PendingOperation): boolean
  clearPending(): boolean
  loadHistory(): HistoryItem[]
  saveHistory(history: HistoryItem[]): boolean
  clearHistory(): boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maxLength
}

function isPositiveAmount(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d+(?:\.\d+)?$/.test(value)
    && /[1-9]/.test(value)
}

function isDate(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value))
}

function isBatchCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_BATCH_COUNT
    && value <= MAX_BATCH_COUNT
}

function parsePending(value: unknown): PendingOperation | null {
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || !isNonEmptyString(value.operation_id)
    || !isPositiveAmount(value.amount)
    || typeof value.state !== 'string') return null

  const count = value.version === 1 ? 1 : value.count
  if (!isBatchCount(count)) return null
  const commonKeys = value.version === 1
    ? ['version', 'operation_id', 'amount', 'state']
    : ['version', 'operation_id', 'amount', 'count', 'state']

  if (value.state === 'preparing') {
    if (!hasOnlyKeys(value, commonKeys)) return null
    return {
      version: 2,
      operation_id: value.operation_id,
      amount: value.amount,
      count,
      state: 'preparing',
    }
  }

  if (value.state === 'ready' || value.state === 'pending') {
    if (!hasOnlyKeys(value, [...commonKeys, 'operation_token', 'expires_at'])
      || !isNonEmptyString(value.operation_token)
      || !isDate(value.expires_at)) return null
    return {
      version: 2,
      operation_id: value.operation_id,
      amount: value.amount,
      count,
      state: value.state,
      operation_token: value.operation_token,
      expires_at: value.expires_at,
    }
  }

  if (value.state === 'expired') {
    if (!hasOnlyKeys(value, [...commonKeys, 'expires_at']) || !isDate(value.expires_at)) return null
    return {
      version: 2,
      operation_id: value.operation_id,
      amount: value.amount,
      count,
      state: 'expired',
      expires_at: value.expires_at,
    }
  }

  return null
}

function parseHistoryItem(value: unknown): HistoryItem | null {
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || !isNonEmptyString(value.operation_id)
    || !isPositiveAmount(value.amount)
    || !isNonEmptyString(value.code)
    || !isBoundedString(value.created_at, 128)) return null

  if (value.version === 1) {
    if (!hasOnlyKeys(value, ['version', 'operation_id', 'amount', 'code', 'created_at'])) return null
    return {
      version: 2,
      history_id: value.operation_id,
      operation_id: value.operation_id,
      batch_index: 1,
      batch_size: 1,
      amount: value.amount,
      code: value.code,
      created_at: value.created_at,
    }
  }

  if (!hasOnlyKeys(value, [
    'version',
    'history_id',
    'operation_id',
    'batch_index',
    'batch_size',
    'amount',
    'code',
    'created_at',
  ])
    || !isNonEmptyString(value.history_id)
    || !isBatchCount(value.batch_size)
    || typeof value.batch_index !== 'number'
    || !Number.isSafeInteger(value.batch_index)
    || value.batch_index < 1
    || value.batch_index > value.batch_size) return null

  const batchHistoryId = `${value.operation_id}:${value.batch_index}`
  const legacyHistoryId = value.batch_index === 1
    && value.batch_size === 1
    && value.history_id === value.operation_id
  if (value.history_id !== batchHistoryId && !legacyHistoryId) return null

  return {
    version: 2,
    history_id: value.history_id,
    operation_id: value.operation_id,
    batch_index: value.batch_index,
    batch_size: value.batch_size,
    amount: value.amount,
    code: value.code,
    created_at: value.created_at,
  }
}

function remove(key: string): boolean {
  try {
    localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

function read(key: string): unknown | undefined {
  let stored: string | null
  try {
    stored = localStorage.getItem(key)
  } catch {
    throw new StorageAccessError()
  }
  if (stored === null) return undefined
  try {
    return JSON.parse(stored)
  } catch {
    if (!remove(key)) throw new StorageAccessError()
    return undefined
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function loadPending(): PendingOperation | null {
  const raw = read(PENDING_KEY)
  if (raw === undefined) return null
  const pending = parsePending(raw)
  if (pending === null && !remove(PENDING_KEY)) throw new StorageAccessError()
  if (pending !== null && JSON.stringify(pending) !== JSON.stringify(raw)) write(PENDING_KEY, pending)
  return pending
}

export function savePending(pending: PendingOperation): boolean {
  const safe = parsePending(pending)
  return safe !== null && write(PENDING_KEY, safe)
}

export function clearPending(): boolean {
  return remove(PENDING_KEY)
}

function normalizeStoredHistory(raw: unknown): HistoryItem[] | null {
  if (!Array.isArray(raw)) return null
  const result: HistoryItem[] = []
  const historyIds = new Set<string>()
  for (const value of raw) {
    const item = parseHistoryItem(value)
    if (item === null) return null
    if (historyIds.has(item.history_id)) continue
    historyIds.add(item.history_id)
    result.push(item)
    if (result.length === HISTORY_LIMIT) break
  }
  return result
}

export function loadHistory(): HistoryItem[] {
  const raw = read(HISTORY_KEY)
  if (raw === undefined) return []
  const history = normalizeStoredHistory(raw)
  if (history === null) {
    if (!remove(HISTORY_KEY)) throw new StorageAccessError()
    return []
  }
  if (JSON.stringify(history) !== JSON.stringify(raw)) write(HISTORY_KEY, history)
  return history
}

export function saveHistory(history: HistoryItem[]): boolean {
  const newestFirst: HistoryItem[] = []
  const historyIds = new Set<string>()
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = parseHistoryItem(history[index])
    if (item === null) return false
    if (historyIds.has(item.history_id)) continue
    historyIds.add(item.history_id)
    newestFirst.push(item)
    if (newestFirst.length === HISTORY_LIMIT) break
  }
  return write(HISTORY_KEY, newestFirst)
}

export function clearHistory(): boolean {
  return remove(HISTORY_KEY)
}

export const browserStorage: ConversionStorage = {
  loadPending,
  savePending,
  clearPending,
  loadHistory,
  saveHistory,
  clearHistory,
}
