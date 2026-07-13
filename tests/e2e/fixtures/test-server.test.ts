import { describe, expect, it, vi } from 'vitest'

import type { MockSub2Api } from './mock-sub2api.js'

interface FakeApp {
  listen(options: { host: string; port: number }): Promise<string>
  close(): Promise<void>
}

interface Candidate {
  app: FakeApp
  origin: string
  port: number
}

interface TestDependencies {
  startMock(): Promise<MockSub2Api>
  createCandidate(mock: MockSub2Api): Promise<Candidate>
  maxListenAttempts: number
}

type StartTestEnvironment = (dependencies: TestDependencies) => Promise<{ close(): Promise<void> }>

async function startFunction(): Promise<StartTestEnvironment> {
  const module = await import('./test-server.js')
  const start = (module as unknown as { startTestEnvironment?: StartTestEnvironment })
    .startTestEnvironment
  expect(start).toBeTypeOf('function')
  return start!
}

function fakeMock(close = vi.fn(async () => undefined)): MockSub2Api {
  return {
    origin: 'http://127.0.0.1:41001',
    userToken: 'test-token',
    setMode: vi.fn(),
    setIframeChildUrl: vi.fn(),
    totalSuccessfulDebits: vi.fn(() => 0),
    totalDeletedCodes: vi.fn(() => 0),
    close,
  }
}

function fakeCandidate(overrides: Partial<FakeApp> = {}, port = 41002): Candidate {
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    app: {
      listen: vi.fn(async () => `http://127.0.0.1:${port}`),
      close: vi.fn(async () => undefined),
      ...overrides,
    },
  }
}

describe('E2E test environment lifecycle', () => {
  it('closes the mock when candidate setup fails after the mock starts', async () => {
    const start = await startFunction()
    const setupError = new Error('candidate setup failed')
    const closeMock = vi.fn(async () => undefined)
    const mock = fakeMock(closeMock)

    await expect(start({
      startMock: vi.fn(async () => mock),
      createCandidate: vi.fn(async () => { throw setupError }),
      maxListenAttempts: 1,
    })).rejects.toBe(setupError)
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('closes both the failed app and mock when listen fails', async () => {
    const start = await startFunction()
    const listenError = Object.assign(new Error('listen failed'), { code: 'EACCES' })
    const closeApp = vi.fn(async () => undefined)
    const closeMock = vi.fn(async () => undefined)
    const candidate = fakeCandidate({
      listen: vi.fn(async () => { throw listenError }),
      close: closeApp,
    })

    await expect(start({
      startMock: vi.fn(async () => fakeMock(closeMock)),
      createCandidate: vi.fn(async () => candidate),
      maxListenAttempts: 1,
    })).rejects.toBe(listenError)
    expect(closeApp).toHaveBeenCalledOnce()
    expect(closeMock).toHaveBeenCalledOnce()
  })

  it('retries EADDRINUSE with a new candidate and closes the failed app', async () => {
    const start = await startFunction()
    const addressError = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' })
    const closeFirst = vi.fn(async () => undefined)
    const first = fakeCandidate({
      listen: vi.fn(async () => { throw addressError }),
      close: closeFirst,
    }, 41002)
    const second = fakeCandidate({}, 41003)
    const createCandidate = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const environment = await start({
      startMock: vi.fn(async () => fakeMock()),
      createCandidate,
      maxListenAttempts: 2,
    })

    expect(closeFirst).toHaveBeenCalledOnce()
    expect(createCandidate).toHaveBeenCalledTimes(2)
    await environment.close()
  })

  it('still closes the mock when app close fails and repeated close is idempotent', async () => {
    const start = await startFunction()
    const closeError = new Error('app close failed')
    const closeApp = vi.fn(() => { throw closeError }) as unknown as () => Promise<void>
    const closeMock = vi.fn(async () => undefined)
    const environment = await start({
      startMock: vi.fn(async () => fakeMock(closeMock)),
      createCandidate: vi.fn(async () => fakeCandidate({ close: closeApp })),
      maxListenAttempts: 1,
    })

    await expect(environment.close()).rejects.toBe(closeError)
    await expect(environment.close()).rejects.toBe(closeError)
    expect(closeApp).toHaveBeenCalledOnce()
    expect(closeMock).toHaveBeenCalledOnce()
  })
})
