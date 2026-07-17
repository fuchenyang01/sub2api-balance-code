import { describe, expect, it } from 'vitest'

import { createUpstreamUserContext } from '../../src/server/sub2api/user-context.js'

describe('createUpstreamUserContext', () => {
  it('preserves an exact valid browser User-Agent', () => {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) 测试'

    expect(createUpstreamUserContext(userAgent)).toEqual({ userAgent })
  })

  it('accepts exactly 512 UTF-8 bytes', () => {
    const userAgent = 'x'.repeat(512)

    expect(createUpstreamUserContext(userAgent)).toEqual({ userAgent })
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['NUL control character', 'Browser\u0000Agent'],
    ['tab control character', 'Browser\tAgent'],
    ['DEL control character', 'Browser\u007fAgent'],
    ['C1 NEL control character', 'Browser\u0085Agent'],
    ['over 512 UTF-8 bytes', '测'.repeat(171)],
  ] as const)('rejects %s without fabricating a value', (_label, userAgent) => {
    expect(createUpstreamUserContext(userAgent)).toBeUndefined()
  })
})
