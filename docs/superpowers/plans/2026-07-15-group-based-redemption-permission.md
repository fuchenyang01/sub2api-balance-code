# 基于专属分组的兑换权限实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 只有 sub2api 专属分组 ID `24` 的成员能够登录和执行余额兑换，撤权后下一次请求立即生效，并向未授权用户显示独立的无权限页面。

**架构：** 使用必填环境变量 `REDEEM_ALLOWED_GROUP_ID` 配置唯一允许分组，从 sub2api profile 的 `allowed_groups` 获取实时授权信息。服务端在 session exchange 和每次 `SessionReader` 重验证时调用一个无状态授权函数；前端把稳定的 `REDEEM_ACCESS_DENIED` 错误映射为 `unauthorized` 会话状态。

**技术栈：** Node.js 22、TypeScript、Fastify、Zod、Vue 3、Vitest、Playwright、Docker

---

## 文件结构

- 创建 `src/server/security/redeem-access.ts`：只负责判断 profile 是否包含配置的允许分组，并抛出稳定的权限错误。
- 创建 `tests/server/sub2api-types.test.ts`：独立验证 `allowed_groups` 的安全解析行为。
- 创建 `tests/e2e/authorization.spec.ts`：验证首次拒绝、重新授权以及页面隐藏行为。
- 修改 `src/server/config.ts`：解析必填的正整数分组 ID。
- 修改 `src/server/sub2api/types.ts`：保留合法 `allowed_groups`，把缺失或非法值规范化为空数组。
- 修改 `src/server/routes/session.ts`：在 exchange 和每次 profile 重验证后执行统一权限检查。
- 修改 `src/server/app.ts`、`src/shared/contracts.ts`、`src/web/api.ts`：注册稳定的 `REDEEM_ACCESS_DENIED` 错误契约和安全文案。
- 修改 `src/web/composables/useConversion.ts`：维护独立的 `unauthorized` 状态，并保留当前页的待交换 Token 供重新检查。
- 修改 `src/web/App.vue`：渲染无权限状态，隐藏所有账户和兑换数据。
- 修改服务器、前端和端到端测试夹具：默认用户加入分组 `24`，并允许测试动态撤权和重新授权。
- 修改 `.env.example` 和 `README.md`：补充分组创建、分配、配置和排错说明。

### 任务 1：配置和上游 profile 契约

**文件：**
- 创建：`tests/server/sub2api-types.test.ts`
- 修改：`tests/server/config.test.ts`
- 修改：`src/server/config.ts`
- 修改：`src/server/sub2api/types.ts`
- 修改：`.env.example`

- [ ] **步骤 1：为必填分组配置编写失败测试**

在 `tests/server/config.test.ts` 的 `requiredEnv` 中加入：

```ts
REDEEM_ALLOWED_GROUP_ID: '24',
```

在完整配置断言中加入：

```ts
redeemAllowedGroupId: 24,
```

添加严格解析用例：

```ts
it.each(['', '#24', '0', '-1', '1.5', 'abc', '9007199254740992'])(
  'rejects invalid REDEEM_ALLOWED_GROUP_ID=%s',
  (value) => {
    expect(() => loadConfig(env({ REDEEM_ALLOWED_GROUP_ID: value }))).toThrow()
  },
)
```

同时把 `REDEEM_ALLOWED_GROUP_ID` 加入 `.env.example` 键名断言。

- [ ] **步骤 2：运行配置测试并确认失败**

运行：

```powershell
npx vitest run tests/server/config.test.ts
```

预期：FAIL，`AppConfig` 和实际解析结果尚无 `redeemAllowedGroupId`。

- [ ] **步骤 3：实现必填正整数配置**

在 `src/server/config.ts` 增加：

```ts
const requiredPositiveIntegerEnv = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
```

将它接入 schema、类型和返回对象：

```ts
REDEEM_ALLOWED_GROUP_ID: requiredPositiveIntegerEnv,
```

```ts
redeemAllowedGroupId: number
```

```ts
redeemAllowedGroupId: env.REDEEM_ALLOWED_GROUP_ID,
```

在 `.env.example` 的管理员 Key 后加入：

```dotenv
# Exclusive sub2api group allowed to use balance conversion. Use digits only, without #.
REDEEM_ALLOWED_GROUP_ID=24
```

- [ ] **步骤 4：为 `allowed_groups` 编写失败测试**

创建 `tests/server/sub2api-types.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { profileSchema } from '../../src/server/sub2api/types.js'

const baseProfile = {
  id: 7,
  username: 'alice',
  balance: 10,
  status: 'active',
}

describe('profileSchema allowed_groups', () => {
  it('keeps a valid positive integer group list', () => {
    expect(profileSchema.parse({ ...baseProfile, allowed_groups: [24, 30] }).allowed_groups)
      .toEqual([24, 30])
  })

  it.each([
    undefined,
    null,
    '24',
    [24, 0],
    [24, 1.5],
    [24, '30'],
  ])('normalizes an unsafe group list to empty: %j', (allowed_groups) => {
    expect(profileSchema.parse({ ...baseProfile, allowed_groups }).allowed_groups).toEqual([])
  })
})
```

- [ ] **步骤 5：运行 profile 测试并确认失败**

运行：

```powershell
npx vitest run tests/server/sub2api-types.test.ts
```

预期：FAIL，解析结果尚不包含 `allowed_groups`。

- [ ] **步骤 6：实现安全的分组字段解析**

在 `src/server/sub2api/types.ts` 增加专用 schema：

```ts
const allowedGroupsSchema = z.unknown().transform((value): number[] => {
  if (!Array.isArray(value)) return []
  if (!value.every((item) => (
    typeof item === 'number' && Number.isSafeInteger(item) && item > 0
  ))) return []
  return value
})
```

并在 `profileSchema` 中加入：

```ts
allowed_groups: allowedGroupsSchema,
```

- [ ] **步骤 7：运行任务 1 测试并确认通过**

运行：

```powershell
npx vitest run tests/server/config.test.ts tests/server/sub2api-types.test.ts tests/server/sub2api-clients.test.ts
```

预期：PASS，且现有 profile 客户端测试无回归。

- [ ] **步骤 8：提交任务 1**

```powershell
git add .env.example src/server/config.ts src/server/sub2api/types.ts tests/server/config.test.ts tests/server/sub2api-types.test.ts
git commit -m "feat: parse redemption access group"
```

### 任务 2：服务端统一授权和副作用保护

**文件：**
- 创建：`src/server/security/redeem-access.ts`
- 修改：`src/shared/contracts.ts`
- 修改：`src/server/app.ts`
- 修改：`src/server/routes/session.ts`
- 修改：`tests/server/routes.test.ts`

- [ ] **步骤 1：更新测试基线资料**

在 `tests/server/routes.test.ts` 的配置和默认 profile 中分别加入：

```ts
redeemAllowedGroupId: 24,
```

```ts
allowed_groups: [24],
```

这样现有授权用户测试保持原行为。

- [ ] **步骤 2：编写 exchange 和 `/api/me` 的失败测试**

在 session routes 测试中加入：

```ts
it('rejects a verified user outside the allowed group without setting a cookie', async () => {
  const { app, users } = await setup()
  users.currentProfile = { ...profile, allowed_groups: [] }

  const response = await exchange(app)

  expect(response.statusCode).toBe(403)
  stableError(response, 'REDEEM_ACCESS_DENIED')
  expect(response.headers['set-cookie']).toBeUndefined()
})

it('keeps identity valid but denies /api/me after group removal', async () => {
  const { app, users } = await setup()
  const cookie = await cookieFor(app)
  users.currentProfile = { ...profile, allowed_groups: [] }

  const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })

  expect(response.statusCode).toBe(403)
  stableError(response, 'REDEEM_ACCESS_DENIED')
  expect(response.headers['set-cookie']).toBeUndefined()
})
```

- [ ] **步骤 3：编写 prepare 和 execute 的副作用阻断测试**

为已取得 Cookie、随后被移出分组的用户分别请求 prepare 和 execute，核心断言为：

```ts
expect(response.statusCode).toBe(403)
stableError(response, 'REDEEM_ACCESS_DENIED')
expect(conversions.prepareCalls).toEqual([])
expect(conversions.executeCalls).toEqual([])
```

execute 请求使用合法 payload：

```ts
payload: { operation_token: 'signed-operation-token' },
```

再添加重新授权测试：先令 `/api/me` 返回 `403`，把 `users.currentProfile.allowed_groups` 恢复为 `[24]` 后，同一 Cookie 再次请求应返回 `200`。

- [ ] **步骤 4：运行路由测试并确认失败**

运行：

```powershell
npx vitest run tests/server/routes.test.ts
```

预期：FAIL，错误码和授权检查尚未实现。

- [ ] **步骤 5：注册稳定错误契约**

在 `src/shared/contracts.ts` 的 `errorCodes` 加入：

```ts
'REDEEM_ACCESS_DENIED',
```

在 `src/server/app.ts` 的 `safeMessages` 加入：

```ts
REDEEM_ACCESS_DENIED: '暂无余额兑换权限，请联系管理员',
```

- [ ] **步骤 6：实现无状态授权函数**

创建 `src/server/security/redeem-access.ts`：

```ts
import { AppError } from '../errors.js'
import type { Profile } from '../sub2api/types.js'

export function requireRedeemAccess(profile: Profile, allowedGroupId: number): void {
  if (profile.allowed_groups.includes(allowedGroupId)) return
  throw new AppError('REDEEM_ACCESS_DENIED', 403, '暂无余额兑换权限')
}
```

- [ ] **步骤 7：接入 exchange 和重验证边界**

在 `src/server/routes/session.ts` 导入 `requireRedeemAccess`。

在 `revalidateSession` 校验 `latest.id === identity.userId` 后调用：

```ts
requireRedeemAccess(latest, dependencies.config.redeemAllowedGroupId)
```

在 `/api/session/exchange` 中，`exchangeIdentity` 成功后、`sealSession` 之前调用：

```ts
requireRedeemAccess(profile, dependencies.config.redeemAllowedGroupId)
```

不要在 `403` 时调用 `clearSessionCookie`；现有全局错误处理只会为指定 `401` 错误清 Cookie。

- [ ] **步骤 8：运行服务端测试并确认通过**

运行：

```powershell
npx vitest run tests/server/routes.test.ts tests/server/errors.test.ts tests/server/sub2api-clients.test.ts
```

预期：PASS；撤权后的 prepare 和 execute 均未进入 `FakeConversions`。

- [ ] **步骤 9：提交任务 2**

```powershell
git add src/shared/contracts.ts src/server/app.ts src/server/routes/session.ts src/server/security/redeem-access.ts tests/server/routes.test.ts
git commit -m "feat: enforce redemption group access"
```

### 任务 3：前端无权限状态和重新检查

**文件：**
- 修改：`src/web/api.ts`
- 修改：`src/web/composables/useConversion.ts`
- 修改：`src/web/App.vue`
- 修改：`tests/web/useConversion.test.ts`
- 修改：`tests/web/components.test.ts`

- [ ] **步骤 1：编写 controller 状态失败测试**

在 `tests/web/useConversion.test.ts` 添加首次 exchange 拒绝测试：

```ts
it('enters unauthorized state and retries the in-memory exchange token', async () => {
  const exchange = vi.fn()
    .mockRejectedValueOnce(new ApiClientError('REDEEM_ACCESS_DENIED', 403, 'denied'))
    .mockResolvedValueOnce({ id: 7, username: 'alice', balance: '10' })
  const me = vi.fn().mockResolvedValue({ id: 7, username: 'alice', balance: '10' })
  window.history.replaceState({}, '', '/?token=user-jwt')
  const conversion = createUseConversion(api({ exchange, me }), storage())

  await conversion.initialize()
  expect(conversion.session.value).toBe('unauthorized')
  expect(conversion.profile.value).toBeNull()

  await conversion.refresh()
  expect(exchange).toHaveBeenCalledTimes(2)
  expect(conversion.session.value).toBe('authenticated')
})
```

添加已登录状态撤权测试：让 `me` 返回 `REDEEM_ACCESS_DENIED`，断言 `session` 变成 `unauthorized`、`profile` 清空，但存储中的 pending 记录没有被删除。

- [ ] **步骤 2：编写 App 无权限页面失败测试**

让 `tests/web/components.test.ts` 的 `appController` 支持可变 `profile`，mock 使用：

```ts
profile: ref(appController.profile),
```

添加测试：

```ts
it('shows access guidance without account or conversion data', async () => {
  appController.session = 'unauthorized'
  appController.profile = null
  appController.pendingOperation = {
    version: 2,
    operation_id: 'hidden-operation',
    amount: '1',
    count: 1,
    state: 'pending',
    operation_token: 'hidden-token',
    expires_at: '2099-07-15T00:00:00.000Z',
  }

  const wrapper = mount(App)

  expect(wrapper.text()).toContain('暂无余额兑换权限')
  expect(wrapper.text()).toContain('当前账号未加入“分销代理”专属分组，请联系管理员。')
  expect(wrapper.find('[aria-label="兑换金额"]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('hidden-operation')
  await wrapper.get('[data-testid="retry-access"]').trigger('click')
  expect(appController.refresh).toHaveBeenCalled()
})
```

在测试结束或 `beforeEach` 中把 controller 状态恢复为 authenticated，避免污染其他用例。

- [ ] **步骤 3：运行前端测试并确认失败**

运行：

```powershell
npx vitest run tests/web/useConversion.test.ts tests/web/components.test.ts
```

预期：FAIL，`unauthorized` 状态和无权限页面尚未实现。

- [ ] **步骤 4：实现错误文案和 controller 状态**

在 `src/web/api.ts` 的安全错误文案表加入：

```ts
REDEEM_ACCESS_DENIED: '暂无余额兑换权限，请联系管理员',
```

在 `src/web/composables/useConversion.ts` 扩展类型：

```ts
export type SessionState = 'loading' | 'authenticated' | 'unauthorized' | 'expired' | 'error'
```

增加错误集合：

```ts
const accessCodes = new Set<ErrorCode>(['REDEEM_ACCESS_DENIED'])
```

在 `handleError` 中先处理权限错误，并保持 `pendingExchangeToken` 不变：

```ts
if (accessCodes.has(safeError.code)) {
  session.value = 'unauthorized'
  profile.value = null
} else if (sessionCodes.has(safeError.code)) {
  pendingExchangeToken = null
  session.value = 'expired'
  profile.value = null
} else if (session.value === 'loading') {
  session.value = 'error'
}
```

权限错误不加入 `retryableCodes`，页面按钮是显式权限重查，不是自动重试。

- [ ] **步骤 5：实现无权限页面**

在 `src/web/App.vue` 的服务异常分支之后、会话失效分支之前加入：

```vue
<section
  v-else-if="conversion.session.value === 'unauthorized'"
  class="session-state session-expired"
  aria-labelledby="access-denied-title"
>
  <LockKeyhole :size="24" aria-hidden="true" />
  <div>
    <h1 id="access-denied-title">暂无余额兑换权限</h1>
    <p>当前账号未加入“分销代理”专属分组，请联系管理员。</p>
    <button
      type="button"
      class="secondary-button session-retry"
      data-testid="retry-access"
      :disabled="conversion.busy.value"
      @click="conversion.refresh"
    >
      重新检查
    </button>
  </div>
</section>
```

因为该分支位于工具主体之前，表单、历史和 pending 恢复组件不会渲染。

- [ ] **步骤 6：运行前端测试并确认通过**

运行：

```powershell
npx vitest run tests/web/useConversion.test.ts tests/web/components.test.ts
```

预期：PASS，无权限状态可重新检查且不显示兑换数据。

- [ ] **步骤 7：提交任务 3**

```powershell
git add src/web/api.ts src/web/composables/useConversion.ts src/web/App.vue tests/web/useConversion.test.ts tests/web/components.test.ts
git commit -m "feat: show redemption access state"
```

### 任务 4：端到端权限切换验证

**文件：**
- 修改：`tests/e2e/fixtures/mock-sub2api.ts`
- 修改：`tests/e2e/fixtures/test-server.ts`
- 修改：`tests/e2e/fixtures/test-server.test.ts`
- 创建：`tests/e2e/authorization.spec.ts`

- [ ] **步骤 1：扩展 mock 的实时分组状态**

在 `MockSub2Api` 接口加入：

```ts
setAllowedGroups(groupIds: number[]): void
```

在 mock 实现中设置默认值并返回到 profile：

```ts
let allowedGroups = [24]
```

```ts
allowed_groups: allowedGroups,
```

返回对象加入：

```ts
setAllowedGroups: (groupIds) => { allowedGroups = [...groupIds] },
```

关闭 mock 时重置为 `[24]`。在 `tests/e2e/fixtures/test-server.test.ts` 的 `fakeMock` 返回对象中加入：

```ts
setAllowedGroups: vi.fn(),
```

在 `tests/e2e/fixtures/test-server.ts` 的 `AppConfig` 增加：

```ts
redeemAllowedGroupId: 24,
```

- [ ] **步骤 2：编写首次拒绝和重新授权 E2E 测试**

创建 `tests/e2e/authorization.spec.ts`：

```ts
import { expect, test } from './fixtures/test-server.js'

test('denies a non-member and accepts the same page after group assignment', async ({
  page,
  environment,
}) => {
  environment.mock.setAllowedGroups([])
  await page.goto(environment.authenticatedUrl())

  await expect(page.getByRole('heading', { name: '暂无余额兑换权限' })).toBeVisible()
  await expect(page.getByLabel('兑换金额')).toHaveCount(0)
  expect(environment.mock.totalGenerateRequests()).toBe(0)
  expect(environment.mock.totalDebitRequests()).toBe(0)

  environment.mock.setAllowedGroups([24])
  await page.getByTestId('retry-access').click()

  await expect(page.getByText('测试用户')).toBeVisible()
  await expect(page.getByLabel('兑换金额')).toBeVisible()
})
```

- [ ] **步骤 3：编写已有会话撤权 E2E 测试**

先正常打开工具建立 Cookie，再把 mock 分组清空并点击账户刷新按钮：

```ts
await page.goto(environment.authenticatedUrl())
await expect(page.getByText('测试用户')).toBeVisible()
environment.mock.setAllowedGroups([])
await page.getByLabel('刷新账户信息').click()
await expect(page.getByRole('heading', { name: '暂无余额兑换权限' })).toBeVisible()
await expect(page.getByLabel('兑换金额')).toHaveCount(0)
```

恢复 `[24]` 后点击“重新检查”，断言工具重新出现。

- [ ] **步骤 4：运行权限 E2E 并确认通过**

运行：

```powershell
npx playwright test tests/e2e/authorization.spec.ts
```

预期：2 个测试 PASS，首次登录和已有会话两种路径均可撤权并重新授权。

- [ ] **步骤 5：运行现有核心 E2E 回归**

运行：

```powershell
npx playwright test tests/e2e/conversion.spec.ts tests/e2e/iframe.spec.ts tests/e2e/mobile.spec.ts
```

预期：全部 PASS，批量兑换、iframe 和移动端行为无回归。

- [ ] **步骤 6：提交任务 4**

```powershell
git add tests/e2e/fixtures/mock-sub2api.ts tests/e2e/fixtures/test-server.ts tests/e2e/fixtures/test-server.test.ts tests/e2e/authorization.spec.ts
git commit -m "test: cover redemption group authorization"
```

### 任务 5：新手部署文档和权限排错

**文件：**
- 修改：`README.md`
- 测试：`tests/deployment.test.ts`
- 测试：`tests/setup.test.ts`

- [ ] **步骤 1：为部署文档编写失败断言**

在 `tests/deployment.test.ts` 或 `tests/setup.test.ts` 中加入对以下内容的断言：

```ts
expect(readme).toContain('REDEEM_ALLOWED_GROUP_ID=24')
expect(readme).toContain('分销代理')
expect(readme).toContain('专属分组')
expect(readme).toContain('不要填写 `#24`')
```

- [ ] **步骤 2：运行文档测试并确认失败**

运行：

```powershell
npx vitest run tests/deployment.test.ts tests/setup.test.ts
```

预期：FAIL，README 尚未描述新的必填权限配置。

- [ ] **步骤 3：更新 README 部署教程**

在生产 `.env`、本地 `.env` 示例和环境变量表中加入：

```dotenv
REDEEM_ALLOWED_GROUP_ID=24
```

在新手部署步骤中明确写出：

1. sub2api 管理后台进入“分组管理”。
2. 创建或确认“分销代理”为启用的专属分组。
3. 在列设置中显示 ID，`#24` 对应配置值 `24`。
4. 在用户管理的分组配置中给授权用户勾选该专属分组。
5. `.env` 只填写数字 `24`，不要填写 `#24`。
6. 修改 `.env` 后删除并重建容器，使新变量进入进程环境。

增加排错项：无权限用户检查分组类型、状态、用户 `allowed_groups` 和环境变量；说明 sub2api 菜单可能仍对普通用户可见，但后端会返回 `403`。

- [ ] **步骤 4：运行文档测试并确认通过**

运行：

```powershell
npx vitest run tests/deployment.test.ts tests/setup.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交任务 5**

```powershell
git add README.md tests/deployment.test.ts tests/setup.test.ts
git commit -m "docs: explain redemption group access"
```

### 任务 6：完整验证和交付准备

**文件：**
- 检查：本计划涉及的全部源码、测试和文档

- [ ] **步骤 1：运行完整单元与组件测试**

运行：

```powershell
npm test
```

预期：所有 Vitest 测试 PASS，零失败。

- [ ] **步骤 2：运行类型检查和生产构建**

运行：

```powershell
npm run typecheck
npm run build
```

预期：两个命令均以退出码 `0` 完成。

- [ ] **步骤 3：运行完整端到端测试**

运行：

```powershell
npm run test:e2e
```

预期：所有 Playwright 测试 PASS，零失败。

- [ ] **步骤 4：检查差异和敏感信息**

运行：

```powershell
git diff --check
git status --short
git diff --name-only origin/main...HEAD
```

确认没有意外文件、真实 Token、管理员 API Key、会话 Cookie 或 `.env` 被提交。

- [ ] **步骤 5：对照设计规格复核**

逐项核对 `docs/superpowers/specs/2026-07-15-group-based-redemption-permission-design.md`：配置默认拒绝、exchange、`/api/me`、prepare、execute、恢复操作、无权限页面、重新授权、README 和生产部署说明均有实现或测试证据。

- [ ] **步骤 6：准备部署配置**

生产发布时在服务器 `/opt/sub2api-balance-code/.env` 添加：

```dotenv
REDEEM_ALLOWED_GROUP_ID=24
```

该步骤只记录部署要求；实际修改服务器、重建容器和线上权限验证必须在代码合并并推送后执行。
