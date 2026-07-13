import type { Writable } from 'node:stream'

import type { FastifyServerOptions } from 'fastify'

interface RequestLike {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}

type FastifyLoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>

export type SafeLoggerOptions = FastifyLoggerOptions & {
  serializers: {
    req(request: RequestLike): { method: string | undefined; url: string }
  }
  stream?: Writable
}

export const redactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'request.headers.authorization',
  'request.headers.cookie',
  'request.headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'body.token',
  'body.operation_token',
  'token',
  'operation_token',
  'userJwt',
  'session.userJwt',
  'sub2apiAdminApiKey',
  'adminApiKey',
  'code',
  '*.code',
  'body.code',
  'res.body.code',
  'response.code',
] as const

function pathname(rawUrl: string | undefined): string {
  if (rawUrl === undefined) return '/'
  try {
    return new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return '/'
  }
}

export function createLoggerOptions(
  level: string,
  stream?: Writable,
): SafeLoggerOptions {
  return {
    level,
    redact: { paths: [...redactionPaths], censor: '[REDACTED]' },
    serializers: {
      req: (request) => ({ method: request.method, url: pathname(request.url) }),
    },
    ...(stream === undefined ? {} : { stream }),
  } as SafeLoggerOptions
}
