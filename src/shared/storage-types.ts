export interface PreparingOperation {
  version: 1
  operation_id: string
  amount: string
  state: 'preparing'
}

export interface ExecutableOperation {
  version: 1
  operation_id: string
  amount: string
  state: 'ready' | 'pending'
  operation_token: string
  expires_at: string
}

export interface ExpiredOperation {
  version: 1
  operation_id: string
  amount: string
  state: 'expired'
  expires_at: string
}

export type PendingOperation = PreparingOperation | ExecutableOperation | ExpiredOperation

export interface HistoryItem {
  version: 1
  operation_id: string
  amount: string
  code: string
  created_at: string
}
