import { describe, expect, it } from 'vitest'

import {
  calculateTotalAmount,
  maximumPerCodeAmount,
  normalizeCount,
  validateConversionInput,
} from '../../src/web/conversion-input.js'

describe('batch conversion input', () => {
  it.each([
    ['1', 1],
    ['100', 100],
  ])('accepts count %s', (raw, expected) => {
    expect(normalizeCount(raw)).toBe(expected)
  })

  it.each(['', '0', '101', '1.5', '1e2', '+2', '-1'])('rejects count %s', (raw) => {
    expect(() => normalizeCount(raw)).toThrow('invalid count')
  })

  it('calculates the exact total and validates against balance', () => {
    expect(calculateTotalAmount('0.1', 3)).toBe('0.3')
    expect(validateConversionInput('2.5', '4', '10')).toEqual({
      amount: '2.5',
      count: 4,
      totalAmount: '10',
    })
    expect(validateConversionInput('2.5', '5', '10')).toBeNull()
  })

  it('floors all-balance value to eight decimal places', () => {
    expect(maximumPerCodeAmount('10', 3)).toBe('3.33333333')
    expect(maximumPerCodeAmount('0.00000001', 2)).toBeNull()
  })
})
