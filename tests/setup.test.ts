import { describe, expect, it } from 'vitest'

describe('runtime prerequisites', () => {
  it('runs on Node.js 22 or newer', () => {
    const majorVersion = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)

    expect(majorVersion).toBeGreaterThanOrEqual(22)
  })
})
