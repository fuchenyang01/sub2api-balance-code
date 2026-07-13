import type { FastifyInstance } from 'fastify'

import type {
  ExecuteRequest,
  ExecuteResponse,
  PrepareRequest,
  PrepareResponse,
} from '../../shared/contracts.js'
import type { SessionReader } from './session.js'

export interface ConversionOperations {
  prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
  ): Promise<PrepareResponse>
  execute(operationToken: string, userId: number): Promise<ExecuteResponse>
}

const uuidV4Pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const prepareBodySchema = {
  type: 'object',
  required: ['operation_id', 'amount'],
  properties: {
    operation_id: { type: 'string', pattern: uuidV4Pattern },
    amount: { type: 'string', minLength: 1, maxLength: 128 },
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

export function registerConversionRoutes(
  app: FastifyInstance,
  sessions: SessionReader,
  conversions: ConversionOperations,
): void {
  const prepareLimit = app.rateLimit({
    max: 10,
    timeWindow: 60_000,
    keyGenerator: (request) => `${sessions.get(request).userId}:prepare`,
  })
  const executeLimit = app.rateLimit({
    max: 10,
    timeWindow: 60_000,
    keyGenerator: (request) => `${sessions.get(request).userId}:execute`,
  })

  app.post<{ Body: PrepareRequest }>(
    '/api/conversions/prepare',
    {
      schema: { body: prepareBodySchema },
      preHandler: [sessions.authenticate, prepareLimit],
    },
    async (request) => {
      const session = sessions.get(request)
      return conversions.prepare(
        session.userJwt,
        session.userId,
        request.body.operation_id,
        request.body.amount,
      )
    },
  )

  app.post<{ Body: ExecuteRequest }>(
    '/api/conversions/execute',
    {
      schema: { body: executeBodySchema },
      preHandler: [sessions.authenticate, executeLimit],
    },
    async (request, reply) => {
      const session = sessions.get(request)
      const response = await conversions.execute(request.body.operation_token, session.userId)
      return reply.code(response.status === 'pending' ? 202 : 200).send(response)
    },
  )
}
