import type { FastifyRequest } from 'fastify'

import { AppError } from '../errors.js'

export function enforceWriteOrigin(
  request: FastifyRequest,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return

  const header = request.headers.origin
  if (typeof header !== 'string' || !allowedOrigins.has(header)) {
    throw new AppError('SESSION_INVALID', 403, '请求来源不受信任')
  }
}
