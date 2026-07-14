import { Decimal } from 'decimal.js'

import { MAX_BATCH_COUNT, MIN_BATCH_COUNT } from '../shared/contracts.js'

export interface ConversionDraft {
  amount: string
  count: number
  totalAmount: string
}

export function normalizeCount(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error('invalid count')

  const count = Number(raw)
  if (!Number.isSafeInteger(count) || count < MIN_BATCH_COUNT || count > MAX_BATCH_COUNT) {
    throw new Error('invalid count')
  }
  return count
}

export function calculateTotalAmount(amount: string, count: number): string {
  return new Decimal(amount).times(count).toFixed()
}

export function validateConversionInput(
  rawAmount: string,
  rawCount: string,
  balance: string,
): ConversionDraft | null {
  if (!/^\d+(?:\.\d{1,8})?$/.test(rawAmount)) return null

  try {
    const count = normalizeCount(rawCount)
    const amount = new Decimal(rawAmount)
    const currentBalance = new Decimal(balance)
    if (!amount.isFinite()
      || !currentBalance.isFinite()
      || !amount.greaterThan(0)
      || amount.decimalPlaces() > 8) {
      return null
    }

    const totalAmount = amount.times(count)
    if (totalAmount.greaterThan(currentBalance)) return null

    return {
      amount: amount.toFixed(),
      count,
      totalAmount: totalAmount.toFixed(),
    }
  } catch {
    return null
  }
}

export function maximumPerCodeAmount(balance: string, count: number): string | null {
  try {
    if (!Number.isSafeInteger(count) || count < MIN_BATCH_COUNT || count > MAX_BATCH_COUNT) {
      return null
    }

    const amount = new Decimal(balance).dividedBy(count).toDecimalPlaces(8, Decimal.ROUND_DOWN)
    return amount.isFinite() && amount.greaterThan(0) ? amount.toFixed() : null
  } catch {
    return null
  }
}
