import type { FastifyInstance } from 'fastify'

import type { PublicConfigResponse } from '../../shared/contracts.js'

export function buildSub2apiReloginUrl(sub2apiEntryUrl: string): string {
  const entry = new URL(sub2apiEntryUrl)
  const relogin = new URL('/balance-code-relogin', entry.origin)
  relogin.searchParams.set('redirect', entry.pathname)
  return relogin.toString()
}

export function registerPublicConfigRoute(app: FastifyInstance, sub2apiEntryUrl: string): void {
  app.get('/api/config', async (): Promise<PublicConfigResponse> => ({
    sub2api_relogin_url: buildSub2apiReloginUrl(sub2apiEntryUrl),
  }))
}
