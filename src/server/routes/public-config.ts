import type { FastifyInstance } from 'fastify'

import type { PublicConfigResponse } from '../../shared/contracts.js'

export function registerPublicConfigRoute(app: FastifyInstance, sub2apiEntryUrl: string): void {
  app.get('/api/config', async (): Promise<PublicConfigResponse> => ({
    sub2api_entry_url: sub2apiEntryUrl,
  }))
}
