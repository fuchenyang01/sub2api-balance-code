import { describe, expect, it } from 'vitest'

import { KeyedMutex } from '../../src/server/conversion/keyed-mutex.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('KeyedMutex', () => {
  it('runs work for the same key in strict FIFO order', async () => {
    const mutex = new KeyedMutex<string>()
    const gate = deferred()
    const events: string[] = []

    const first = mutex.run('user-1', async () => {
      events.push('a-start')
      await gate.promise
      events.push('a-end')
    })
    const second = mutex.run('user-1', async () => {
      events.push('b')
    })

    await Promise.resolve()
    expect(events).toEqual(['a-start'])
    gate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['a-start', 'a-end', 'b'])
  })

  it('allows different keys to run concurrently', async () => {
    const mutex = new KeyedMutex<string>()
    const gate = deferred()
    const events: string[] = []

    const first = mutex.run('user-1', async () => {
      events.push('a-start')
      await gate.promise
      events.push('a-end')
    })
    const second = mutex.run('user-2', async () => {
      events.push('b')
    })

    await second
    expect(events).toEqual(['a-start', 'b'])
    gate.resolve()
    await first
  })

  it('releases the next waiter when work rejects', async () => {
    const mutex = new KeyedMutex<string>()
    const expected = new Error('first failed')
    const events: string[] = []

    const first = mutex.run('user-1', async () => {
      events.push('first')
      throw expected
    })
    const second = mutex.run('user-1', async () => {
      events.push('second')
      return 'completed'
    })

    await expect(first).rejects.toBe(expected)
    await expect(second).resolves.toBe('completed')
    expect(events).toEqual(['first', 'second'])
  })

  it('cleans up keys after repeated success and failure', async () => {
    const mutex = new KeyedMutex<number>()

    for (let round = 0; round < 5; round += 1) {
      await Promise.all([
        mutex.run(1, async () => round),
        mutex.run(1, async () => round),
        mutex.run(2, async () => round),
      ])
      expect(mutex.pendingKeyCount).toBe(0)
    }

    await expect(
      mutex.run(3, async () => {
        throw new Error('failure')
      }),
    ).rejects.toThrow('failure')
    expect(mutex.pendingKeyCount).toBe(0)
  })

  it('passes through return values and synchronous throws from work', async () => {
    const mutex = new KeyedMutex<string>()
    const expected = new Error('synchronous failure')

    await expect(mutex.run('success', async () => ({ value: 42 }))).resolves.toEqual({ value: 42 })
    await expect(
      mutex.run('failure', () => {
        throw expected
      }),
    ).rejects.toBe(expected)
    expect(mutex.pendingKeyCount).toBe(0)
  })
})
