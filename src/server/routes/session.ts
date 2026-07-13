import { Decimal } from 'decimal.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { decodeJwt } from 'jose'

import type { MeResponse } from '../../shared/contracts.js'
import type { AppConfig } from '../config.js'
import { AppError } from '../errors.js'
import type { SessionPayload } from '../security/secrets.js'
import { isUpstreamError } from '../sub2api/http.js'
import type { Profile } from '../sub2api/types.js'
import type { UserClient } from '../sub2api/user-client.js'

export const sessionCookieName = 'redeem_session'

export interface SessionSecrets {
  sealSession(input: { userJwt: string; userId: number; expiresAt: Date }): Promise<string>
  unsealSession(token: string): Promise<SessionPayload>
}

export interface AuthenticatedSession {
  userJwt: string
  userId: number
  profile: Profile
}

interface ReadSessionDependencies {
  config: Readonly<AppConfig>
  users: UserClient
  secrets: SessionSecrets
}

const exchangeBodySchema = {
  type: 'object',
  required: ['token'],
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 8_192 },
  },
  additionalProperties: false,
} as const

function cookieOptions(config: Readonly<AppConfig>) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
  }
}

export function clearSessionCookie(reply: FastifyReply, config: Readonly<AppConfig>): void {
  reply.clearCookie(sessionCookieName, cookieOptions(config))
}

function minimalProfile(profile: Profile): MeResponse {
  return {
    id: profile.id,
    username: profile.username,
    balance: new Decimal(profile.balance).toFixed(),
  }
}

function upstreamUnavailable(): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', 502, '上游服务不可用')
}

async function verifiedProfile(
  users: UserClient,
  userJwt: string,
  authErrorCode: 'SESSION_INVALID' | 'SESSION_EXPIRED',
): Promise<Profile> {
  try {
    return await users.getProfile(userJwt)
  } catch (error) {
    if (isUpstreamError(error, 'auth')) {
      throw new AppError(authErrorCode, 401, '会话无效')
    }
    throw upstreamUnavailable()
  }
}

function jwtExpiry(userJwt: string): Date {
  let exp: unknown
  try {
    exp = decodeJwt(userJwt).exp
  } catch {
    throw new AppError('SESSION_INVALID', 401, '会话无效')
  }

  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) {
    throw new AppError('SESSION_INVALID', 401, '会话无效')
  }
  if (exp <= Math.floor(Date.now() / 1_000)) {
    throw new AppError('SESSION_EXPIRED', 401, '会话已过期')
  }

  const expiresAt = new Date(exp * 1_000)
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new AppError('SESSION_INVALID', 401, '会话无效')
  }
  return expiresAt
}

async function exchangeIdentity(
  users: UserClient,
  userJwt: string,
): Promise<{ profile: Profile; expiresAt: Date }> {
  let profile: Profile
  try {
    profile = await users.getProfile(userJwt)
  } catch (error) {
    if (isUpstreamError(error, 'auth')) {
      // The upstream remains the verifier; exp is decoded only to distinguish expiry safely.
      jwtExpiry(userJwt)
      throw new AppError('SESSION_INVALID', 401, '会话无效')
    }
    throw upstreamUnavailable()
  }
  return { profile, expiresAt: jwtExpiry(userJwt) }
}

export async function readSession(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ReadSessionDependencies,
): Promise<AuthenticatedSession> {
  const cookie = request.cookies[sessionCookieName]
  if (cookie === undefined || cookie.length === 0) {
    throw new AppError('SESSION_REQUIRED', 401, '需要登录')
  }

  let session: SessionPayload
  try {
    session = await dependencies.secrets.unsealSession(cookie)
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'SESSION_INVALID' || error.code === 'SESSION_EXPIRED')
    ) {
      clearSessionCookie(reply, dependencies.config)
      throw error
    }
    throw upstreamUnavailable()
  }

  let latest: Profile
  try {
    latest = await verifiedProfile(dependencies.users, session.userJwt, 'SESSION_EXPIRED')
  } catch (error) {
    if (error instanceof AppError && error.code === 'SESSION_EXPIRED') {
      clearSessionCookie(reply, dependencies.config)
    }
    throw error
  }

  if (latest.id !== session.userId) {
    clearSessionCookie(reply, dependencies.config)
    throw new AppError('SESSION_INVALID', 401, '会话无效')
  }

  return { userJwt: session.userJwt, userId: session.userId, profile: latest }
}

export class SessionReader {
  readonly #sessions = new WeakMap<FastifyRequest, AuthenticatedSession>()

  constructor(private readonly dependencies: ReadSessionDependencies) {}

  readonly authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    this.#sessions.set(request, await readSession(request, reply, this.dependencies))
  }

  get(request: FastifyRequest): AuthenticatedSession {
    const session = this.#sessions.get(request)
    if (session === undefined) {
      throw new AppError('SESSION_REQUIRED', 401, '需要登录')
    }
    return session
  }
}

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: ReadSessionDependencies,
): void {
  const exchangeLimit = app.rateLimit({
    max: 6,
    timeWindow: 60_000,
    keyGenerator: (request) => `exchange:${request.ip}`,
  })

  app.post<{ Body: { token: string } }>(
    '/api/session/exchange',
    {
      schema: { body: exchangeBodySchema },
      preHandler: exchangeLimit,
    },
    async (request, reply) => {
      const userJwt = request.body.token
      const { profile, expiresAt } = await exchangeIdentity(dependencies.users, userJwt)
      const session = await dependencies.secrets.sealSession({
        userJwt,
        userId: profile.id,
        expiresAt,
      })

      reply.setCookie(sessionCookieName, session, {
        ...cookieOptions(dependencies.config),
        expires: expiresAt,
      })
      return minimalProfile(profile)
    },
  )

  app.post('/api/session/logout', async (_request, reply) => {
    clearSessionCookie(reply, dependencies.config)
    return reply.code(204).send()
  })
}

export { minimalProfile }
