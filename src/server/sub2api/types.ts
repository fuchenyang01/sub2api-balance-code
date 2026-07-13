import { z } from 'zod'

export const profileSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  balance: z.number().finite(),
  status: z.string(),
})

export const redeemCodeSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(3),
  type: z.string(),
  value: z.number().finite(),
  status: z.string(),
  used_by: z.number().int().nullable(),
  created_at: z.string(),
})

export type Profile = z.infer<typeof profileSchema>
export type RedeemCode = z.infer<typeof redeemCodeSchema>
