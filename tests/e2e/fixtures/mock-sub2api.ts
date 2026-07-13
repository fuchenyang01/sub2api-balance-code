import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockMode = 'success' | 'timeout-after-success' | 'insufficient' | 'in-progress'

interface RedeemCode {
  id: number
  code: string
  type: 'balance'
  value: number
  status: 'unused'
  used_by: null
  created_at: string
}

export interface MockSub2Api {
  readonly origin: string
  readonly userToken: string
  setMode(mode: MockMode): void
  setIframeChildUrl(url: string): void
  totalSuccessfulDebits(): number
  close(): Promise<void>
}

const USER_ID = 7
const ADMIN_API_KEY = 'admin-e2e-only-not-a-production-credential'

export const mockAdminApiKey = ADMIN_API_KEY

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function createTestJwt(): string {
  return [
    base64UrlJson({ alg: 'none', typ: 'JWT' }),
    base64UrlJson({ sub: String(USER_ID), exp: Math.floor(Date.now() / 1_000) + 3_600 }),
    'test-signature',
  ].join('.')
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function success(response: ServerResponse, data: unknown): void {
  json(response, 200, { code: 0, message: 'success', data })
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}

export async function startMockSub2Api(): Promise<MockSub2Api> {
  let mode: MockMode = 'success'
  let balance = 100
  let nextCodeId = 1
  let successfulDebits = 0
  let iframeChildUrl: string | null = null
  let closing: Promise<void> | null = null
  const userToken = createTestJwt()
  const codes = new Map<number, RedeemCode>()
  const generated = new Map<string, RedeemCode>()
  const debits = new Map<string, Record<string, never>>()

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { code: 1, message: 'mock failure' })
      else response.destroy()
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://mock.local')
    if (request.method === 'GET' && url.pathname === '/e2e-parent') {
      if (iframeChildUrl === null) {
        json(response, 503, { code: 1, message: 'iframe child is not configured' })
        return
      }
      const escapedChildUrl = iframeChildUrl
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><body style="margin:0"><iframe id="tool-frame" title="余额兑换工具" src="${escapedChildUrl}" style="width:100%;height:780px;border:0"></iframe></body></html>`)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/user/profile') {
      if (request.headers.authorization !== `Bearer ${userToken}`) {
        json(response, 401, { code: 401, message: 'invalid user token' })
        return
      }
      success(response, {
        id: USER_ID,
        username: '测试用户',
        balance,
        status: 'active',
      })
      return
    }

    if (request.headers['x-api-key'] !== ADMIN_API_KEY) {
      json(response, 403, { code: 403, message: 'invalid admin key' })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/admin/redeem-codes/generate') {
      const key = request.headers['idempotency-key']
      const body = await readJson(request)
      if (typeof key !== 'string' || !key.startsWith('code-') || !isRecord(body)
        || body.count !== 1 || body.type !== 'balance' || typeof body.value !== 'number') {
        json(response, 400, { code: 1, message: 'invalid generate request' })
        return
      }
      const replay = generated.get(key)
      if (replay !== undefined) {
        response.setHeader('x-idempotency-replayed', 'true')
        success(response, [replay])
        return
      }
      const code: RedeemCode = {
        id: nextCodeId,
        code: `TEST-CODE-${nextCodeId}`,
        type: 'balance',
        value: body.value,
        status: 'unused',
        used_by: null,
        created_at: '2026-07-14T00:00:00.000Z',
      }
      nextCodeId += 1
      codes.set(code.id, code)
      generated.set(key, code)
      success(response, [code])
      return
    }

    const codeMatch = /^\/api\/v1\/admin\/redeem-codes\/(\d+)$/.exec(url.pathname)
    if (codeMatch !== null && request.method === 'GET') {
      const code = codes.get(Number(codeMatch[1]))
      if (code === undefined) json(response, 404, { code: 404, message: 'not found' })
      else success(response, code)
      return
    }
    if (codeMatch !== null && request.method === 'DELETE') {
      const deleted = codes.delete(Number(codeMatch[1]))
      if (!deleted) json(response, 404, { code: 404, message: 'not found' })
      else success(response, {})
      return
    }

    const debitMatch = /^\/api\/v1\/admin\/users\/(\d+)\/balance$/.exec(url.pathname)
    if (debitMatch !== null && request.method === 'POST') {
      const key = request.headers['idempotency-key']
      const body = await readJson(request)
      if (Number(debitMatch[1]) !== USER_ID || typeof key !== 'string' || !key.startsWith('debit-')
        || !isRecord(body) || typeof body.balance !== 'number' || body.operation !== 'subtract'
        || body.notes !== `balance-to-code:${key.slice('debit-'.length)}`) {
        json(response, 400, { code: 1, message: 'invalid debit request' })
        return
      }
      if (debits.has(key)) {
        response.setHeader('x-idempotency-replayed', 'true')
        success(response, {})
        return
      }
      if (mode === 'insufficient') {
        json(response, 400, {
          code: 1,
          message: 'balance cannot be negative',
          reason: 'INSUFFICIENT_BALANCE',
        })
        return
      }
      if (mode === 'in-progress') {
        json(response, 503, {
          code: 1,
          message: 'idempotency operation in progress',
          reason: 'IDEMPOTENCY_IN_PROGRESS',
        })
        return
      }

      balance -= body.balance
      successfulDebits += 1
      debits.set(key, {})
      if (mode === 'timeout-after-success') {
        // Leave the first response open. The real client times out after the debit is committed.
        return
      }
      success(response, {})
      return
    }

    json(response, 404, { code: 404, message: 'not found' })
  }

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    userToken,
    setMode: (nextMode) => { mode = nextMode },
    setIframeChildUrl: (url) => { iframeChildUrl = url },
    totalSuccessfulDebits: () => successfulDebits,
    close: () => {
      closing ??= (async () => {
        await closeServer(server)
        codes.clear()
        generated.clear()
        debits.clear()
        balance = 100
        successfulDebits = 0
        iframeChildUrl = null
      })()
      return closing
    },
  }
}
