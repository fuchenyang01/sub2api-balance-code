import type { Writable } from 'node:stream'

import type { FastifyServerOptions } from 'fastify'

interface RequestLike {
  method?: string
  url?: string
}

interface ResponseLike {
  statusCode?: number
}

interface ErrorLike {
  name?: string
}

type FastifyLoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>

export type SafeLoggerOptions = FastifyLoggerOptions & {
  serializers: {
    req(request: RequestLike): { method: string | undefined; pathname: string }
    res(response: ResponseLike): { statusCode: number | undefined }
    err(error: ErrorLike): { type: string }
  }
  stream?: Writable
}

export const redactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.query.token',
  'req.body.token',
  'req.body.operation_token',
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
  'config.sub2apiAdminApiKey',
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
      req: (request) => ({ method: request.method, pathname: pathname(request.url) }),
      res: (response) => ({ statusCode: response.statusCode }),
      err: (error) => ({ type: error.name ?? 'Error' }),
    },
    ...(stream === undefined ? {} : { stream }),
  } as SafeLoggerOptions
}
