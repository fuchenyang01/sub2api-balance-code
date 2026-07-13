import type { ErrorCode } from '../shared/contracts.js'

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
