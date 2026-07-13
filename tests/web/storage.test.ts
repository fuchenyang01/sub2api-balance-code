// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import type { HistoryItem, PendingOperation } from '../../src/shared/storage-types.js'
import {
  HISTORY_KEY,
  PENDING_KEY,
  clearHistory,
  loadHistory,
  loadPending,
  saveHistory,
  savePending,
} from '../../src/web/storage.js'

function historyItem(index: number): HistoryItem {
  return {
    version: 1,
    operation_id: String(index),
    amount: `${index + 1}`,
    code: `CODE-${index}`,
    created_at: `2026-07-13T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }
}

describe('versioned local storage', () => {
  beforeEach(() => localStorage.clear())

  it('removes pending data with an unsupported version', () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      version: 2,
      operation_id: 'op-old',
      amount: '1',
      state: 'preparing',
    }))

    expect(loadPending()).toBeNull()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('removes history with an unsupported version', () => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{ ...historyItem(1), version: 2 }]))

    expect(loadHistory()).toEqual([])
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull()
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
      { version: 1, operation_id: 'op-preparing', amount: '1', state: 'preparing' },
      {
        version: 1,
        operation_id: 'op-ready',
        amount: '2',
        state: 'ready',
        operation_token: 'ready-secret',
        expires_at: '2099-07-13T01:00:00.000Z',
      },
      {
        version: 1,
        operation_id: 'op-pending',
        amount: '3',
        state: 'pending',
        operation_token: 'pending-secret',
        expires_at: '2099-07-13T01:00:00.000Z',
      },
      {
        version: 1,
        operation_id: 'op-expired',
        amount: '4',
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

  it('deduplicates history by operation ID and keeps the newest occurrence', () => {
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

  it('clears history only through the explicit clear operation', () => {
    expect(saveHistory([historyItem(1)])).toBe(true)
    expect(clearHistory()).toBe(true)
    expect(loadHistory()).toEqual([])
  })
})
