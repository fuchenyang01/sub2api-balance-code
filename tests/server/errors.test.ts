import { describe, expect, it } from 'vitest'

import { AppError } from '../../src/server/errors.js'

describe('AppError', () => {
  it('exposes its cause without making it enumerable', () => {
    const cause = { secret: 'sensitive-upstream-detail' }
    const error = new AppError('UPSTREAM_UNAVAILABLE', 503, '服务暂时不可用', cause)

    expect(error.cause).toBe(cause)
    expect(Object.keys(error)).not.toContain('cause')
  })

  it('does not serialize sensitive cause details', () => {
    const error = new AppError('UPSTREAM_UNAVAILABLE', 503, '服务暂时不可用', {
      secret: 'sensitive-upstream-detail',
    })

    expect(JSON.stringify(error)).not.toContain('cause')
    expect(JSON.stringify(error)).not.toContain('sensitive-upstream-detail')
  })
})
