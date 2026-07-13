// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserCoordinator, CONVERSION_LOCK_NAME } from '../../src/web/coordinator.js'

describe('browser conversion coordinator', () => {
  afterEach(() => vi.restoreAllMocks())

  it('runs work under the fixed exclusive lock when it is available', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockImplementation(async (name, options, callback) => {
      expect(name).toBe(CONVERSION_LOCK_NAME)
      expect(options).toEqual({ mode: 'exclusive', ifAvailable: true })
      return callback({ name, mode: 'exclusive' })
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })

    await expect(browserCoordinator.runExclusive(work)).resolves.toBe('acquired')
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('returns busy immediately without running work when the lock is occupied', async () => {
    const work = vi.fn()
    const request = vi.fn().mockImplementation(async (_name, _options, callback) => callback(null))
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })

    await expect(browserCoordinator.runExclusive(work)).resolves.toBe('busy')
    expect(work).not.toHaveBeenCalled()
  })

  it('fails closed when Web Locks is unavailable', async () => {
    const work = vi.fn()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })

    expect(browserCoordinator.isAvailable()).toBe(false)
    await expect(browserCoordinator.runExclusive(work)).resolves.toBe('unavailable')
    expect(work).not.toHaveBeenCalled()
  })
})
