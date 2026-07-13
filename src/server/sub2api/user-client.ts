import { requestUpstream } from './http.js'
import { profileSchema, type Profile } from './types.js'

export interface UserClient {
  getProfile(userJwt: string): Promise<Profile>
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

  getProfile(userJwt: string): Promise<Profile> {
    return requestUpstream({
      url: `${this.#baseUrl}/api/v1/user/profile`,
      init: { headers: { Authorization: `Bearer ${userJwt}` } },
      timeoutMs: this.#timeoutMs,
      dataSchema: profileSchema,
      fetchImpl: this.#fetchImpl,
      sensitiveValues: [userJwt],
    })
  }
}
