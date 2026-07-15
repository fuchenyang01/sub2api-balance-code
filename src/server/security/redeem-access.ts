import { AppError } from '../errors.js'
import type { Profile } from '../sub2api/types.js'

export function requireRedeemAccess(profile: Profile, allowedGroupId: number): void {
  if (profile.allowed_groups.includes(allowedGroupId)) return
  throw new AppError('REDEEM_ACCESS_DENIED', 403, '暂无余额兑换权限')
}
