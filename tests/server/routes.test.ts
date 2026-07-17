import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp, type AppDependencies } from '../../src/server/app.js'
import type { AppConfig } from '../../src/server/config.js'
import type { ExecuteResponse, PrepareResponse } from '../../src/shared/contracts.js'
import { AppError } from '../../src/server/errors.js'
import { redactionPaths } from '../../src/server/security/redaction.js'
import { SecretsService } from '../../src/server/security/secrets.js'
import { UpstreamError } from '../../src/server/sub2api/http.js'
import type { Profile } from '../../src/server/sub2api/types.js'
import type { UserClient } from '../../src/server/sub2api/user-client.js'

const sessionSecret = 'session-secret-that-is-at-least-32-bytes'
const operationSecret = 'operation-secret-that-is-at-least-32-bytes'
const operationId = '123e4567-e89b-42d3-a456-426614174000'
const appOrigin = 'https://app.example.test'
const sub2apiOrigin = 'https://sub2api.example.test'

const config: Readonly<AppConfig> = Object.freeze({
  nodeEnv: 'test',
  port: 3000,
  sub2apiBaseUrl: 'https://api.example.test',
  sub2apiAdminApiKey: 'admin-SECRET-KEY',
  redeemAllowedGroupId: 24,
  appOrigin,
  sub2apiOrigin,
  sub2apiEntryUrl: `${sub2apiOrigin}/custom/balance-code`,
  sessionSecret,
  operationSigningSecret: operationSecret,
  operationTtlMinutes: 60,
  upstreamTimeoutMs: 1_000,
  trustProxy: false,
  logLevel: 'silent',
  cookieSecure: true,
})

const profile: Profile = {
  id: 7,
  username: 'alice',
  balance: 0,
  status: 'active',
  allowed_groups: [24],
}

function rawJwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
    JSON.stringify(payload),
  ).toString('base64url')}.signature`
}

function jwt(exp: number = Math.floor(Date.now() / 1_000) + 3_600): string {
  return rawJwt({ exp })
}

class FakeUsers implements UserClient {
  calls: string[] = []
  currentProfile: Profile = profile
  error: unknown

  async getProfile(userJwt: string): Promise<Profile> {
    this.calls.push(userJwt)
    if (this.error !== undefined) throw this.error
    return this.currentProfile
  }
}

class FakeConversions {
  prepareCalls: Array<[string, number, string, string, number]> = []
  executeCalls: Array<[string, string, number]> = []
  prepareError: unknown
  executeError: unknown
  executeResponse: ExecuteResponse = {
    status: 'completed',
    operation_id: operationId,
    amount: '12.5',
    count: 1,
    total_amount: '12.5',
    codes: [{ code: 'REDEEM-SECRET-CODE', created_at: '2026-07-13T00:00:00.000Z' }],
  }

  async prepare(
    userJwt: string,
    userId: number,
    requestedOperationId: string,
    amount: string,
    count: number,
  ): Promise<PrepareResponse> {
    this.prepareCalls.push([userJwt, userId, requestedOperationId, amount, count])
    if (this.prepareError !== undefined) throw this.prepareError
    return {
      operation_token: 'signed-operation-token',
      expires_at: '2026-07-13T01:00:00.000Z',
      amount,
      count,
      total_amount: amount,
    }
  }

  async execute(operationToken: string, userJwt: string, userId: number): Promise<ExecuteResponse> {
    this.executeCalls.push([operationToken, userJwt, userId])
    if (this.executeError !== undefined) throw this.executeError
    return this.executeResponse
  }
}

function secrets(now: () => Date = () => new Date()): SecretsService {
  return new SecretsService({
    sessionSecret,
    operationSigningSecret: operationSecret,
    operationTtlMinutes: 60,
    now,
  })
}

const apps: FastifyInstance[] = []
const temporaryRoots: string[] = []

async function setup(overrides: Partial<AppDependencies> = {}) {
  const users = new FakeUsers()
  const conversions = new FakeConversions()
  const app = buildApp(config, {
    users,
    conversions,
    secrets: secrets(),
    ...overrides,
  })
  apps.push(app)
  await app.ready()
  return { app, users, conversions }
}

async function exchange(app: FastifyInstance, userJwt = jwt(), url = '/api/session/exchange') {
  return app.inject({
    method: 'POST',
    url,
    headers: { origin: appOrigin },
    payload: { token: userJwt },
  })
}

async function cookieFor(app: FastifyInstance, userJwt = jwt()): Promise<string> {
  const response = await exchange(app, userJwt)
  expect(response.statusCode).toBe(200)
  const cookie = response.headers['set-cookie']
  expect(cookie).toBeTypeOf('string')
  return (cookie as string).split(';', 1)[0]!
}

function stableError(response: { json(): unknown }, code: string): void {
  const body = response.json() as Record<string, unknown>
  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String),
      request_id: expect.any(String),
    },
  })
  expect(JSON.stringify(body)).not.toMatch(/"(?:stack|cause|validation)"/i)
}

function expectClearedSessionCookie(value: string | string[] | undefined): void {
  expect(value).toBeTypeOf('string')
  const cookie = value as string
  expect(cookie).toMatch(/redeem_session=;/)
  expect(cookie).toMatch(/HttpOnly/i)
  expect(cookie).toMatch(/Secure/i)
  expect(cookie).toMatch(/SameSite=Lax/i)
  expect(cookie).toMatch(/Path=\//i)
  expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/i)
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('public config route', () => {
  it('exposes only the validated re-entry URL without requiring a session', async () => {
    const { app } = await setup()

    const response = await app.inject({ method: 'GET', url: '/api/config' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      sub2api_relogin_url:
        `${sub2apiOrigin}/balance-code-relogin?redirect=%2Fcustom%2Fbalance-code`,
    })
    expect(response.body).not.toContain(config.sub2apiAdminApiKey)
    expect(response.body).not.toContain(config.sessionSecret)
    expect(response.body).not.toContain(config.operationSigningSecret)
    expect(response.body).not.toContain(String(config.redeemAllowedGroupId))
  })
})

describe('session routes', () => {
  it('exchanges an upstream-verified JWT for a secure cookie and minimal zero-balance profile', async () => {
    const { app, users } = await setup()
    const exp = Math.floor(Date.now() / 1_000) + 3_600
    const userJwt = jwt(exp)

    const response = await exchange(app, userJwt, '/api/session/exchange?user_id=999&id=999')

    expect(response.statusCode).toBe(200)
    expect(users.calls).toEqual([userJwt])
    expect(response.json()).toEqual({ id: 7, username: 'alice', balance: '0' })
    expect(response.body).not.toContain(userJwt)
    expect(response.body).not.toContain('active')
    const setCookie = response.headers['set-cookie'] as string
    expect(setCookie).toContain('redeem_session=')
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).toMatch(/Path=\//i)
    expect(setCookie).toMatch(/Expires=/i)
    const cookieExpires = /Expires=([^;]+)/i.exec(setCookie)?.[1]
    expect(cookieExpires).toBeDefined()
    expect(Date.parse(cookieExpires!)).toBeLessThanOrEqual(exp * 1_000)

    const sealedSession = setCookie.split(';', 1)[0]!.slice('redeem_session='.length)
    const session = await secrets().unsealSession(sealedSession)
    expect(Date.parse(session.expiresAt)).toBeLessThanOrEqual(exp * 1_000)
    expect(session.expiresAt).toBe(new Date(exp * 1_000).toISOString())
  })

  it('denies session exchange when the verified profile lacks redemption access', async () => {
    const { app, users } = await setup()
    users.currentProfile = { ...profile, allowed_groups: [] }

    const response = await exchange(app)

    expect(response.statusCode).toBe(403)
    stableError(response, 'REDEEM_ACCESS_DENIED')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('rejects a JWT whose fully serialized session cookie exceeds 4096 bytes', async () => {
    const { app } = await setup()
    const largeJwt = rawJwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      padding: 'x'.repeat(2_800),
    })
    expect(Buffer.byteLength(largeJwt, 'utf8')).toBeLessThan(8_192)

    const response = await exchange(app, largeJwt)

    expect(response.statusCode).toBe(400)
    stableError(response, 'SESSION_INVALID')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).not.toContain(largeJwt)
  })

  it('rejects an exp whose year cannot be represented by a standard HTTP-date', async () => {
    const { app } = await setup()
    const extremeJwt = jwt(Date.UTC(10_000, 0, 1) / 1_000)

    const response = await exchange(app, extremeJwt)

    expect(response.statusCode).toBe(400)
    stableError(response, 'SESSION_INVALID')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).not.toContain(extremeJwt)
  })

  it('rejects malformed, missing-exp, unsafe-exp, and expired JWTs without leaking them', async () => {
    const { app } = await setup()
    const cases = [
      ['malformed.jwt', 'SESSION_INVALID'],
      [rawJwt({}), 'SESSION_INVALID'],
      [jwt(1.5), 'SESSION_INVALID'],
      [jwt(Math.floor(Date.now() / 1_000) - 1), 'SESSION_EXPIRED'],
    ] as const

    for (const [userJwt, code] of cases) {
      const response = await exchange(app, userJwt)
      expect(response.statusCode).toBe(401)
      stableError(response, code)
      expect(response.body).not.toContain(userJwt)
    }
  })

  it('classifies an upstream auth rejection with an expired exp as SESSION_EXPIRED', async () => {
    const { app, users } = await setup()
    users.error = new UpstreamError('auth', 'expired upstream token')
    const response = await exchange(app, jwt(Math.floor(Date.now() / 1_000) - 1))

    expect(response.statusCode).toBe(401)
    stableError(response, 'SESSION_EXPIRED')
  })

  it('requires a cookie for /api/me', async () => {
    const { app } = await setup()
    const response = await app.inject({ method: 'GET', url: '/api/me' })

    expect(response.statusCode).toBe(401)
    stableError(response, 'SESSION_REQUIRED')
  })

  it('uses only the verified profile identity despite forged query parameters', async () => {
    const { app, users } = await setup()
    const userJwt = jwt()
    const cookie = await cookieFor(app, userJwt)

    const response = await app.inject({
      method: 'GET',
      url: '/api/me?id=999&user_id=999',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: 7, username: 'alice', balance: '0' })
    expect(users.calls).toEqual([userJwt, userJwt])
  })

  it.each([
    ['tampered cookie', async (app: FastifyInstance) => `${await cookieFor(app)}tampered`, 'SESSION_INVALID'],
    [
      'expired cookie',
      async () => {
        const old = secrets(() => new Date('2020-01-01T00:00:00.000Z'))
        return `redeem_session=${await old.sealSession({
          userJwt: jwt(),
          userId: 7,
          expiresAt: new Date('2020-01-01T01:00:00.000Z'),
        })}`
      },
      'SESSION_EXPIRED',
    ],
  ] as const)('clears a %s', async (_label, makeCookie, code) => {
    const { app } = await setup()
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: await makeCookie(app) },
    })

    expect(response.statusCode).toBe(401)
    stableError(response, code)
    expectClearedSessionCookie(response.headers['set-cookie'])
  })

  it('rejects a profile ID mismatch and clears the cookie', async () => {
    const { app, users } = await setup()
    const cookie = await cookieFor(app)
    users.currentProfile = { ...profile, id: 8, allowed_groups: [] }

    const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })

    expect(response.statusCode).toBe(401)
    stableError(response, 'SESSION_INVALID')
    expectClearedSessionCookie(response.headers['set-cookie'])
  })

  it('denies /api/me after redemption access is revoked without clearing the cookie', async () => {
    const { app, users } = await setup()
    const cookie = await cookieFor(app)
    users.currentProfile = { ...profile, allowed_groups: [] }

    const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })

    expect(response.statusCode).toBe(403)
    stableError(response, 'REDEEM_ACCESS_DENIED')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('allows the same session cookie after redemption access is restored', async () => {
    const { app, users } = await setup()
    const cookie = await cookieFor(app)
    users.currentProfile = { ...profile, allowed_groups: [] }

    const denied = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(denied.statusCode).toBe(403)
    stableError(denied, 'REDEEM_ACCESS_DENIED')

    users.currentProfile = { ...profile, allowed_groups: [24] }
    const restored = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })

    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toEqual({ id: 7, username: 'alice', balance: '0' })
  })

  it.each([
    [new UpstreamError('auth', 'upstream echoed SECRET-JWT'), 'SESSION_EXPIRED', 401],
    [new UpstreamError('network', 'upstream echoed SECRET-JWT'), 'UPSTREAM_UNAVAILABLE', 502],
  ] as const)('maps upstream profile failures safely', async (error, code, status) => {
    const { app, users } = await setup()
    const cookie = await cookieFor(app)
    users.error = error

    const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })

    expect(response.statusCode).toBe(status)
    stableError(response, code)
    expect(response.body).not.toContain('SECRET-JWT')
    if (code === 'SESSION_EXPIRED') {
      expectClearedSessionCookie(response.headers['set-cookie'])
    } else {
      expect(response.headers['set-cookie']).toBeUndefined()
    }
  })

  it('logout clears only the server session cookie', async () => {
    const { app } = await setup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/logout',
      headers: { origin: appOrigin },
    })

    expect(response.statusCode).toBe(204)
    expectClearedSessionCookie(response.headers['set-cookie'])
  })
})

describe('origin and schemas', () => {
  it.each([appOrigin, sub2apiOrigin])('accepts the exact allowed origin %s', async (origin) => {
    const { app } = await setup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/exchange',
      headers: { origin },
      payload: { token: jwt() },
    })
    expect(response.statusCode).toBe(200)
  })

  it.each([undefined, 'null', 'not a url', `${appOrigin}.evil.test`, `${appOrigin}/path`, 'https://user@example.test']) (
    'rejects missing or unsafe origin %s',
    async (origin) => {
      const { app } = await setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/session/exchange',
        headers: origin === undefined ? {} : { origin },
        payload: { token: jwt() },
      })
      expect(response.statusCode).toBe(403)
      stableError(response, 'SESSION_INVALID')
    },
  )

  it.each([`${appOrigin}/`, 'https://app.example.test:443', 'https://APP.example.test']) (
    'rejects a non-exact spelling of an allowed origin: %s',
    async (origin) => {
      const { app } = await setup()
      const response = await app.inject({
        method: 'POST',
        url: '/api/session/exchange',
        headers: { origin },
        payload: { token: jwt() },
      })

      expect(response.statusCode).toBe(403)
      stableError(response, 'SESSION_INVALID')
    },
  )

  it('enforces Origin before resolving an unknown write route', async () => {
    const { app } = await setup()
    const response = await app.inject({ method: 'POST', url: '/unknown-write' })

    expect(response.statusCode).toBe(403)
    stableError(response, 'SESSION_INVALID')
  })

  it.each([
    ['GET', '/unknown?token=SECRET-JWT', {}],
    ['POST', '/unknown?operation_token=SECRET-OP', { origin: appOrigin }],
  ] as const)('returns a stable non-reflective 404 for %s unknown routes', async (method, url, headers) => {
    const { app } = await setup()
    const response = await app.inject({ method, url, headers })

    expect(response.statusCode).toBe(404)
    stableError(response, 'SESSION_INVALID')
    expect(response.body).not.toMatch(/SECRET-JWT|SECRET-OP|operation_token|Fastify|Not Found/i)
  })

  it('allows GET health without Origin and exposes no configuration', async () => {
    const { app } = await setup()
    const response = await app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
    expect(response.body).not.toMatch(/origin|api|secret|version|dependency/i)
  })

  it.each([
    [{ operation_id: 'not-v4', amount: '1', count: 1 }, 'AMOUNT_INVALID'],
    [{ operation_id: operationId, amount: 1, count: 1 }, 'AMOUNT_INVALID'],
    [{ operation_id: operationId, amount: '1', count: 1, user_id: 999 }, 'AMOUNT_INVALID'],
    [{ operation_id: operationId, amount: '1' }, 'AMOUNT_INVALID'],
  ])('rejects invalid prepare body %#', async (payload, code) => {
    const { app } = await setup()
    const cookie = await cookieFor(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin, cookie },
      payload,
    })

    expect(response.statusCode).toBe(400)
    stableError(response, code)
  })

  it.each([
    ['/api/session/exchange', { token: jwt(), extra: true }, 'SESSION_INVALID'],
    ['/api/conversions/execute', { operation_token: '', extra: true }, 'OPERATION_TOKEN_INVALID'],
  ])('rejects additional or empty fields on %s', async (url, payload, code) => {
    const { app } = await setup()
    const headers: Record<string, string> = { origin: appOrigin }
    if (url.includes('conversions')) headers.cookie = await cookieFor(app)
    const response = await app.inject({ method: 'POST', url, headers, payload })

    expect(response.statusCode).toBe(400)
    stableError(response, code)
  })

  it('rejects an oversized body with a stable safe error', async () => {
    const { app } = await setup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/exchange',
      headers: { origin: appOrigin, 'content-type': 'application/json' },
      payload: JSON.stringify({ token: 'x'.repeat(17 * 1_024) }),
    })

    expect(response.statusCode).toBe(413)
    stableError(response, 'SESSION_INVALID')
    expect(response.body).not.toContain('xxxx')
  })

  it('rejects malformed JSON without exposing parser detail or the request body', async () => {
    const { app } = await setup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/exchange',
      headers: { origin: appOrigin, 'content-type': 'application/json' },
      payload: '{"token":"JSON-SECRET-JWT"',
    })

    expect(response.statusCode).toBe(400)
    stableError(response, 'SESSION_INVALID')
    expect(response.body).not.toMatch(/JSON-SECRET-JWT|Unexpected|JSON|position|body/i)
  })
})

describe('protected conversions', () => {
  it('blocks prepare before conversion side effects after redemption access is revoked', async () => {
    const { app, users, conversions } = await setup()
    const cookie = await cookieFor(app)
    users.currentProfile = { ...profile, allowed_groups: [] }

    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin, cookie },
      payload: { operation_id: operationId, amount: '12.50', count: 1 },
    })

    expect(response.statusCode).toBe(403)
    stableError(response, 'REDEEM_ACCESS_DENIED')
    expect(conversions.prepareCalls).toEqual([])
  })

  it('blocks execute before conversion side effects after redemption access is revoked', async () => {
    const { app, users, conversions } = await setup()
    const cookie = await cookieFor(app)
    users.currentProfile = { ...profile, allowed_groups: [] }

    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/execute',
      headers: { origin: appOrigin, cookie },
      payload: { operation_token: 'signed-operation-token' },
    })

    expect(response.statusCode).toBe(403)
    stableError(response, 'REDEEM_ACCESS_DENIED')
    expect(conversions.executeCalls).toEqual([])
  })

  it('prepares with the authenticated session JWT and user ID', async () => {
    const { app, conversions } = await setup()
    const userJwt = jwt()
    const cookie = await cookieFor(app, userJwt)
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/prepare?user_id=999',
      headers: { origin: appOrigin, cookie },
      payload: { operation_id: operationId, amount: '12.50', count: 1 },
    })

    expect(response.statusCode).toBe(200)
    expect(conversions.prepareCalls).toEqual([[userJwt, 7, operationId, '12.50', 1]])
    expect(response.json()).toEqual({
      operation_token: 'signed-operation-token',
      expires_at: '2026-07-13T01:00:00.000Z',
      amount: '12.50',
      count: 1,
      total_amount: '12.50',
    })
  })

  it.each([0, 101, 1.5, '2', null])('rejects invalid prepare count %s', async (count) => {
    const { app, conversions } = await setup()
    const userJwt = jwt()
    const cookie = await cookieFor(app, userJwt)
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin, cookie },
      payload: { operation_id: operationId, amount: '1', count },
    })

    expect(response.statusCode).toBe(400)
    stableError(response, 'AMOUNT_INVALID')
    expect(conversions.prepareCalls).toHaveLength(0)
  })

  it('passes one batch count without multiplying rate-limit usage', async () => {
    const { app, conversions } = await setup()
    const userJwt = jwt()
    const cookie = await cookieFor(app, userJwt)
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin, cookie },
      payload: { operation_id: operationId, amount: '1', count: 100 },
    })

    expect(response.statusCode).toBe(200)
    expect(conversions.prepareCalls).toEqual([[userJwt, 7, operationId, '1', 100]])
  })

  it.each([
    ['pending', 202],
    ['completed', 200],
  ] as const)('returns %s execution with the stable status', async (state, status) => {
    const { app, conversions } = await setup()
    const userJwt = jwt()
    const cookie = await cookieFor(app, userJwt)
    conversions.executeResponse =
      state === 'pending'
        ? { status: 'pending', operation_id: operationId, error: 'CONVERSION_PENDING' }
        : {
            status: 'completed',
            operation_id: operationId,
            amount: '12.5',
            count: 1,
            total_amount: '12.5',
            codes: [{ code: 'REDEEM-SECRET-CODE', created_at: '2026-07-13T00:00:00.000Z' }],
          }

    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/execute',
      headers: { origin: appOrigin, cookie },
      payload: { operation_token: 'operation-secret-token' },
    })

    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual(conversions.executeResponse)
    expect(conversions.executeCalls).toEqual([['operation-secret-token', userJwt, 7]])
  })

  it.each([
    [new AppError('AMOUNT_EXCEEDS_BALANCE', 409, 'leaked SECRET-JWT'), 'AMOUNT_EXCEEDS_BALANCE', 409],
    [
      Object.assign(
        new Error(
          'leaked SECRET-JWT ADMIN-SECRET-KEY SESSION-SECRET-TOKEN operation-secret-token REDEEM-SECRET-CODE',
        ),
        {
          cause: new Error('UPSTREAM-CAUSE-SECRET'),
          body: 'UPSTREAM-BODY-SECRET',
        },
      ),
      'UPSTREAM_UNAVAILABLE',
      502,
    ],
  ] as const)('serializes application and unknown failures safely', async (error, code, status) => {
    const { app, conversions } = await setup()
    const cookie = await cookieFor(app)
    conversions.prepareError = error
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin, cookie },
      payload: { operation_id: operationId, amount: '1', count: 1 },
    })

    expect(response.statusCode).toBe(status)
    stableError(response, code)
    expect(response.body).not.toMatch(
      /SECRET-JWT|ADMIN-SECRET-KEY|SESSION-SECRET-TOKEN|operation-secret-token|REDEEM-SECRET-CODE|UPSTREAM-CAUSE-SECRET|UPSTREAM-BODY-SECRET|stack|cause/,
    )
  })
})

describe('security headers, rate limits, and logging', () => {
  it('sets exact frame, referrer, and MIME-sniffing protections without a wildcard', async () => {
    const { app } = await setup()
    const response = await app.inject({ method: 'GET', url: '/healthz' })

    const csp = response.headers['content-security-policy']
    expect(csp).toBeTypeOf('string')
    const frameAncestors = (csp as string)
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('frame-ancestors '))
    expect(frameAncestors).toBe(`frame-ancestors 'self' ${sub2apiOrigin}`)
    expect(frameAncestors).not.toContain('*')
    expect(response.headers['x-frame-options']).toBeUndefined()
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('always emits a Secure session cookie in production', async () => {
    const users = new FakeUsers()
    const app = buildApp({ ...config, nodeEnv: 'production' }, {
      users,
      conversions: new FakeConversions(),
      secrets: secrets(),
    })
    apps.push(app)
    await app.ready()

    const response = await exchange(app)

    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toMatch(/; Secure(?:;|$)/i)
  })

  it('declares every credential-bearing logger path required by the server contract', () => {
    expect(redactionPaths).toEqual(expect.arrayContaining([
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.query.token',
      'req.body.token',
      'req.body.operation_token',
      'res.body.code',
      'config.sub2apiAdminApiKey',
    ]))
  })

  it('rate limits exchange independently from prepare and execute', async () => {
    const { app } = await setup()
    const cookie = await cookieFor(app)
    for (let count = 0; count < 5; count += 1) {
      expect((await exchange(app)).statusCode).toBe(200)
    }
    const exchangeLimited = await exchange(app)
    expect(exchangeLimited.statusCode).toBe(429)
    stableError(exchangeLimited, 'RATE_LIMITED')
    expect(exchangeLimited.headers['retry-after']).toBeDefined()

    const prepare = await app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin, cookie },
      payload: { operation_id: operationId, amount: '1', count: 1 },
    })
    const execute = await app.inject({
      method: 'POST',
      url: '/api/conversions/execute',
      headers: { origin: appOrigin, cookie },
      payload: { operation_token: 'operation-token' },
    })
    expect(prepare.statusCode).toBe(200)
    expect(execute.statusCode).toBe(200)
  })

  it('keeps prepare and execute rate-limit budgets independent in both directions', async () => {
    const prepareRequest = { operation_id: operationId, amount: '1', count: 1 }
    const executeRequest = { operation_token: 'operation-token' }
    const send = (
      app: FastifyInstance,
      cookie: string,
      route: 'prepare' | 'execute',
    ) => app.inject({
      method: 'POST',
      url: `/api/conversions/${route}`,
      headers: { origin: appOrigin, cookie },
      payload: route === 'prepare' ? prepareRequest : executeRequest,
    })

    const first = await setup()
    const firstCookie = await cookieFor(first.app)
    for (let count = 0; count < 10; count += 1) {
      expect((await send(first.app, firstCookie, 'prepare')).statusCode).toBe(200)
    }
    const prepareLimited = await send(first.app, firstCookie, 'prepare')
    expect(prepareLimited.statusCode).toBe(429)
    stableError(prepareLimited, 'RATE_LIMITED')
    expect(prepareLimited.headers['retry-after']).toBeDefined()
    expect((await send(first.app, firstCookie, 'execute')).statusCode).toBe(200)

    const second = await setup()
    const secondCookie = await cookieFor(second.app)
    for (let count = 0; count < 10; count += 1) {
      expect((await send(second.app, secondCookie, 'execute')).statusCode).toBe(200)
    }
    const executeLimited = await send(second.app, secondCookie, 'execute')
    expect(executeLimited.statusCode).toBe(429)
    stableError(executeLimited, 'RATE_LIMITED')
    expect(executeLimited.headers['retry-after']).toBeDefined()
    expect((await send(second.app, secondCookie, 'prepare')).statusCode).toBe(200)
  })

  it.each([
    ['prepare', { operation_id: operationId, amount: '1', count: 1 }],
    ['execute', { operation_token: 'operation-token' }],
  ] as const)('revalidates %s access before applying its user limit', async (route, payload) => {
    const { app, users, conversions } = await setup()
    const cookie = await cookieFor(app)
    users.calls = []
    const send = () => app.inject({
      method: 'POST',
      url: `/api/conversions/${route}`,
      headers: { origin: appOrigin, cookie },
      payload,
    })

    for (let count = 0; count < 10; count += 1) {
      expect((await send()).statusCode).toBe(200)
    }
    expect(users.calls).toHaveLength(10)

    const conversionCallCount = conversions.prepareCalls.length + conversions.executeCalls.length
    users.currentProfile = { ...profile, allowed_groups: [] }

    const denied = await send()
    expect(denied.statusCode).toBe(403)
    stableError(denied, 'REDEEM_ACCESS_DENIED')
    expect(users.calls).toHaveLength(11)
    expect(conversions.prepareCalls.length + conversions.executeCalls.length).toBe(
      conversionCallCount,
    )
  })

  it('applies independent route IP limits before reading a protected session', async () => {
    const { app } = await setup()
    const prepareWithoutCookie = () => app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin },
      payload: { operation_id: operationId, amount: '1', count: 1 },
    })

    for (let count = 0; count < 30; count += 1) {
      expect((await prepareWithoutCookie()).statusCode).toBe(401)
    }
    const limited = await prepareWithoutCookie()
    expect(limited.statusCode).toBe(429)
    stableError(limited, 'RATE_LIMITED')
    expect(limited.headers['retry-after']).toBeDefined()

    const execute = await app.inject({
      method: 'POST',
      url: '/api/conversions/execute',
      headers: { origin: appOrigin },
      payload: { operation_token: 'operation-token' },
    })
    expect(execute.statusCode).toBe(401)
    stableError(execute, 'SESSION_REQUIRED')
  })

  it('keys protected rate limits by authenticated user ID', async () => {
    const user7Jwt = rawJwt({ exp: Math.floor(Date.now() / 1_000) + 3_600, marker: 7 })
    const user8Jwt = rawJwt({ exp: Math.floor(Date.now() / 1_000) + 3_600, marker: 8 })
    const users: UserClient = {
      async getProfile(userJwt) {
        if (userJwt === user7Jwt) return profile
        if (userJwt === user8Jwt) return { ...profile, id: 8, username: 'bob' }
        throw new UpstreamError('auth', 'unknown test token')
      },
    }
    const { app } = await setup({ users })
    const user7Cookie = await cookieFor(app, user7Jwt)
    const user8Cookie = await cookieFor(app, user8Jwt)
    const prepare = (cookie: string) => app.inject({
      method: 'POST',
      url: '/api/conversions/prepare',
      headers: { origin: appOrigin, cookie },
      payload: { operation_id: operationId, amount: '1', count: 1 },
    })

    for (let count = 0; count < 10; count += 1) {
      expect((await prepare(user7Cookie)).statusCode).toBe(200)
    }
    const limited = await prepare(user7Cookie)
    expect(limited.statusCode).toBe(429)
    stableError(limited, 'RATE_LIMITED')
    expect(limited.headers['retry-after']).toBeDefined()
    expect((await prepare(user8Cookie)).statusCode).toBe(200)
  })

  it('redacts credentials and query strings from real Pino output', async () => {
    let output = ''
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    const users = new FakeUsers()
    const conversions = new FakeConversions()
    const app = buildApp({ ...config, logLevel: 'info' }, {
      users,
      conversions,
      secrets: secrets(),
      loggerStream: stream,
    })
    apps.push(app)
    await app.ready()

    await app.inject({
      method: 'GET',
      url: '/healthz?token=QUERY-SECRET&user_id=PRIVATE-USER-ID',
      headers: { authorization: 'Bearer SECRET-JWT', cookie: 'redeem_session=SECRET-COOKIE' },
    })
    app.log.info({
      body: {
        token: 'BODY-SECRET-JWT',
        operation_token: 'BODY-SECRET-OP',
        code: 'OBJECT-SECRET-CODE',
      },
      headers: { 'x-api-key': 'X-API-SECRET' },
      session: { userJwt: 'SESSION-TOKEN-SECRET' },
      sub2apiAdminApiKey: 'ADMIN-SECRET',
      config: { sub2apiAdminApiKey: 'NESTED-ADMIN-SECRET' },
    }, 'redaction probe')
    const loggedError = Object.assign(
      new Error('UPSTREAM-BODY-SECRET SECRET-STACK-JWT'),
      {
        cause: new Error('SECRET-CAUSE-OPERATION-TOKEN'),
        body: 'SECRET-UPSTREAM-BODY',
      },
    )
    app.log.error({ err: loggedError }, 'safe upstream failure')

    const sessionCookie = await cookieFor(app)
    await app.inject({
      method: 'POST',
      url: '/api/conversions/execute',
      headers: { origin: appOrigin, cookie: sessionCookie },
      payload: { operation_token: 'EXECUTE-SECRET-OP' },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(output.length).toBeGreaterThan(0)
    expect(output).toContain('[REDACTED]')
    const records = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const incoming = records.find((record) => record.msg === 'incoming request')
    const completed = records.find((record) =>
      record.msg === 'request completed' &&
      (record.res as { statusCode?: number } | undefined)?.statusCode === 200,
    )
    expect(incoming).toMatchObject({
      req: { method: 'GET', pathname: '/healthz' },
      reqId: expect.any(String),
    })
    expect(incoming?.req).toEqual({ method: 'GET', pathname: '/healthz' })
    expect(completed).toMatchObject({
      res: { statusCode: 200 },
      reqId: expect.any(String),
      responseTime: expect.any(Number),
    })
    expect(completed?.res).toEqual({ statusCode: 200 })
    expect(output).not.toMatch(
      /QUERY-SECRET|PRIVATE-USER-ID|SECRET-JWT|SECRET-COOKIE|SESSION-TOKEN-SECRET|BODY-SECRET-OP|OBJECT-SECRET-CODE|X-API-SECRET|ADMIN-SECRET|EXECUTE-SECRET-OP|REDEEM-SECRET-CODE|UPSTREAM-BODY-SECRET|SECRET-STACK-JWT|SECRET-CAUSE-OPERATION-TOKEN|SECRET-UPSTREAM-BODY/,
    )
  })
})

describe('production web hosting', () => {
  it.each(['missing directory', 'missing index'] as const)(
    'refuses production startup when the web root has a %s',
    async (scenario) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'balance-code-invalid-web-'))
      temporaryRoots.push(temporaryRoot)
      const webRoot = join(temporaryRoot, 'web')
      if (scenario === 'missing index') await mkdir(webRoot)

      const app = buildApp(
        { ...config, nodeEnv: 'production' },
        {
          users: new FakeUsers(),
          conversions: new FakeConversions(),
          secrets: secrets(),
          webRoot,
        },
      )
      apps.push(app)

      const startupRejected = await app.ready().then(
        () => false,
        () => true,
      )
      expect(startupRejected).toBe(true)
    },
  )

  it('serves the built SPA and assets without swallowing API or health routes', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'balance-code-web-'))
    temporaryRoots.push(webRoot)
    await mkdir(join(webRoot, 'assets'))
    await writeFile(
      join(webRoot, 'index.html'),
      '<!doctype html><html><body><div id="app">production fixture</div></body></html>',
    )
    await writeFile(join(webRoot, 'assets', 'app-a1b2c3.js'), 'globalThis.fixtureLoaded=true')

    const dependencies = {
      users: new FakeUsers(),
      conversions: new FakeConversions(),
      secrets: secrets(),
      webRoot,
    }
    const app = buildApp({ ...config, nodeEnv: 'production' }, dependencies)
    apps.push(app)
    await app.ready()

    const root = await app.inject({ method: 'GET', url: '/' })
    expect(root.statusCode).toBe(200)
    expect(root.headers['content-type']).toMatch(/^text\/html/)
    expect(root.body).toContain('production fixture')

    const asset = await app.inject({ method: 'GET', url: '/assets/app-a1b2c3.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toMatch(/^(?:application|text)\/javascript/)
    expect(asset.body).toBe('globalThis.fixtureLoaded=true')

    const historyFallback = await app.inject({
      method: 'GET',
      url: '/history',
      headers: { accept: 'text/html' },
    })
    expect(historyFallback.statusCode).toBe(200)
    expect(historyFallback.headers['content-type']).toMatch(/^text\/html/)
    expect(historyFallback.body).toContain('production fixture')

    const headNavigation = await app.inject({
      method: 'HEAD',
      url: '/history',
      headers: { accept: 'text/html' },
    })
    expect(headNavigation.statusCode).toBe(200)
    expect(headNavigation.headers['content-type']).toMatch(/^text\/html/)
    expect(headNavigation.body).toBe('')

    for (const accept of ['application/json', '*/*', 'text/html;q=0', undefined]) {
      const nonNavigation = await app.inject({
        method: 'GET',
        url: '/reports',
        headers: accept === undefined ? {} : { accept },
      })
      expect(nonNavigation.statusCode).toBe(404)
      stableError(nonNavigation, 'SESSION_INVALID')
      expect(nonNavigation.headers['content-type']).toMatch(/^application\/json/)
      expect(nonNavigation.body).not.toContain('production fixture')
    }

    const unknownApi = await app.inject({ method: 'GET', url: '/api/unknown?token=API-SECRET' })
    expect(unknownApi.statusCode).toBe(404)
    stableError(unknownApi, 'SESSION_INVALID')
    expect(unknownApi.headers['content-type']).toMatch(/^application\/json/)
    expect(unknownApi.body).not.toMatch(/production fixture|API-SECRET/)

    const health = await app.inject({ method: 'GET', url: '/healthz?token=HEALTH-SECRET' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })
    expect(health.body).not.toMatch(/production fixture|HEALTH-SECRET|origin|api|secret/i)
  })
})
