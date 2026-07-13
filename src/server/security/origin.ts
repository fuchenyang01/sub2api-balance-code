import type { FastifyRequest } from 'fastify'

import { AppError } from '../errors.js'

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

export function enforceWriteOrigin(
  request: FastifyRequest,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return

  const header = request.headers.origin
  const origin = typeof header === 'string' ? normalizeOrigin(header) : undefined
  if (origin === undefined || !allowedOrigins.has(origin)) {
    throw new AppError('SESSION_INVALID', 403, '请求来源不受信任')
  }
}
