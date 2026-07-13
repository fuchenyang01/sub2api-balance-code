import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import { amountToUpstreamNumber, parseAmount } from '../../src/server/amount.js'
import { AppError } from '../../src/server/errors.js'

function expectInvalidAmount(action: () => unknown): void {
  try {
    action()
    throw new Error('Expected amount validation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'AMOUNT_INVALID', status: 400 })
  }
}

describe('parseAmount', () => {
  it.each(['1', '0.00000001', '001.23000000', '9007199254740993'])(
    'parses valid decimal %s without losing precision',
    (input) => {
      expect(parseAmount(input).equals(new Decimal(input))).toBe(true)
    },
  )

  it('normalizes leading and trailing zeroes', () => {
    expect(parseAmount('001.23000000').toString()).toBe('1.23')
  })

  it.each([
    '',
    ' ',
    ' 1',
    '1 ',
    '+1',
    '-1',
    '1e3',
    'NaN',
    'Infinity',
    '.',
    '.1',
    '1.',
    '0.123456789',
    '0',
    '0.00000000',
  ])('rejects invalid amount %j', (input) => {
    expectInvalidAmount(() => parseAmount(input))
  })
})

describe('amountToUpstreamNumber', () => {
  it.each(['1', '1.23', '0.00000001', '9007199254740992'])(
    'converts exactly representable amount %s',
    (input) => {
      expect(amountToUpstreamNumber(new Decimal(input))).toBe(Number(input))
    },
  )

  it.each(['9007199254740993', '0.100000000000000005'])('rejects lossy conversion of %s', (input) => {
    expectInvalidAmount(() => amountToUpstreamNumber(new Decimal(input)))
  })
})
