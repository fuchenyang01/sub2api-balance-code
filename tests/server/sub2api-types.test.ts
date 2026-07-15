import { describe, expect, it } from 'vitest'

import { profileSchema } from '../../src/server/sub2api/types.js'

const baseProfile = {
  id: 7,
  username: 'alice',
  balance: 10,
  status: 'active',
}

describe('profileSchema', () => {
  it('preserves valid allowed groups', () => {
    expect(profileSchema.parse({ ...baseProfile, allowed_groups: [24, 30] }).allowed_groups).toEqual([
      24,
      30,
    ])
  })

  it('normalizes a missing allowed groups field to an empty array', () => {
    expect(profileSchema.parse(baseProfile).allowed_groups).toEqual([])
  })

  it.each([
    undefined,
    null,
    '24',
    [24, 0],
    [24, 1.5],
    [24, '30'],
  ])('normalizes invalid allowed groups %# to an empty array', (allowed_groups) => {
    expect(profileSchema.parse({ ...baseProfile, allowed_groups }).allowed_groups).toEqual([])
  })
})
