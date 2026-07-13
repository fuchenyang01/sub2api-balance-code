export const CONVERSION_LOCK_NAME = 'sub2api-code:conversion:v1'

export type CoordinationResult = 'acquired' | 'busy' | 'unavailable'

export interface ConversionCoordinator {
  isAvailable(): boolean
  runExclusive(work: () => Promise<void>): Promise<CoordinationResult>
}

function lockManager(): LockManager | null {
  try {
    return typeof navigator !== 'undefined' && navigator.locks !== undefined
      ? navigator.locks
      : null
  } catch {
    return null
  }
}

export const browserCoordinator: ConversionCoordinator = {
  isAvailable: () => lockManager() !== null,
  async runExclusive(work) {
    const locks = lockManager()
    if (locks === null) return 'unavailable'

    let acquired = false
    let workError: unknown
    try {
      await locks.request(
        CONVERSION_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (lock === null) return
          acquired = true
          try {
            await work()
          } catch (caught) {
            workError = caught
          }
        },
      )
    } catch {
      return 'unavailable'
    }
    if (workError !== undefined) throw workError
    return acquired ? 'acquired' : 'busy'
  },
}
