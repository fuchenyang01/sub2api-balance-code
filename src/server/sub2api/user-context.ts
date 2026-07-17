const maxUserAgentBytes = 512
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u

export interface UpstreamUserContext {
  userAgent: string
}

export function createUpstreamUserContext(
  userAgent: string | undefined,
): UpstreamUserContext | undefined {
  if (
    userAgent === undefined ||
    userAgent.length === 0 ||
    controlCharacterPattern.test(userAgent) ||
    Buffer.byteLength(userAgent, 'utf8') > maxUserAgentBytes
  ) {
    return undefined
  }

  return { userAgent }
}
