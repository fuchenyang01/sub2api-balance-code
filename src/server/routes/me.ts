import type { FastifyInstance } from 'fastify'

import { minimalProfile, type SessionReader } from './session.js'

export function registerMeRoute(app: FastifyInstance, sessions: SessionReader): void {
  app.get(
    '/api/me',
    { preHandler: sessions.authenticate },
    async (request) => minimalProfile(sessions.get(request).profile),
  )
}
