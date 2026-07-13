import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'

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

const SESSION_SECRET = 'e2e-session-secret-00000000000000000001'
const OPERATION_SECRET = 'e2e-operation-secret-00000000000000002'

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

async function startTestEnvironment(): Promise<TestEnvironment & { close(): Promise<void> }> {
  const mock = await startMockSub2Api()
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const config: Readonly<AppConfig> = Object.freeze({
    nodeEnv: 'production',
    port,
    sub2apiBaseUrl: mock.origin,
    sub2apiAdminApiKey: mockAdminApiKey,
    appOrigin: origin,
    sub2apiOrigin: mock.origin,
    sessionSecret: SESSION_SECRET,
    operationSigningSecret: OPERATION_SECRET,
    operationTtlMinutes: 60,
    upstreamTimeoutMs: 250,
    trustProxy: false,
    logLevel: 'silent',
    cookieSecure: false,
  })
  const app = buildApp(config, { webRoot: resolve('dist/web') })
  const iframeChild = childUrl(origin, mock.userToken, {
    user_id: '7',
    theme: 'dark',
    ui_mode: 'iframe',
    lang: 'zh-CN',
  })
  app.get('/e2e-parent', async (_request, reply) => reply
    .type('text/html; charset=utf-8')
    .send(`<!doctype html><html><body style="margin:0"><iframe id="tool-frame" title="余额兑换工具" src="${iframeChild}" style="width:100%;height:780px;border:0"></iframe></body></html>`))

  try {
    await app.listen({ host: '127.0.0.1', port })
  } catch (error) {
    await mock.close()
    throw error
  }

  return {
    origin,
    mock,
    authenticatedUrl: (parameters = {}) => childUrl(origin, mock.userToken, parameters),
    iframeParentUrl: () => `${origin}/e2e-parent`,
    close: async () => {
      await app.close()
      await mock.close()
    },
  }
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
