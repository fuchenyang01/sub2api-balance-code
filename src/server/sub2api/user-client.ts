import { requestUpstream } from './http.js'
import { profileSchema, type Profile } from './types.js'
import type { UpstreamUserContext } from './user-context.js'

export interface UserClient {
  getProfile(userJwt: string, context?: UpstreamUserContext): Promise<Profile>
  probeAuthentication?(userJwt: string, context?: UpstreamUserContext): Promise<number | null>
}

function userHeaders(
  userJwt: string,
  context: UpstreamUserContext | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${userJwt}` }
  if (context !== undefined) headers['User-Agent'] = context.userAgent
  return headers
}

export class Sub2ApiUserClient implements UserClient {
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch

  constructor(baseUrl: string, timeoutMs: number, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#timeoutMs = timeoutMs
    this.#fetchImpl = fetchImpl
  }

  getProfile(userJwt: string, context?: UpstreamUserContext): Promise<Profile> {
    return requestUpstream({
      url: `${this.#baseUrl}/api/v1/user/profile`,
      init: { headers: userHeaders(userJwt, context) },
      timeoutMs: this.#timeoutMs,
      dataSchema: profileSchema,
      fetchImpl: this.#fetchImpl,
      sensitiveValues: [userJwt],
    })
  }

  async probeAuthentication(
    userJwt: string,
    context?: UpstreamUserContext,
  ): Promise<number | null> {
    try {
      const response = await this.#fetchImpl(`${this.#baseUrl}/api/v1/auth/me`, {
        headers: userHeaders(userJwt, context),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      try {
        await response.body?.cancel()
      } catch {
        // The status is still useful if discarding the diagnostic response body fails.
      }
      return response.status
    } catch {
      return null
    }
  }
}
