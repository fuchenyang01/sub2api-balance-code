import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Sub2ApiAdminClient } from '../../src/server/sub2api/admin-client.js'
import { isUpstreamError, UpstreamError } from '../../src/server/sub2api/http.js'
import { Sub2ApiUserClient } from '../../src/server/sub2api/user-client.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

const profile = {
  id: 7,
  username: 'alice',
  balance: 42.5,
  status: 'active',
  ignored: 'extra-field',
}

const redeemCode = {
  id: 11,
  code: 'ABC-123',
  type: 'balance',
  value: 12.5,
  status: 'unused',
  used_by: null,
  created_at: '2026-07-13T00:00:00.000Z',
  ignored: 'extra-field',
}

const parsedRedeemCode = {
  id: 11,
  code: 'ABC-123',
  type: 'balance',
  value: 12.5,
  status: 'unused',
  used_by: null,
  created_at: '2026-07-13T00:00:00.000Z',
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}

describe('sub2api clients', () => {
  let server: Server
  let baseUrl: string
  let handler: Handler

  beforeEach(async () => {
    handler = (_request, response) => json(response, 500, { code: 1, message: 'unexpected' })
    server = createServer((request, response) => {
      void Promise.resolve(handler(request, response)).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : undefined)
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await closeServer(server)
  })

  it('parses a profile and sends only the user authorization header', async () => {
    handler = (request, response) => {
      expect(request.method).toBe('GET')
      expect(request.url).toBe('/api/v1/user/profile')
      expect(request.headers.authorization).toBe('Bearer user-jwt')
      expect(request.headers['x-api-key']).toBeUndefined()
      json(response, 200, { code: 0, message: 'success', metadata: {}, data: profile })
    }

    const client = new Sub2ApiUserClient(baseUrl, 1_000)

    await expect(client.getProfile('user-jwt')).resolves.toEqual({
      id: 7,
      username: 'alice',
      balance: 42.5,
      status: 'active',
    })
  })

  it('generates exactly one balance code with isolated admin headers', async () => {
    const operationId = 'op-generate'
    handler = async (request, response) => {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/api/v1/admin/redeem-codes/generate')
      expect(request.headers['x-api-key']).toBe('admin-secret')
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['content-type']).toBe('application/json')
      expect(request.headers['idempotency-key']).toBe(`code-${operationId}`)
      expect(await readJson(request)).toEqual({ count: 1, type: 'balance', value: 12.5 })
      json(response, 200, { code: 0, message: 'success', data: [redeemCode] })
    }

    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.generateCode(operationId, 12.5)).resolves.toEqual(parsedRedeemCode)
  })

  it.each([{ data: [] }, { data: [redeemCode, { ...redeemCode, id: 12 }] }])(
    'rejects a generated-code array whose length is not one',
    async ({ data }) => {
      handler = (_request, response) => json(response, 200, { code: 0, message: 'success', data })
      const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

      await expect(client.generateCode('op', 1)).rejects.toSatisfy((error: unknown) =>
        isUpstreamError(error, 'invalid-response'),
      )
    },
  )

  it('treats an idempotency replay as the same successful generation', async () => {
    handler = (_request, response) => {
      response.setHeader('X-Idempotency-Replayed', 'true')
      json(response, 200, { code: 0, message: 'success', data: [redeemCode] })
    }
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.generateCode('replayed-op', 12.5)).resolves.toEqual(parsedRedeemCode)
  })

  it('gets an existing code and maps a 404 to null', async () => {
    handler = (request, response) => {
      if (request.url === '/api/v1/admin/redeem-codes/11') {
        json(response, 200, { code: 0, message: 'success', data: redeemCode })
      } else {
        json(response, 404, { code: 404, message: 'not found' })
      }
    }
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.getCode(11)).resolves.toEqual(parsedRedeemCode)
    await expect(client.getCode(99)).resolves.toBeNull()
  })

  it('maps an HTML 404 response to a missing code', async () => {
    handler = (_request, response) => {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<html>not found</html>')
    }
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.getCode(99)).resolves.toBeNull()
  })

  it('maps successful and missing deletes', async () => {
    handler = (request, response) => {
      expect(request.method).toBe('DELETE')
      if (request.url?.endsWith('/11')) {
        json(response, 200, { code: 0, message: 'success', data: {} })
      } else {
        json(response, 404, { code: 404, message: 'not found' })
      }
    }
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.deleteCode(11)).resolves.toBe('deleted')
    await expect(client.deleteCode(99)).resolves.toBe('missing')
  })

  it('maps an HTML 404 delete response to missing', async () => {
    handler = (_request, response) => {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<html>already deleted</html>')
    }
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.deleteCode(99)).resolves.toBe('missing')
  })

  it('debits balance with exact body and derived idempotency key', async () => {
    const operationId = 'op-debit'
    handler = async (request, response) => {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/api/v1/admin/users/7/balance')
      expect(request.headers['x-api-key']).toBe('admin-secret')
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers['content-type']).toBe('application/json')
      expect(request.headers['idempotency-key']).toBe(`debit-${operationId}`)
      expect(await readJson(request)).toEqual({
        balance: 12.5,
        operation: 'subtract',
        notes: `balance-to-code:${operationId}`,
      })
      json(response, 200, { code: 0, message: 'success', data: {} })
    }
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.debitBalance(7, operationId, 12.5)).resolves.toBeUndefined()
  })

  it.each([401, 403])('classifies HTTP %s as auth', async (status) => {
    handler = (_request, response) => json(response, status, { code: status, message: 'denied' })
    const client = new Sub2ApiUserClient(baseUrl, 1_000)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'auth'),
    )
  })

  it.each([
    [401, 'HTML', (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(401, { 'content-type': 'text/html' })
      response.end('<html>sign in</html>')
    }],
    [403, 'empty body', (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(403)
      response.end()
    }],
    [401, 'JSON without code', (_request: IncomingMessage, response: ServerResponse) => {
      json(response, 401, { message: 'denied' })
    }],
    [403, 'JSON without code', (_request: IncomingMessage, response: ServerResponse) => {
      json(response, 403, { message: 'denied' })
    }],
  ] as const)('classifies HTTP %s with %s as auth', async (_status, _body, responseHandler) => {
    handler = responseHandler
    const client = new Sub2ApiUserClient(baseUrl, 1_000)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'auth'),
    )
  })

  it.each([
    ['IDEMPOTENCY_IN_PROGRESS', 'idempotency-in-progress'],
    ['IDEMPOTENCY_STORE_UNAVAILABLE', 'idempotency-store-unavailable'],
  ] as const)('classifies %s', async (reason, kind) => {
    handler = (_request, response) =>
      json(response, 503, { code: 1, message: 'idempotency failure', reason })
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.generateCode('op', 1)).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, kind),
    )
  })

  it.each([
    { message: 'insufficient', reason: 'INSUFFICIENT_BALANCE' },
    { message: 'balance cannot be negative' },
  ])('keeps forward compatibility with explicit insufficient balance evidence', async (body) => {
    handler = (_request, response) => json(response, 400, { code: 1, ...body })
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    await expect(client.debitBalance(7, 'op', 1)).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'insufficient-balance'),
    )
  })

  it('does not guess insufficient balance from a generic 500', async () => {
    handler = (_request, response) => json(response, 500, { code: 1, message: 'internal error' })
    const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

    const error = await client.debitBalance(7, 'op', 1).catch((caught: unknown) => caught)
    expect(isUpstreamError(error, 'http')).toBe(true)
    expect(isUpstreamError(error, 'insufficient-balance')).toBe(false)
  })

  it.each([
    [
      'non-JSON',
      (_request: IncomingMessage, response: ServerResponse) => {
        response.end('not json')
      },
    ],
    [
      'invalid schema',
      (_request: IncomingMessage, response: ServerResponse) =>
        json(response, 200, { code: 0, message: 'success', data: { ...profile, id: 0 } }),
    ],
    [
      'nonzero success envelope code',
      (_request: IncomingMessage, response: ServerResponse) =>
        json(response, 200, { code: 17, message: 'logical failure', data: profile }),
    ],
  ] as const)('classifies %s as invalid-response', async (_label, responseHandler) => {
    handler = responseHandler
    const client = new Sub2ApiUserClient(baseUrl, 1_000)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'invalid-response'),
    )
  })

  it('rejects a success envelope without a message', async () => {
    handler = (_request, response) => json(response, 200, { code: 0, data: profile })
    const client = new Sub2ApiUserClient(baseUrl, 1_000)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'invalid-response'),
    )
  })

  it('preserves status and reason on a nonzero success envelope', async () => {
    handler = (_request, response) =>
      json(response, 200, {
        code: 17,
        message: 'logical failure',
        reason: 'UPSTREAM_LOGICAL_FAILURE',
        data: profile,
      })
    const client = new Sub2ApiUserClient(baseUrl, 1_000)

    const error = await client.getProfile('user-jwt').catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      kind: 'invalid-response',
      status: 200,
      reason: 'UPSTREAM_LOGICAL_FAILURE',
    })
  })

  it('classifies an aborted slow request as timeout', async () => {
    handler = () => undefined
    const client = new Sub2ApiUserClient(baseUrl, 10)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'timeout'),
    )
  })

  it('classifies a timeout while reading a partial response body', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"code":0,"message":"success","data":')
    }
    const client = new Sub2ApiUserClient(baseUrl, 20)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'timeout'),
    )
  })

  it('classifies a socket reset while reading a partial response body as network', async () => {
    handler = (_request, response) => {
      const socket = response.socket
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"code":0,"message":"success","data":')
      setImmediate(() => socket?.destroy())
    }
    const client = new Sub2ApiUserClient(baseUrl, 1_000)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'network'),
    )
  })

  it('classifies a connection failure as network', async () => {
    const address = server.address() as AddressInfo
    await closeServer(server)
    const client = new Sub2ApiUserClient(`http://127.0.0.1:${address.port}`, 1_000)

    await expect(client.getProfile('user-jwt')).rejects.toSatisfy((error: unknown) =>
      isUpstreamError(error, 'network'),
    )
  })

  it('does not follow an admin redirect to another origin', async () => {
    let targetRequests = 0
    let targetHeaders: IncomingMessage['headers'] | undefined
    const targetServer = createServer((request, response) => {
      targetRequests += 1
      targetHeaders = request.headers
      response.end('unexpected redirect target')
    })
    targetServer.listen(0, '127.0.0.1')
    await once(targetServer, 'listening')
    const targetAddress = targetServer.address() as AddressInfo

    try {
      handler = (_request, response) => {
        response.writeHead(307, {
          location: `http://127.0.0.1:${targetAddress.port}/credential-target`,
        })
        response.end()
      }
      const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)

      await expect(client.generateCode('op', 1)).rejects.toBeInstanceOf(UpstreamError)
      expect(targetRequests).toBe(0)
      expect(targetHeaders).toBeUndefined()
    } finally {
      await closeServer(targetServer)
    }
  })

  it.each([
    ['network', 'Error'],
    ['timeout', 'TimeoutError'],
  ] as const)('does not retain a credential from a %s transport cause', async (kind, name) => {
    const secret = 'SECRET1234'
    const transportError = new Error(`transport leaked ${secret}`)
    transportError.name = name
    const fetchImpl: typeof fetch = async () => {
      throw transportError
    }
    const client = new Sub2ApiUserClient(baseUrl, 1_000, fetchImpl)

    const error = await client.getProfile(secret).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UpstreamError)
    expect(error).not.toBe(transportError)
    expect(isUpstreamError(error, kind)).toBe(true)
    const cause = (error as UpstreamError).cause
    const exposed = [String(error), JSON.stringify(error), String(cause)]
    if (cause instanceof Error) exposed.push(cause.message)
    for (const value of exposed) {
      expect(value).not.toContain(secret)
      expect(value).not.toContain('SECRET12')
      expect(value).not.toContain('SECRET')
    }
  })

  it('redacts a credential crossing the message truncation boundary', async () => {
    const adminKey = 'admin-SECRET1234'
    handler = (_request, response) =>
      json(response, 500, {
        code: 1,
        message: `${'x'.repeat(1_020)}${adminKey}-suffix`,
        reason: 'FAILURE',
      })
    const client = new Sub2ApiAdminClient(baseUrl, adminKey, 1_000)

    const error = await client.generateCode('op', 1).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UpstreamError)
    expect((error as UpstreamError).message.length).toBeLessThanOrEqual(1_024)
    expect((error as UpstreamError).message).not.toContain(adminKey)
    expect((error as UpstreamError).message).not.toContain(adminKey.slice(0, 8))
    expect((error as UpstreamError).message).not.toContain(adminKey.slice(0, 4))
  })

  it.each([
    ['user-jwt', () => new Sub2ApiUserClient(baseUrl, 1_000).getProfile('user-jwt')],
    [
      'admin-secret',
      () => new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000).generateCode('op', 1),
    ],
  ] as const)('does not expose the %s credential in an error', async (secret, request) => {
    handler = (_incoming, response) =>
      json(response, 500, { code: 1, message: `upstream echoed ${secret}`, reason: 'FAILURE' })

    const error = await request().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UpstreamError)
    expect(String(error)).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(JSON.stringify(Object.assign({}, error))).not.toContain(secret)
  })
})
