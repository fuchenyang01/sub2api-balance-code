import { z } from 'zod'

const allowedGroupsSchema = z.unknown().transform((value): number[] => {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) => typeof item === 'number' && Number.isSafeInteger(item) && item > 0,
    )
  ) {
    return []
  }

  return value
})

export const profileSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  balance: z.number().finite(),
  status: z.string(),
  allowed_groups: allowedGroupsSchema.optional().transform((value) => value ?? []),
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
