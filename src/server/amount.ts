import { Decimal } from 'decimal.js'

import { AppError } from './errors.js'

const amountPattern = /^\d+(?:\.\d{1,8})?$/

export function parseAmount(input: string): Decimal {
  if (!amountPattern.test(input)) {
    throw new AppError('AMOUNT_INVALID', 400, '金额格式无效')
  }

  const value = new Decimal(input)
  if (value.lte(0)) {
    throw new AppError('AMOUNT_INVALID', 400, '金额必须大于 0')
  }

  return value
}

export function amountToUpstreamNumber(value: Decimal): number {
  const output = value.toNumber()
  if (!Number.isFinite(output) || !new Decimal(output).equals(value)) {
    throw new AppError('AMOUNT_INVALID', 400, '金额无法安全转换')
  }

  return output
}
