// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HistoryItem, PendingOperation } from '../../src/shared/storage-types.js'
import {
  HISTORY_KEY,
  PENDING_KEY,
  clearHistory,
  loadHistory,
  loadPending,
  saveHistory,
  savePending,
  StorageAccessError,
} from '../../src/web/storage.js'

function historyItem(index: number): HistoryItem {
  return {
    version: 2,
    history_id: String(index),
    operation_id: String(index),
    batch_index: 1,
    batch_size: 1,
    amount: `${index + 1}`,
    code: `CODE-${index}`,
    created_at: `2026-07-13T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }
}

function batchHistory(operationId: string, index: number, size: number): HistoryItem {
  return {
    version: 2,
    history_id: `${operationId}:${index}`,
    operation_id: operationId,
    batch_index: index,
    batch_size: size,
    amount: '2',
    code: `CODE-${index}`,
    created_at: '2026-07-14T00:00:00.000Z',
  }
}

describe('versioned local storage', () => {
  beforeEach(() => localStorage.clear())

  it('removes pending data with an unsupported version', () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      version: 3,
      operation_id: 'op-old',
      amount: '1',
      state: 'preparing',
    }))

    expect(loadPending()).toBeNull()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('removes history with an unsupported version', () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{ ...historyItem(1), version: 3 }]))

    expect(loadHistory()).toEqual([])
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull()
  })

  it('migrates a version 1 pending operation to count one', () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      version: 1,
      operation_id: 'op-old',
      amount: '2',
      state: 'preparing',
    }))

    expect(loadPending()).toEqual({
      version: 2,
      operation_id: 'op-old',
      amount: '2',
      count: 1,
      state: 'preparing',
    })
  })

  it('migrates version 1 history without deleting codes', () => {
    const createdAt = '2026-07-13T00:00:00.000Z'
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{
      version: 1,
      operation_id: 'op-old',
      amount: '2',
      code: 'OLD-CODE',
      created_at: createdAt,
    }]))

    expect(loadHistory()).toEqual([{
      version: 2,
      history_id: 'op-old',
      operation_id: 'op-old',
      batch_index: 1,
      batch_size: 1,
      amount: '2',
      code: 'OLD-CODE',
      created_at: createdAt,
    }])
  })

  it.each([
    ['pending', PENDING_KEY, () => loadPending(), null],
    ['history', HISTORY_KEY, () => loadHistory(), []],
  ] as const)('removes damaged %s JSON', (_name, key, load, empty) => {
    localStorage.setItem(key, '{not-json')

    expect(load()).toEqual(empty)
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('removes malformed pending records, including invalid expiry dates and extra fields', () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      version: 1,
      operation_id: 'op-ready',
      amount: '1',
      state: 'ready',
      operation_token: 'operation-secret',
      expires_at: 'not-a-date',
      jwt: 'must-not-survive',
    }))

    expect(loadPending()).toBeNull()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('round-trips each valid pending state without adding sensitive fields', () => {
    const states: PendingOperation[] = [
      { version: 2, operation_id: 'op-preparing', amount: '1', count: 1, state: 'preparing' },
      {
        version: 2,
        operation_id: 'op-ready',
        amount: '2',
        count: 10,
        state: 'ready',
        operation_token: 'ready-secret',
        expires_at: '2099-07-13T01:00:00.000Z',
      },
      {
        version: 2,
        operation_id: 'op-pending',
        amount: '3',
        count: 100,
        state: 'pending',
        operation_token: 'pending-secret',
        expires_at: '2099-07-13T01:00:00.000Z',
      },
      {
        version: 2,
        operation_id: 'op-expired',
        amount: '4',
        count: 2,
        state: 'expired',
        expires_at: '2020-07-13T01:00:00.000Z',
      },
    ]

    for (const pending of states) {
      expect(savePending(pending)).toBe(true)
      expect(loadPending()).toEqual(pending)
    }
  })

  it('keeps the newest 100 history records and returns newest first', () => {
    expect(saveHistory(Array.from({ length: 101 }, (_, index) => historyItem(index)))).toBe(true)

    const history = loadHistory()
    expect(history).toHaveLength(100)
    expect(history[0]?.operation_id).toBe('100')
    expect(history.at(-1)?.operation_id).toBe('1')
  })

  it('deduplicates history by history ID and keeps the newest occurrence', () => {
    expect(saveHistory([
      historyItem(1),
      { ...historyItem(1), code: 'CODE-LATEST' },
      historyItem(2),
    ])).toBe(true)

    expect(loadHistory()).toEqual([
      historyItem(2),
      { ...historyItem(1), code: 'CODE-LATEST' },
    ])
  })

  it('keeps every code from the same operation by history id', () => {
    expect(saveHistory([
      batchHistory('op-batch', 1, 3),
      batchHistory('op-batch', 2, 3),
      batchHistory('op-batch', 3, 3),
    ])).toBe(true)

    expect(loadHistory().map((item) => item.code)).toEqual(['CODE-3', 'CODE-2', 'CODE-1'])
  })

  it.each([
    ['invalid count', PENDING_KEY, { version: 2, operation_id: 'op', amount: '1', count: 101, state: 'preparing' }],
    ['batch index beyond size', HISTORY_KEY, [{ ...batchHistory('op', 2, 2), batch_index: 3 }]],
    ['mismatched history id', HISTORY_KEY, [{ ...batchHistory('op', 1, 2), history_id: 'other:1' }]],
    ['extra history field', HISTORY_KEY, [{ ...batchHistory('op', 1, 2), secret: 'remove-me' }]],
  ] as const)('removes stored data with %s', (_name, key, value) => {
    localStorage.setItem(key, JSON.stringify(value))

    if (key === PENDING_KEY) expect(loadPending()).toBeNull()
    else expect(loadHistory()).toEqual([])
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('keeps an unparseable created_at because history timestamps are display-only', () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([
      historyItem(1),
      { ...historyItem(2), created_at: 'not-a-date' },
    ]))

    expect(loadHistory()).toEqual([
      historyItem(1),
      { ...historyItem(2), created_at: 'not-a-date' },
    ])
  })

  it('accepts a parseable non-ISO history timestamp from the service contract', () => {
    const item = { ...historyItem(1), created_at: '2026-07-13 00:00:00' }

    expect(saveHistory([item])).toBe(true)
    expect(loadHistory()).toEqual([item])
  })

  it('accepts bounded upstream display timestamps and rejects empty or overlong values', () => {
    const upstream = { ...historyItem(1), created_at: 'upstream-time-value' }
    expect(saveHistory([upstream])).toBe(true)
    expect(loadHistory()).toEqual([upstream])

    expect(saveHistory([{ ...historyItem(2), created_at: '' }])).toBe(false)
    expect(saveHistory([{ ...historyItem(2), created_at: 'x'.repeat(129) }])).toBe(false)
  })

  it('throws a recognizable error when localStorage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    expect(() => loadPending()).toThrow(StorageAccessError)
  })

  it('clears history only through the explicit clear operation', () => {
    expect(saveHistory([historyItem(1)])).toBe(true)
    expect(clearHistory()).toBe(true)
    expect(loadHistory()).toEqual([])
  })
})
