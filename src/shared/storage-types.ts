interface BatchMetadata {
  version: 2
  operation_id: string
  amount: string
  count: number
}

export interface PreparingOperation extends BatchMetadata {
  state: 'preparing'
}

export interface ExecutableOperation extends BatchMetadata {
  state: 'ready' | 'pending'
  operation_token: string
  expires_at: string
}

export interface ExpiredOperation extends BatchMetadata {
  state: 'expired'
  expires_at: string
}

export type PendingOperation = PreparingOperation | ExecutableOperation | ExpiredOperation

export interface HistoryItem {
  version: 2
  history_id: string
  operation_id: string
  batch_index: number
  batch_size: number
  amount: string
  code: string
  created_at: string
}
