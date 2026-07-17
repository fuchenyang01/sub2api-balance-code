import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type {
  ExecuteRequest,
  ExecuteResponse,
  PrepareRequest,
  PrepareResponse,
} from '../../shared/contracts.js'
import { MAX_BATCH_COUNT, MIN_BATCH_COUNT } from '../../shared/contracts.js'
import type { UpstreamUserContext } from '../sub2api/user-context.js'
import type { SessionReader } from './session.js'

export interface ConversionOperations {
  prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
    context: UpstreamUserContext | undefined,
  ): Promise<PrepareResponse>
  execute(
    operationToken: string,
    userJwt: string,
    userId: number,
    context: UpstreamUserContext | undefined,
  ): Promise<ExecuteResponse>
}

const uuidV4Pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const prepareBodySchema = {
  type: 'object',
  required: ['operation_id', 'amount', 'count'],
  properties: {
    operation_id: { type: 'string', pattern: uuidV4Pattern },
    amount: { type: 'string', minLength: 1, maxLength: 128 },
    count: { type: 'integer', minimum: MIN_BATCH_COUNT, maximum: MAX_BATCH_COUNT },
  },
  additionalProperties: false,
} as const

const executeBodySchema = {
  type: 'object',
  required: ['operation_token'],
  properties: {
    operation_token: { type: 'string', minLength: 1, maxLength: 8_192 },
  },
  additionalProperties: false,
} as const

function manualLimitHook(
  checkLimit: ReturnType<FastifyInstance['createRateLimit']>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const result = await checkLimit(request)
    if (result.isAllowed) return

    reply.header('x-ratelimit-limit', result.max)
    reply.header('x-ratelimit-remaining', result.remaining)
    reply.header('x-ratelimit-reset', result.ttlInSeconds)
    if (!result.isExceeded) return

    reply.header('retry-after', result.ttlInSeconds)
    throw Object.assign(new Error('Rate limited'), { statusCode: 429 })
  }
}

export function registerConversionRoutes(
  app: FastifyInstance,
  sessions: SessionReader,
  conversions: ConversionOperations,
): void {
  const prepareIpLimit = app.rateLimit({
    max: 30,
    timeWindow: 60_000,
    keyGenerator: (request) => `prepare:${request.ip}`,
  })
  const executeIpLimit = app.rateLimit({
    max: 30,
    timeWindow: 60_000,
    keyGenerator: (request) => `execute:${request.ip}`,
  })
  const prepareLimit = manualLimitHook(app.createRateLimit({
    max: 10,
    timeWindow: 60_000,
    keyGenerator: (request) => `${sessions.getIdentity(request).userId}:prepare`,
  }))
  const executeLimit = manualLimitHook(app.createRateLimit({
    max: 10,
    timeWindow: 60_000,
    keyGenerator: (request) => `${sessions.getIdentity(request).userId}:execute`,
  }))

  app.post<{ Body: PrepareRequest }>(
    '/api/conversions/prepare',
    {
      schema: { body: prepareBodySchema },
      preHandler: [
        prepareIpLimit,
        sessions.loadIdentity,
        sessions.revalidate,
        prepareLimit,
      ],
    },
    async (request) => {
      const session = sessions.get(request)
      return conversions.prepare(
        session.userJwt,
        session.userId,
        request.body.operation_id,
        request.body.amount,
        request.body.count,
        session.upstreamContext,
      )
    },
  )

  app.post<{ Body: ExecuteRequest }>(
    '/api/conversions/execute',
    {
      schema: { body: executeBodySchema },
      preHandler: [
        executeIpLimit,
        sessions.loadIdentity,
        sessions.revalidate,
        executeLimit,
      ],
    },
    async (request, reply) => {
      const session = sessions.get(request)
      const response = await conversions.execute(
        request.body.operation_token,
        session.userJwt,
        session.userId,
        session.upstreamContext,
      )
      return reply.code(response.status === 'pending' ? 202 : 200).send(response)
    },
  )
}
