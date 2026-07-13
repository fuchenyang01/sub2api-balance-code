import type { Writable } from 'node:stream'

import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify'

import type { ApiErrorBody, ErrorCode } from '../shared/contracts.js'
import type { AppConfig } from './config.js'
import { ConversionService } from './conversion/service.js'
import { AppError } from './errors.js'
import { registerConversionRoutes, type ConversionOperations } from './routes/conversions.js'
import { registerHealthRoute } from './routes/health.js'
import { registerMeRoute } from './routes/me.js'
import {
  clearSessionCookie,
  registerSessionRoutes,
  SessionReader,
  type SessionSecrets,
} from './routes/session.js'
import { enforceWriteOrigin } from './security/origin.js'
import { createLoggerOptions } from './security/redaction.js'
import { SecretsService } from './security/secrets.js'
import { Sub2ApiAdminClient, type AdminClient } from './sub2api/admin-client.js'
import { Sub2ApiUserClient, type UserClient } from './sub2api/user-client.js'

type AppSecrets = SessionSecrets & Pick<SecretsService, 'signOperation' | 'verifyOperation'>

export interface AppDependencies {
  users: UserClient
  admin: AdminClient
  secrets: AppSecrets
  conversions: ConversionOperations
  loggerStream: Writable
}

const safeMessages: Record<ErrorCode, string> = {
  SESSION_REQUIRED: '需要登录',
  SESSION_INVALID: '会话无效',
  SESSION_EXPIRED: '会话已过期',
  AMOUNT_INVALID: '金额格式无效',
  AMOUNT_EXCEEDS_BALANCE: '金额超过当前余额',
  OPERATION_TOKEN_INVALID: '操作令牌无效',
  OPERATION_TOKEN_EXPIRED: '操作令牌已过期',
  OPERATION_TERMINATED: '操作已终止',
  CONVERSION_IN_PROGRESS: '兑换正在处理中',
  CONVERSION_PENDING: '兑换结果待确认',
  UPSTREAM_AUTH_FAILED: '上游鉴权失败',
  UPSTREAM_IDEMPOTENCY_UNAVAILABLE: '上游幂等服务不可用',
  UPSTREAM_DATA_CONFLICT: '上游数据冲突',
  UPSTREAM_UNAVAILABLE: '上游服务不可用',
  MANUAL_REVIEW_REQUIRED: '需要人工复核',
}

function routeErrorCode(request: FastifyRequest): ErrorCode {
  const path = request.routeOptions.url
  if (path === '/api/conversions/prepare') return 'AMOUNT_INVALID'
  if (path === '/api/conversions/execute') return 'OPERATION_TOKEN_INVALID'
  return 'SESSION_INVALID'
}

function isValidationError(error: FastifyError): boolean {
  return (
    error.validation !== undefined ||
    error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  )
}

function installErrorHandler(app: FastifyInstance, config: Readonly<AppConfig>): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    let code: ErrorCode
    let status: number

    if (error instanceof AppError) {
      code = error.code
      status = error.status
      if (status === 401 && (code === 'SESSION_INVALID' || code === 'SESSION_EXPIRED')) {
        clearSessionCookie(reply, config)
      }
    } else if (error.statusCode === 429) {
      code = routeErrorCode(request)
      status = 429
    } else if (isValidationError(error)) {
      code = routeErrorCode(request)
      status = error.statusCode === 413 ? 413 : 400
    } else {
      code = 'UPSTREAM_UNAVAILABLE'
      status = 502
    }

    const body: ApiErrorBody = {
      error: { code, message: safeMessages[code], request_id: request.id },
    }
    return reply.code(status).send(body)
  })
}

export function buildApp(
  config: Readonly<AppConfig>,
  optionalDependencies: Partial<AppDependencies> = {},
): FastifyInstance {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1_024,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
    logger: createLoggerOptions(config.logLevel, optionalDependencies.loggerStream),
  })
  installErrorHandler(app, config)
  const allowedOrigins = new Set([config.appOrigin, config.sub2apiOrigin])
  app.addHook('onRequest', async (request) => {
    enforceWriteOrigin(request, allowedOrigins)
  })

  const users =
    optionalDependencies.users ??
    new Sub2ApiUserClient(config.sub2apiBaseUrl, config.upstreamTimeoutMs)
  const secrets =
    optionalDependencies.secrets ??
    new SecretsService({
      sessionSecret: config.sessionSecret,
      operationSigningSecret: config.operationSigningSecret,
      operationTtlMinutes: config.operationTtlMinutes,
    })
  const admin =
    optionalDependencies.admin ??
    new Sub2ApiAdminClient(
      config.sub2apiBaseUrl,
      config.sub2apiAdminApiKey,
      config.upstreamTimeoutMs,
    )
  const conversions =
    optionalDependencies.conversions ?? new ConversionService(users, admin, secrets)

  void app.register(async (routes) => {
    await routes.register(cookie)
    await routes.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          frameAncestors: ["'self'", config.sub2apiOrigin],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    })
    await routes.register(rateLimit, { global: false })

    const sessionDependencies = { config, users, secrets }
    const sessions = new SessionReader(sessionDependencies)
    registerSessionRoutes(routes, sessionDependencies)
    registerMeRoute(routes, sessions)
    registerConversionRoutes(routes, sessions, conversions)
    registerHealthRoute(routes)
  })

  return app
}
