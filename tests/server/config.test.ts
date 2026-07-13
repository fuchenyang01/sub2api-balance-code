import { describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/server/config.js'

const requiredEnv = {
  SUB2API_BASE_URL: 'https://api.example.com/v1/',
  SUB2API_ADMIN_API_KEY: 'admin-test-key',
  APP_ORIGIN: 'https://app.example.com',
  SUB2API_ORIGIN: 'https://api.example.com',
  SESSION_SECRET: 'session-secret-that-is-at-least-32-bytes',
  OPERATION_SIGNING_SECRET: 'operation-secret-that-is-at-least-32-bytes',
} satisfies NodeJS.ProcessEnv

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...requiredEnv, ...overrides }
}

describe('loadConfig', () => {
  it.each(Object.keys(requiredEnv))('requires %s', (key) => {
    const input = env()
    delete input[key]

    expect(() => loadConfig(input)).toThrow()
  })

  it('loads a complete configuration and normalizes URLs', () => {
    expect(
      loadConfig(
        env({
          NODE_ENV: 'test',
          PORT: '8080',
          OPERATION_TTL_MINUTES: '120',
          UPSTREAM_TIMEOUT_MS: '2500',
          TRUST_PROXY: 'true',
          LOG_LEVEL: 'debug',
          COOKIE_SECURE: 'false',
        }),
      ),
    ).toEqual({
      nodeEnv: 'test',
      port: 8080,
      sub2apiBaseUrl: 'https://api.example.com/v1',
      sub2apiAdminApiKey: 'admin-test-key',
      appOrigin: 'https://app.example.com',
      sub2apiOrigin: 'https://api.example.com',
      sessionSecret: 'session-secret-that-is-at-least-32-bytes',
      operationSigningSecret: 'operation-secret-that-is-at-least-32-bytes',
      operationTtlMinutes: 120,
      upstreamTimeoutMs: 2500,
      trustProxy: true,
      logLevel: 'debug',
      cookieSecure: false,
    })
  })

  it.each([
    ['https://example.com/sub2api/', 'https://example.com/sub2api'],
    ['https://example.com/', 'https://example.com'],
  ])('normalizes base URL %s as %s', (input, expected) => {
    expect(loadConfig(env({ SUB2API_BASE_URL: input })).sub2apiBaseUrl).toBe(expected)
  })

  it('applies optional defaults', () => {
    expect(loadConfig(env())).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      operationTtlMinutes: 60,
      upstreamTimeoutMs: 10_000,
      trustProxy: false,
      logLevel: 'info',
      cookieSecure: true,
    })
  })

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '1.5'],
    ['OPERATION_TTL_MINUTES', '0'],
    ['OPERATION_TTL_MINUTES', '1441'],
    ['UPSTREAM_TIMEOUT_MS', '999'],
    ['UPSTREAM_TIMEOUT_MS', '60001'],
  ])('rejects out-of-range numeric %s=%s', (key, value) => {
    expect(() => loadConfig(env({ [key]: value }))).toThrow()
  })

  it.each([
    ['TRUST_PROXY', '1'],
    ['TRUST_PROXY', 'TRUE'],
    ['COOKIE_SECURE', 'yes'],
    ['COOKIE_SECURE', '0'],
  ])('strictly parses boolean %s=%s', (key, value) => {
    expect(() => loadConfig(env({ [key]: value }))).toThrow()
  })

  it('requires the admin key prefix', () => {
    expect(() => loadConfig(env({ SUB2API_ADMIN_API_KEY: 'test-key' }))).toThrow()
  })

  it.each(['SESSION_SECRET', 'OPERATION_SIGNING_SECRET'])(
    'rejects a 31-byte ASCII %s',
    (key) => {
      expect(() => loadConfig(env({ [key]: 'a'.repeat(31) }))).toThrow()
    },
  )

  it.each(['SESSION_SECRET', 'OPERATION_SIGNING_SECRET'])(
    'accepts a 32-byte ASCII %s',
    (key) => {
      expect(() => loadConfig(env({ [key]: 'a'.repeat(32) }))).not.toThrow()
    },
  )

  it.each(['SESSION_SECRET', 'OPERATION_SIGNING_SECRET'])(
    'accepts an 11-character, 33-byte UTF-8 %s',
    (key) => {
      expect(() => loadConfig(env({ [key]: '密'.repeat(11) }))).not.toThrow()
    },
  )

  it('requires distinct secrets', () => {
    expect(() =>
      loadConfig(env({ OPERATION_SIGNING_SECRET: requiredEnv.SESSION_SECRET })),
    ).toThrow()
  })

  it.each(['APP_ORIGIN', 'SUB2API_ORIGIN'])('rejects a %s containing a path', (key) => {
    expect(() => loadConfig(env({ [key]: 'https://example.com/path' }))).toThrow()
  })

  it.each([
    ['APP_ORIGIN', 'https://example.com?query=1'],
    ['SUB2API_ORIGIN', 'https://example.com#hash'],
  ])('rejects a %s containing query or hash', (key, value) => {
    expect(() => loadConfig(env({ [key]: value }))).toThrow()
  })

  it.each(['APP_ORIGIN', 'SUB2API_ORIGIN'])('requires HTTPS %s in production', (key) => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', [key]: 'http://example.com' })),
    ).toThrow()
  })

  it('requires an HTTPS base URL in production', () => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', SUB2API_BASE_URL: 'http://example.com' })),
    ).toThrow()
  })

  it.each([
    'ftp://example.com/sub2api',
    'https://user:password@example.com/sub2api',
    'https://example.com/sub2api?token=value',
    'https://example.com/sub2api#fragment',
  ])('rejects unsafe base URL %s', (value) => {
    expect(() => loadConfig(env({ SUB2API_BASE_URL: value }))).toThrow()
  })

  it('requires secure cookies in production', () => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })),
    ).toThrow()
  })

  it('rejects invalid enum and URL values', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'staging' }))).toThrow()
    expect(() => loadConfig(env({ LOG_LEVEL: 'verbose' }))).toThrow()
    expect(() => loadConfig(env({ SUB2API_BASE_URL: 'not-a-url' }))).toThrow()
  })

  it('returns a frozen configuration', () => {
    expect(Object.isFrozen(loadConfig(env()))).toBe(true)
  })
})
