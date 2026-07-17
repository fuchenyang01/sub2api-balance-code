import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test as base } from '@playwright/test'

import { buildApp } from '../../../src/server/app.js'
import type { AppConfig } from '../../../src/server/config.js'
import {
  mockAdminApiKey,
  startMockSub2Api,
  type MockSub2Api,
} from './mock-sub2api.js'

export interface TestEnvironment {
  readonly origin: string
  readonly mock: MockSub2Api
  authenticatedUrl(parameters?: Record<string, string>): string
  iframeParentUrl(): string
}

export interface TestAppCandidate {
  app: {
    listen(options: { host: string; port: number }): Promise<string>
    close(): Promise<void>
  }
  origin: string
  port: number
}

export interface TestServerDependencies {
  startMock(): Promise<MockSub2Api>
  createCandidate(mock: MockSub2Api): Promise<TestAppCandidate>
  maxListenAttempts: number
}

const SESSION_SECRET = 'e2e-session-secret-00000000000000000001'
const OPERATION_SECRET = 'e2e-operation-secret-00000000000000002'
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

async function availablePort(): Promise<number> {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>((resolveClose, reject) => {
    reservation.close((error) => (error === undefined ? resolveClose() : reject(error)))
  })
  return port
}

function childUrl(origin: string, token: string, parameters: Record<string, string> = {}): string {
  const url = new URL('/', origin)
  url.searchParams.set('token', token)
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
  return url.toString()
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'EADDRINUSE'
}

async function cleanup(resources: Array<{ close(): Promise<void> }>): Promise<unknown[]> {
  const settled = await Promise.allSettled(resources.map(async (resource) => resource.close()))
  return settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
}

function throwFailure(primary: unknown, cleanupErrors: unknown[]): never {
  if (cleanupErrors.length === 0) throw primary
  throw new AggregateError([primary, ...cleanupErrors], 'E2E environment setup and cleanup failed', {
    cause: primary,
  })
}

function idempotentClose(resources: Array<{ close(): Promise<void> }>): () => Promise<void> {
  let closing: Promise<void> | null = null
  return () => {
    closing ??= (async () => {
      const errors = await cleanup(resources)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'E2E environment cleanup failed')
    })()
    return closing
  }
}

async function createDefaultCandidate(mock: MockSub2Api): Promise<TestAppCandidate> {
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const config: Readonly<AppConfig> = Object.freeze({
    nodeEnv: 'production',
    port,
    sub2apiBaseUrl: mock.origin,
    sub2apiAdminApiKey: mockAdminApiKey,
    redeemAllowedGroupId: 24,
    appOrigin: origin,
    sub2apiOrigin: mock.origin,
    sub2apiEntryUrl: `${mock.origin}/custom/balance-code`,
    sessionSecret: SESSION_SECRET,
    operationSigningSecret: OPERATION_SECRET,
    operationTtlMinutes: 60,
    upstreamTimeoutMs: 1_000,
    trustProxy: false,
    logLevel: 'silent',
    cookieSecure: false,
  })
  return {
    app: buildApp(config, { webRoot: resolve(REPOSITORY_ROOT, 'dist/web') }),
    origin,
    port,
  }
}

const defaultDependencies: TestServerDependencies = {
  startMock: startMockSub2Api,
  createCandidate: createDefaultCandidate,
  maxListenAttempts: 3,
}

export async function startTestEnvironment(
  dependencies: TestServerDependencies = defaultDependencies,
): Promise<TestEnvironment & { close(): Promise<void> }> {
  const mock = await dependencies.startMock()

  for (let attempt = 1; attempt <= dependencies.maxListenAttempts; attempt += 1) {
    let candidate: TestAppCandidate
    try {
      candidate = await dependencies.createCandidate(mock)
    } catch (error) {
      throwFailure(error, await cleanup([mock]))
    }

    try {
      await candidate.app.listen({ host: '127.0.0.1', port: candidate.port })
    } catch (error) {
      const appCleanupErrors = await cleanup([candidate.app])
      if (isAddressInUse(error)
        && attempt < dependencies.maxListenAttempts
        && appCleanupErrors.length === 0) continue
      const mockCleanupErrors = await cleanup([mock])
      throwFailure(error, [...appCleanupErrors, ...mockCleanupErrors])
    }

    try {
      mock.setIframeChildUrl(childUrl(candidate.origin, mock.userToken, {
        user_id: '7',
        theme: 'dark',
        ui_mode: 'iframe',
        lang: 'zh-CN',
      }))
    } catch (error) {
      throwFailure(error, await cleanup([candidate.app, mock]))
    }

    return {
      origin: candidate.origin,
      mock,
      authenticatedUrl: (parameters = {}) => childUrl(
        candidate.origin,
        mock.userToken,
        parameters,
      ),
      iframeParentUrl: () => `${mock.origin}/e2e-parent`,
      close: idempotentClose([candidate.app, mock]),
    }
  }

  throw new Error('unreachable E2E listen retry state')
}

export const test = base.extend<{ environment: TestEnvironment }>({
  environment: async ({}, use) => {
    const environment = await startTestEnvironment()
    try {
      await use(environment)
    } finally {
      await environment.close()
    }
  },
})

export { expect } from '@playwright/test'
