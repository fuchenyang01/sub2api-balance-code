export const errorCodes = [
  'SESSION_REQUIRED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'AMOUNT_INVALID',
  'AMOUNT_EXCEEDS_BALANCE',
  'OPERATION_TOKEN_INVALID',
  'OPERATION_TOKEN_EXPIRED',
  'OPERATION_TERMINATED',
  'CONVERSION_IN_PROGRESS',
  'CONVERSION_PENDING',
  'RATE_LIMITED',
  'UPSTREAM_AUTH_FAILED',
  'UPSTREAM_IDEMPOTENCY_UNAVAILABLE',
  'UPSTREAM_DATA_CONFLICT',
  'UPSTREAM_UNAVAILABLE',
  'MANUAL_REVIEW_REQUIRED',
] as const

export type ErrorCode = (typeof errorCodes)[number]

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; request_id: string }
}

export interface MeResponse {
  id: number
  username: string
  balance: string
}

export interface PrepareRequest {
  operation_id: string
  amount: string
}

export interface PrepareResponse {
  operation_token: string
  expires_at: string
  amount: string
}

export interface ExecuteRequest {
  operation_token: string
}

export type ExecuteResponse =
  | {
      status: 'completed'
      operation_id: string
      amount: string
      code: string
      created_at: string
    }
  | { status: 'pending'; operation_id: string; error: ErrorCode }
