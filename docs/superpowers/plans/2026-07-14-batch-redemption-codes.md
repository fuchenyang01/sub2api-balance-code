# 批量生成兑换码实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让用户指定单码面值和 1 到 100 的数量，用一个可恢复批次一次调用 sub2api 批量建码、一次扣除总额，并显示、复制和持久化所有兑换码。

**架构：** 扩展现有 `prepare -> execute` 合约，将数量签入操作令牌，服务端从单码面值和数量重新计算总额。正常路径使用一次 sub2api `count` 批量建码和一次总额扣款；前端将完整批次写入版本 2 本地历史，并对版本 1 待处理记录、历史和操作令牌按数量 1 兼容。

**技术栈：** TypeScript、Vue 3、Fastify、Decimal.js、Zod、JOSE、Vitest + jsdom、Playwright Chromium、Docker、Nginx

---

## 文件结构

- 创建：`src/web/conversion-input.ts`，负责数量规范化、总额计算、整单验证和“全部余额”单码面值计算。
- 创建：`tests/web/conversion-input.test.ts`，锁定 1 到 100 的数量边界和 Decimal 数值行为。
- 修改：`src/shared/contracts.ts`，定义批量请求、响应和公共数量上限。
- 修改：`src/server/security/secrets.ts`，将 `count` 签入新操作令牌，并把旧令牌解析为 `count=1`。
- 修改：`src/server/routes/conversions.ts`，严格验证 `count` 并传入服务。
- 修改：`src/server/sub2api/admin-client.ts`，实现一次批量建码和一次批量删除。
- 修改：`src/server/conversion/service.ts`，执行整批校验、总额扣款、批量补偿和幂等恢复。
- 修改：`src/shared/storage-types.ts` 和 `src/web/storage.ts`，实现版本 2 待处理记录/历史和版本 1 迁移。
- 修改：`src/web/api.ts` 和 `src/web/composables/useConversion.ts`，严格解析批次响应，编排一个批次并一次发布所有历史。
- 修改：`src/web/App.vue`、`src/web/components/ConversionForm.vue`、`ConfirmDialog.vue`、`ConversionResult.vue`、`HistoryList.vue` 和 `src/web/styles.css`，提供数量、总额、批量结果和窄屏界面。
- 修改：`tests/server/secrets.test.ts`、`routes.test.ts`、`sub2api-clients.test.ts`、`conversion-service.test.ts`，验证服务端合约和上游调用次数。
- 修改：`tests/web/storage.test.ts`、`useConversion.test.ts`、`components.test.ts`，验证迁移、编排和界面。
- 修改：`tests/e2e/fixtures/mock-sub2api.ts`、`browser-assertions.ts`、`tests/e2e/conversion.spec.ts`、`iframe.spec.ts` 和 `mobile.spec.ts`，在真实浏览器中验收批量请求、复制和响应式布局。
- 修改：`README.md`，说明批量用法、限流语义和 sub2api 非事务批量的已知限制。

## 任务 1：批次公共合约和输入数学

**文件：**
- 创建：`src/web/conversion-input.ts`
- 创建：`tests/web/conversion-input.test.ts`
- 修改：`src/shared/contracts.ts`

- [ ] **步骤 1：编写数量、总额和全部余额的失败测试**

```ts
import { describe, expect, it } from 'vitest'

import {
  calculateTotalAmount,
  maximumPerCodeAmount,
  normalizeCount,
  validateConversionInput,
} from '../../src/web/conversion-input.js'

describe('batch conversion input', () => {
  it.each([['1', 1], ['100', 100]])('accepts count %s', (raw, expected) => {
    expect(normalizeCount(raw)).toBe(expected)
  })

  it.each(['', '0', '101', '1.5', '1e2', '+2', '-1'])('rejects count %s', (raw) => {
    expect(() => normalizeCount(raw)).toThrow('invalid count')
  })

  it('calculates the exact total and validates against balance', () => {
    expect(calculateTotalAmount('0.1', 3)).toBe('0.3')
    expect(validateConversionInput('2.5', '4', '10')).toEqual({
      amount: '2.5', count: 4, totalAmount: '10',
    })
    expect(validateConversionInput('2.5', '5', '10')).toBeNull()
  })

  it('floors all-balance value to eight decimal places', () => {
    expect(maximumPerCodeAmount('10', 3)).toBe('3.33333333')
    expect(maximumPerCodeAmount('0.00000001', 2)).toBeNull()
  })
})
```

- [ ] **步骤 2：运行新测试并确认模块不存在**

运行：`npx vitest run tests/web/conversion-input.test.ts`

预期：FAIL，报错无法加载 `src/web/conversion-input.ts`。

- [ ] **步骤 3：定义统一批量合约**

```ts
export const MIN_BATCH_COUNT = 1
export const MAX_BATCH_COUNT = 100

export interface PrepareRequest {
  operation_id: string
  amount: string
  count: number
}

export interface PrepareResponse {
  operation_token: string
  expires_at: string
  amount: string
  count: number
  total_amount: string
}

export interface CompletedCode {
  code: string
  created_at: string
}

export type ExecuteResponse =
  | {
      status: 'completed'
      operation_id: string
      amount: string
      count: number
      total_amount: string
      codes: CompletedCode[]
    }
  | { status: 'pending'; operation_id: string; error: ErrorCode }
```

用上述定义替换 `src/shared/contracts.ts` 中的单码合约。在 `src/web/conversion-input.ts` 导出下列界面草稿类型，并用 `Decimal` 实现测试中的四个函数：

```ts
export interface ConversionDraft {
  amount: string
  count: number
  totalAmount: string
}
```

`maximumPerCodeAmount` 使用 `Decimal.ROUND_DOWN` 保留 8 位后再用 `toFixed()` 去掉多余末尾零。

- [ ] **步骤 4：运行输入测试和类型检查**

运行：

```powershell
npx vitest run tests/web/conversion-input.test.ts
npm run typecheck
```

预期：新输入测试 PASS；类型检查因旧调用方尚未传入 `count` 或仍读取 `response.code` 而 FAIL。这些跨任务类型错误记录为任务 2 至 7 的待修复列表，不通过放宽合约消除。

- [ ] **步骤 5：提交合约和输入数学**

```powershell
git add src/shared/contracts.ts src/web/conversion-input.ts tests/web/conversion-input.test.ts
git diff --cached --check
git commit -m "feat: define batch conversion input"
```

## 任务 2：操作令牌和路由数量校验

**文件：**
- 修改：`src/server/security/secrets.ts`
- 修改：`src/server/routes/conversions.ts`
- 修改：`tests/server/secrets.test.ts`
- 修改：`tests/server/routes.test.ts`

- [ ] **步骤 1：编写新令牌和旧令牌兼容测试**

`tests/server/secrets.test.ts` 已有 `makeOperationToken()`；在它之后增加生成完整标准 claim 的帮助函数：

```ts
function operationClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    amount: '2.5',
    iss: 'sub2api-balance-code',
    aud: 'balance-conversion',
    sub: '7',
    jti: operationId,
    iat: Math.floor(now.getTime() / 1_000),
    exp: Math.floor(now.getTime() / 1_000) + 3_600,
    ...overrides,
  }
}
```

在 `tests/server/secrets.test.ts` 添加：

```ts
it('signs and verifies an explicit batch count', async () => {
  const subject = service()
  const signed = await subject.signOperation({
    operationId, userId: 7, amount: '2.5', count: 100,
  })
  await expect(subject.verifyOperation(signed.token, 7)).resolves.toMatchObject({
    operationId, userId: 7, amount: '2.5', count: 100,
  })
})

it('treats a valid legacy operation without count as a single-code batch', async () => {
  const token = await makeOperationToken(operationClaims())
  await expect(service().verifyOperation(token, 7)).resolves.toMatchObject({ count: 1 })
})

it.each([0, 101, 1.5, '2'])('rejects invalid operation count %s', async (count) => {
  const token = await makeOperationToken(operationClaims({ count }))
  await expectAppError(() => service().verifyOperation(token, 7), 'OPERATION_TOKEN_INVALID')
})
```

在现有测试帮助函数中使用与生产相同的 issuer、audience 和 HS256 密钥派生，显式区分缺失 `count` 和伪造 `count`。

- [ ] **步骤 2：编写路由严格校验测试**

在 `tests/server/routes.test.ts` 将有效 prepare 请求补上 `count: 1`，并添加：

```ts
it.each([0, 101, 1.5, '2', null])('rejects invalid prepare count %s', async (count) => {
  const { app, conversions } = await setup()
  const userJwt = jwt()
  const cookie = await cookieFor(app, userJwt)
  const response = await app.inject({
    method: 'POST', url: '/api/conversions/prepare',
    headers: { origin: appOrigin, cookie },
    payload: { operation_id: operationId, amount: '1', count },
  })
  expect(response.statusCode).toBe(400)
  stableError(response, 'AMOUNT_INVALID')
  expect(conversions.prepareCalls).toHaveLength(0)
})

it('passes one batch count without multiplying rate-limit usage', async () => {
  const { app, conversions } = await setup()
  const userJwt = jwt()
  const cookie = await cookieFor(app, userJwt)
  const response = await app.inject({
    method: 'POST', url: '/api/conversions/prepare',
    headers: { origin: appOrigin, cookie },
    payload: { operation_id: operationId, amount: '1', count: 100 },
  })
  expect(response.statusCode).toBe(200)
  expect(conversions.prepareCalls).toEqual([[userJwt, 7, operationId, '1', 100]])
})
```

- [ ] **步骤 3：运行定向测试确认红灯**

运行：`npx vitest run tests/server/secrets.test.ts tests/server/routes.test.ts`

预期：FAIL，`signOperation` 不接受 `count`，路由不传入数量。

- [ ] **步骤 4：实现数量签名和路由传递**

```ts
export interface OperationPayload {
  version: 1
  operationId: string
  userId: number
  amount: string
  count: number
  issuedAt: string
  expiresAt: string
}

function operationCount(value: unknown): number {
  if (value === undefined) return 1
  if (typeof value !== 'number' || !Number.isInteger(value)
    || value < MIN_BATCH_COUNT || value > MAX_BATCH_COUNT) throw invalidOperation()
  return value
}
```

`signOperation` 必须显式要求 `count`，新 JWT payload 使用 `{ version: 1, amount, count }`。`validateOperationPayload` 调用 `operationCount(payload.count)`，让缺失数量的旧令牌得到 1，但拒绝任何显式非法值。

`prepareBodySchema` 将 `count` 加入 `required`，并使用 `{ type: 'integer', minimum: 1, maximum: 100 }`。`ConversionOperations.prepare` 和路由调用末尾增加 `count: number`。

- [ ] **步骤 5：运行令牌和路由测试并提交**

```powershell
npx vitest run tests/server/secrets.test.ts tests/server/routes.test.ts
git add src/server/security/secrets.ts src/server/routes/conversions.ts tests/server/secrets.test.ts tests/server/routes.test.ts
git diff --cached --check
git commit -m "feat: sign batch conversion count"
```

预期：两个测试文件全部 PASS。

## 任务 3：sub2api 批量建码和批量删除客户端

**文件：**
- 修改：`src/server/sub2api/admin-client.ts`
- 修改：`tests/server/sub2api-clients.test.ts`

- [ ] **步骤 1：把单码客户端测试改为批量契约**

```ts
it('generates one batch with one upstream request', async () => {
  handler = async (request, response) => {
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/api/v1/admin/redeem-codes/generate')
    expect(request.headers['idempotency-key']).toBe('code-op-batch')
    expect(await readJson(request)).toEqual({ count: 3, type: 'balance', value: 12.5 })
    json(response, 200, { code: 0, message: 'success', data: [
      redeemCode,
      { ...redeemCode, id: 12, code: 'ABC-124' },
      { ...redeemCode, id: 13, code: 'ABC-125' },
    ] })
  }
  const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)
  await expect(client.generateCodes('op-batch', 12.5, 3)).resolves.toHaveLength(3)
})

it('rejects a response whose length differs from the requested count', async () => {
  handler = (_request, response) => json(response, 200, {
    code: 0, message: 'success', data: [redeemCode],
  })
  const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)
  await expect(client.generateCodes('op-batch', 12.5, 3)).rejects.toSatisfy(
    (error: unknown) => isUpstreamError(error, 'invalid-response'),
  )
})

it('batch deletes exact code IDs in one request', async () => {
  handler = async (request, response) => {
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/api/v1/admin/redeem-codes/batch-delete')
    expect(await readJson(request)).toEqual({ ids: [11, 12, 13] })
    json(response, 200, { code: 0, message: 'success', data: { deleted: 3 } })
  }
  const client = new Sub2ApiAdminClient(baseUrl, 'admin-secret', 1_000)
  await expect(client.batchDeleteCodes([11, 12, 13])).resolves.toBe(3)
})
```

- [ ] **步骤 2：运行客户端测试确认红灯**

运行：`npx vitest run tests/server/sub2api-clients.test.ts`

预期：FAIL，`generateCodes` 和 `batchDeleteCodes` 不存在。

- [ ] **步骤 3：实现动态长度批量解析**

```ts
export interface AdminClient {
  generateCodes(operationId: string, amount: number, count: number): Promise<RedeemCode[]>
  batchDeleteCodes(ids: number[]): Promise<number>
  getCode(id: number): Promise<RedeemCode | null>
  deleteCode(id: number): Promise<'deleted' | 'missing'>
  debitBalance(userId: number, operationId: string, amount: number): Promise<void>
}

async generateCodes(operationId: string, amount: number, count: number): Promise<RedeemCode[]> {
  const codes = await this.#request('/api/v1/admin/redeem-codes/generate',
    z.array(redeemCodeSchema).min(1).max(MAX_BATCH_COUNT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `code-${operationId}` },
      body: JSON.stringify({ count, type: 'balance', value: amount }),
    })
  if (codes.length !== count) {
    throw new UpstreamError('invalid-response', 'generated code count mismatch')
  }
  return codes
}
```

按 `src/server/sub2api/http.ts` 现有 `UpstreamError` 构造签名创建 `invalid-response`，不自行造不匹配的异常。`batchDeleteCodes` 请求 `/batch-delete`，使用严格 `z.object({ deleted: z.number().int().nonnegative() }).strict()` 解析数量。保留旧单码查询/删除方法，避免扩大无关删除范围。

- [ ] **步骤 4：运行测试并提交**

```powershell
npx vitest run tests/server/sub2api-clients.test.ts
git add src/server/sub2api/admin-client.ts tests/server/sub2api-clients.test.ts
git diff --cached --check
git commit -m "feat: call sub2api batch code APIs"
```

## 任务 4：单操作批量服务、总额扣款和补偿

**文件：**
- 修改：`src/server/conversion/service.ts`
- 修改：`tests/server/conversion-service.test.ts`

- [ ] **步骤 1：扩展测试替身以记录批量调用**

先将 `FakeSecrets` 的签名输入和默认 payload 增加数量：

```ts
readonly signed: Array<{ operationId: string; userId: number; amount: string; count: number }> = []
payload: OperationPayload = {
  version: 1, operationId, userId, amount: '10', count: 1, issuedAt: now, expiresAt,
}

async signOperation(input: {
  operationId: string; userId: number; amount: string; count: number
}): Promise<{ token: string; expiresAt: string }> {
  this.signed.push(input)
  return { token: `token-${input.operationId}`, expiresAt }
}
```

将测试 `FakeAdminClient` 的核心方法改为：

```ts
generateCalls: Array<[string, number, number]> = []
debitCalls: Array<[number, string, number]> = []
batchDeleteCalls: number[][] = []
generatedCodes: RedeemCode[] = [code()]
batchDeleted: number | undefined
debitError: unknown

async generateCodes(operationId: string, amount: number, count: number): Promise<RedeemCode[]> {
  this.generateCalls.push([operationId, amount, count])
  return this.generatedCodes
}

async batchDeleteCodes(ids: number[]): Promise<number> {
  this.batchDeleteCalls.push(ids)
  return this.batchDeleted ?? ids.length
}

async debitBalance(id: number, operationId: string, amount: number): Promise<void> {
  this.debitCalls.push([id, operationId, amount])
  if (this.debitError !== undefined) throw this.debitError
}
```

为测试批次创建稳定的上游记录：

```ts
function codes(count: number, value: number): RedeemCode[] {
  return Array.from({ length: count }, (_, index) => code({
    id: index + 1,
    code: `CODE-${index + 1}`,
    value,
  }))
}
```

- [ ] **步骤 2：编写批量正常路径和总额测试**

```ts
it('prepares one batch against total balance and signs count', async () => {
  const { service, users, secrets } = setup()
  users.profile.balance = 30
  await expect(service.prepare('user-jwt', userId, operationId, '2.5', 10)).resolves.toEqual({
    operation_token: `token-${operationId}`, expires_at: expiresAt,
    amount: '2.5', count: 10, total_amount: '25',
  })
  expect(secrets.signed).toEqual([{ operationId, userId, amount: '2.5', count: 10 }])
})

it('generates once and debits the batch total once', async () => {
  const { service, admin, secrets } = setup()
  admin.generatedCodes = codes(10, 2.5)
  secrets.payload = { version: 1, operationId, userId, amount: '2.5', count: 10,
    issuedAt: now, expiresAt }
  const result = await service.execute('operation-token', 'user-jwt', userId)
  expect(admin.generateCalls).toEqual([[operationId, 2.5, 10]])
  expect(admin.debitCalls).toEqual([[userId, operationId, 25]])
  expect(result).toMatchObject({
    status: 'completed', operation_id: operationId,
    amount: '2.5', count: 10, total_amount: '25',
  })
  expect(result.status === 'completed' && result.codes).toHaveLength(10)
})
```

- [ ] **步骤 3：编写整批校验、不确定结果和批量补偿测试**

```ts
it.each([
  ['duplicate id', (items: RedeemCode[]) => [items[0]!, { ...items[1]!, id: items[0]!.id }]],
  ['duplicate code', (items: RedeemCode[]) => [items[0]!, { ...items[1]!, code: items[0]!.code }]],
  ['wrong value', (items: RedeemCode[]) => [{ ...items[0]!, value: 9 }, items[1]!]],
] as const)('keeps invalid generated batch hidden: %s', async (_name, mutate) => {
  const { service, admin } = setup()
  admin.generatedCodes = mutate(codes(2, 2.5))
  const response = await service.execute('operation-token', 'user-jwt', userId)
  expect(response).toEqual({
    status: 'pending', operation_id: operationId, error: 'MANUAL_REVIEW_REQUIRED',
  })
  expect(admin.debitCalls).toHaveLength(0)
})

it('batch deletes all generated codes after a deterministic insufficient debit', async () => {
  const { service, admin } = setup()
  admin.generatedCodes = codes(3, 2.5)
  admin.debitError = upstream('insufficient-balance')
  await expect(service.execute('operation-token', 'user-jwt', userId))
    .rejects.toMatchObject({ code: 'OPERATION_TERMINATED' })
  expect(admin.batchDeleteCalls).toEqual([[1, 2, 3]])
})

it('requires manual review when batch deletion count differs', async () => {
  const { service, admin } = setup()
  admin.generatedCodes = codes(3, 2.5)
  admin.debitError = upstream('insufficient-balance')
  admin.batchDeleted = 2
  const response = await service.execute('operation-token', 'user-jwt', userId)
  expect(response).toEqual({
    status: 'pending', operation_id: operationId, error: 'MANUAL_REVIEW_REQUIRED',
  })
})
```

另覆盖建码超时、扣款超时、批量删除超时、数量 100、总额超过 profile 余额、总额无法精确转为上游 number，以及同用户两批次仍串行的现有互斥语义。

- [ ] **步骤 4：运行服务测试确认红灯**

运行：`npx vitest run tests/server/conversion-service.test.ts`

预期：FAIL，服务仍调用 `generateCode/getCode/deleteCode`，且只返回单个 `code`。

- [ ] **步骤 5：实现批量服务**

`prepare` 增加 `count`，用 `new Decimal(amount).mul(count)` 得到标准化 `total_amount`，按总额校验 profile，签名时传入 count。

`#executeLocked` 实现下列固定顺序：

```ts
const amount = parseAmount(operation.amount)
const total = amount.mul(operation.count)
const upstreamAmount = amountToUpstreamNumber(amount)
const upstreamTotal = amountToUpstreamNumber(total)
const generated = await this.#admin.generateCodes(
  operation.operationId, upstreamAmount, operation.count,
)
if (!isValidGeneratedBatch(generated, amount, operation.count)) {
  return { status: 'pending', operation_id: operation.operationId, error: 'MANUAL_REVIEW_REQUIRED' }
}
await this.#admin.debitBalance(operation.userId, operation.operationId, upstreamTotal)
return {
  status: 'completed', operation_id: operation.operationId,
  amount: operation.amount, count: operation.count, total_amount: total.toFixed(),
  codes: generated.map(({ code, created_at }) => ({ code, created_at })),
}
```

`isValidGeneratedBatch` 要求长度精确相等、每项为 balance/相同面值，并用两个 `Set` 拒绝重复 ID 和 code。明确余额不足时将全部 ID 交给 `batchDeleteCodes`；删除数量精确相等才抛出 `OPERATION_TERMINATED`，否则返回 `MANUAL_REVIEW_REQUIRED`。不确定上游错误继续使用现有 `pending()` 映射。

- [ ] **步骤 6：运行服务及相关测试并提交**

```powershell
npx vitest run tests/server/conversion-service.test.ts tests/server/routes.test.ts tests/server/secrets.test.ts tests/server/sub2api-clients.test.ts
git add src/server/conversion/service.ts tests/server/conversion-service.test.ts
git diff --cached --check
git commit -m "feat: execute one batch conversion"
```

## 任务 5：版本 2 本地恢复记录和历史迁移

**文件：**
- 修改：`src/shared/storage-types.ts`
- 修改：`src/web/storage.ts`
- 修改：`tests/web/storage.test.ts`

- [ ] **步骤 1：编写版本 1 迁移和同批多历史测试**

先定义版本 2 测试项：

```ts
function batchHistory(operationId: string, index: number, size: number): HistoryItem {
  return {
    version: 2,
    history_id: `${operationId}:${index}`,
    operation_id: operationId,
    batch_index: index,
    batch_size: size,
    amount: '2',
    code: `CODE-${index}`,
    created_at: '2026-07-14T00:00:00.000Z',
  }
}
```

```ts
it('migrates a version 1 pending operation to count one', () => {
  localStorage.setItem(PENDING_KEY, JSON.stringify({
    version: 1, operation_id: 'op-old', amount: '2', state: 'preparing',
  }))
  expect(loadPending()).toEqual({
    version: 2, operation_id: 'op-old', amount: '2', count: 1, state: 'preparing',
  })
})

it('migrates version 1 history without deleting codes', () => {
  localStorage.setItem(HISTORY_KEY, JSON.stringify([legacyHistoryItem]))
  expect(loadHistory()).toEqual([{
    version: 2, history_id: 'op-old', operation_id: 'op-old',
    batch_index: 1, batch_size: 1, amount: '2', code: 'OLD-CODE', created_at,
  }])
})

it('keeps every code from the same operation by history id', () => {
  expect(saveHistory([
    batchHistory('op-batch', 1, 3),
    batchHistory('op-batch', 2, 3),
    batchHistory('op-batch', 3, 3),
  ])).toBe(true)
  expect(loadHistory().map((item) => item.code)).toEqual(['CODE-3', 'CODE-2', 'CODE-1'])
})
```

同时修改原“不支持 version 2”测试为“拒绝 version 3”，并覆盖非法 `count`、`batch_index > batch_size`、不匹配 `history_id` 和额外字段。

- [ ] **步骤 2：运行存储测试确认红灯**

运行：`npx vitest run tests/web/storage.test.ts`

预期：FAIL，现有解析器会删除 version 2，且仍按 `operation_id` 去重。

- [ ] **步骤 3：定义版本 2 类型和严格迁移**

```ts
interface BatchMetadata {
  version: 2
  operation_id: string
  amount: string
  count: number
}

export type PendingOperation =
  | (BatchMetadata & { state: 'preparing' })
  | (BatchMetadata & {
      state: 'ready' | 'pending'; operation_token: string; expires_at: string
    })
  | (BatchMetadata & { state: 'expired'; expires_at: string })

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
```

`parsePending` 和 `parseHistoryItem` 分别严格接受 version 1 和 2，但始终返回上述 version 2 类型。新批次 `history_id` 固定为 ``${operation_id}:${batch_index}``，而旧单码历史规范化后允许在 `batch_index=batch_size=1` 时继续使用原 `operation_id` 作为 ID。这两种是仅有的合法 ID 形式。`normalizeStoredHistory` 和 `saveHistory` 的去重 Set 改为 `history_id`，保留 100 个码的容量。

- [ ] **步骤 4：运行存储测试并提交**

```powershell
npx vitest run tests/web/storage.test.ts
git add src/shared/storage-types.ts src/web/storage.ts tests/web/storage.test.ts
git diff --cached --check
git commit -m "feat: migrate batch conversion storage"
```

## 任务 6：前端 API 解析和批次编排

**文件：**
- 修改：`src/web/api.ts`
- 修改：`src/web/composables/useConversion.ts`
- 修改：`tests/web/useConversion.test.ts`

- [ ] **步骤 1：编写严格批次响应解析测试**

在 `tests/web/useConversion.test.ts` 增加一组可复用帮助值：

```ts
const createdAt = '2026-07-14T00:00:00.000Z'
const expiresAt = '2099-07-13T01:00:00.000Z'

function batchCodes(count: number): Array<{ code: string; created_at: string }> {
  return Array.from({ length: count }, (_, index) => ({
    code: `CODE-${index + 1}`,
    created_at: createdAt,
  }))
}

function completedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'completed',
    operation_id: operationId,
    amount: '2.5',
    count: 2,
    total_amount: '5',
    codes: batchCodes(2),
    ...overrides,
  }
}

function fetchResponse(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
}
```

```ts
it('parses an exact completed batch', async () => {
  const client = createApiClient(fetchResponse(completedPayload()))
  await expect(client.execute({ operation_token: 'operation-secret' }))
    .resolves.toMatchObject({ count: 2, codes: [{ code: 'CODE-1' }, { code: 'CODE-2' }] })
})

it.each([
  { count: 2, codes: [{ code: 'ONLY-ONE', created_at }] },
  { count: 1, total_amount: '9', codes: [{ code: 'CODE-1', created_at }] },
])('rejects inconsistent completed batch %#', async (override) => {
  const client = createApiClient(fetchResponse(completedPayload(override)))
  const error = await client.execute({ operation_token: 'operation-secret' })
    .catch((caught: unknown) => caught)
  expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' })
})
```

Zod 只负责字段形状，解析后再用 `Decimal` 校验 `codes.length === count` 和 `amount * count === total_amount`。

- [ ] **步骤 2：编写一批一次编排与历史发布测试**

```ts
it('prepares and executes one batch then publishes every code and refreshes once', async () => {
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(operationId)
  const prepare = vi.fn().mockResolvedValue({
    operation_token: 'operation-secret', expires_at: expiresAt,
    amount: '2.5', count: 3, total_amount: '7.5',
  })
  const execute = vi.fn().mockResolvedValue({
    status: 'completed', operation_id: operationId,
    amount: '2.5', count: 3, total_amount: '7.5',
    codes: batchCodes(3),
  })
  const me = vi.fn().mockResolvedValue({ ...profile, balance: '92.5' })
  const conversion = createUseConversion(api({ prepare, execute, me }), store)

  await conversion.convert('2.5', 3)

  expect(prepare).toHaveBeenCalledOnce()
  expect(prepare).toHaveBeenCalledWith({ operation_id: operationId, amount: '2.5', count: 3 })
  expect(execute).toHaveBeenCalledOnce()
  expect(me).toHaveBeenCalledOnce()
  expect(conversion.result.value?.codes).toHaveLength(3)
  expect(conversion.history.value.filter((item) => item.operation_id === operationId)).toHaveLength(3)
})
```

补充测试：prepare 返回金额/数量/总额不匹配时不 execute；批次响应不匹配操作编号时不发布历史；任一历史写入失败时不清除恢复记录也不展示部分码；恢复 version 1 待处理记录时数量为 1。

- [ ] **步骤 3：运行前端编排测试确认红灯**

运行：`npx vitest run tests/web/useConversion.test.ts`

预期：FAIL，API schema 仍要求单个 `code`，`convert` 不接受数量。

- [ ] **步骤 4：实现严格解析和整批发布**

`src/web/api.ts` 定义 `completedCodeSchema`，完成响应 schema 增加 `count`、`total_amount` 和 `codes`，然后 `.refine()` 校验长度和 Decimal 总额。

`ConversionController.convert` 改为 `(amount: string, count: number) => Promise<void>`。待处理记录使用 version 2/count，`prepareAndExecute` 同时核对 amount/count/total。完成时先构造整个 `HistoryItem[]`：

```ts
const items = response.codes.map((entry, index): HistoryItem => ({
  version: 2,
  history_id: `${response.operation_id}:${index + 1}`,
  operation_id: response.operation_id,
  batch_index: index + 1,
  batch_size: response.count,
  amount: response.amount,
  code: entry.code,
  created_at: entry.created_at,
}))
```

一次 `saveHistory` 完成整批写入，再清除 pending、设置 result，最后只刷新一次 profile。

- [ ] **步骤 5：运行 API、编排和存储测试并提交**

```powershell
npx vitest run tests/web/useConversion.test.ts tests/web/storage.test.ts
git add src/web/api.ts src/web/composables/useConversion.ts tests/web/useConversion.test.ts
git diff --cached --check
git commit -m "feat: orchestrate batch conversion"
```

## 任务 7：数量表单、批次确认和多码结果界面

**文件：**
- 修改：`src/web/App.vue`
- 修改：`src/web/components/ConversionForm.vue`
- 修改：`src/web/components/ConfirmDialog.vue`
- 修改：`src/web/components/ConversionResult.vue`
- 修改：`src/web/components/HistoryList.vue`
- 修改：`src/web/styles.css`
- 修改：`tests/web/components.test.ts`

- [ ] **步骤 1：编写表单默认数量、总额和全部余额测试**

```ts
it('defaults count to one and emits a validated batch draft', async () => {
  const wrapper = mount(ConversionForm, { props: { balance: '100', busy: false } })
  expect((wrapper.get('[aria-label="兑换数量"]').element as HTMLInputElement).value).toBe('1')
  await wrapper.get('[aria-label="兑换金额"]').setValue('2.5')
  await wrapper.get('[aria-label="兑换数量"]').setValue('3')
  expect(wrapper.text()).toContain('预计扣除 7.5')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('submit')).toEqual([[{ amount: '2.5', count: 3, totalAmount: '7.5' }]])
})

it('floors all balance across the selected count', async () => {
  const wrapper = mount(ConversionForm, { props: { balance: '10', busy: false } })
  await wrapper.get('[aria-label="兑换数量"]').setValue('3')
  await wrapper.get('[data-testid="fill-balance"]').trigger('click')
  expect((wrapper.get('[aria-label="兑换金额"]').element as HTMLInputElement).value)
    .toBe('3.33333333')
  expect(wrapper.text()).toContain('预计扣除 9.99999999')
})
```

- [ ] **步骤 2：编写确认框和批量结果复制测试**

在 `tests/web/components.test.ts` 增加完成批次工厂：

```ts
import { Decimal } from 'decimal.js'

function completedBatch(count: number): Extract<ExecuteResponse, { status: 'completed' }> {
  return {
    status: 'completed',
    operation_id: 'op-batch',
    amount: '2.5',
    count,
    total_amount: new Decimal('2.5').mul(count).toFixed(),
    codes: Array.from({ length: count }, (_, index) => ({
      code: `CODE-${index + 1}`,
      created_at: '2026-07-14T00:00:00.000Z',
    })),
  }
}
```

```ts
it('confirms per-code amount, count, and total', () => {
  const wrapper = mount(ConfirmDialog, {
    props: { open: true, amount: '2.5', count: 3, totalAmount: '7.5', busy: false },
  })
  expect(wrapper.text()).toContain('单码面值')
  expect(wrapper.text()).toContain('2.5')
  expect(wrapper.text()).toContain('数量')
  expect(wrapper.text()).toContain('3')
  expect(wrapper.text()).toContain('总扣款')
  expect(wrapper.text()).toContain('7.5')
})

it('shows and copies every completed code', async () => {
  clipboardController.copyText.mockResolvedValue(true)
  const wrapper = mount(ConversionResult, { props: { result: completedBatch(3), pending: null } })
  expect(wrapper.findAll('.code-row')).toHaveLength(3)
  await wrapper.get('[data-testid="copy-result-all"]').trigger('click')
  expect(clipboardController.copyText).toHaveBeenCalledWith('CODE-1\nCODE-2\nCODE-3')
  expect(wrapper.text()).toContain('已复制全部')
})
```

历史组件的 table 和 mobile list 循环 key 改为 `item.history_id`，并在同批记录中显示 `batch_index/batch_size`。

- [ ] **步骤 3：运行组件测试确认红灯**

运行：`npx vitest run tests/web/components.test.ts`

预期：FAIL，表单没有数量输入，确认框和结果仍使用单码 props。

- [ ] **步骤 4：实现批量界面和布局约束**

`ConversionForm` 使用文本型数字输入以便严格拒绝科学计数法，配置 `inputmode="numeric"`、`aria-label="兑换数量"` 和稳定宽度。提交事件使用：

```ts
import type { ConversionDraft } from '../conversion-input.js'

const emit = defineEmits<{ submit: [draft: ConversionDraft] }>()
```

`App.vue` 将 `confirmationAmount` 替换为 `confirmation: Ref<ConversionDraft | null>`，确认后调用 `conversion.convert(draft.amount, draft.count)`。

`ConversionResult` 使用有限高度的不嵌套列表显示最多 100 个 `.code-row`，每条使用含具体码的 aria-label；“复制全部”使用现有 `copyText()` 以换行符连接。

`styles.css` 为金额/数量建立 `minmax(0, 1fr) minmax(92px, 120px)` 网格，结果列表设置 `max-height` 和 `overflow-y: auto`，所有 code 保留 `overflow-wrap:anywhere`。在 480px 以下将表单网格切换为单列，确保按钮和文本不重叠。

- [ ] **步骤 5：运行输入、组件和类型测试并提交**

```powershell
npx vitest run tests/web/conversion-input.test.ts tests/web/components.test.ts
npm run typecheck
git add src/web/App.vue src/web/components/ConversionForm.vue src/web/components/ConfirmDialog.vue src/web/components/ConversionResult.vue src/web/components/HistoryList.vue src/web/styles.css tests/web/components.test.ts
git diff --cached --check
git commit -m "feat: add batch conversion interface"
```

预期：定向测试和类型检查全部 PASS。

## 任务 8：真实批量 E2E 和新手文档

**文件：**
- 修改：`tests/e2e/fixtures/mock-sub2api.ts`
- 修改：`tests/e2e/fixtures/browser-assertions.ts`
- 修改：`tests/e2e/conversion.spec.ts`
- 修改：`tests/e2e/iframe.spec.ts`
- 修改：`tests/e2e/mobile.spec.ts`
- 修改：`README.md`

- [ ] **步骤 1：先编写一次请求的批量 Playwright 测试**

在 `tests/e2e/conversion.spec.ts` 添加：

```ts
test('creates one three-code batch with one generate and one debit request', async ({
  page, context, environment,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: environment.origin,
  })
  await page.goto(environment.authenticatedUrl())
  await page.getByLabel('兑换金额').fill('10')
  await page.getByLabel('兑换数量').fill('3')
  await page.getByRole('button', { name: '生成兑换码', exact: true }).click()
  await expect(page.getByText('总扣款')).toBeVisible()
  await page.getByTestId('confirm-conversion').click()

  await expect(page.locator('.result-code-list .code-row')).toHaveCount(3)
  await expect(page.getByLabel('当前余额')).toContainText('70')
  expect(environment.mock.totalGenerateRequests()).toBe(1)
  expect(environment.mock.totalDebitRequests()).toBe(1)
  expect(environment.mock.totalSuccessfulDebits()).toBe(1)

  await page.getByTestId('copy-result-all').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('TEST-CODE-1\nTEST-CODE-2\nTEST-CODE-3')
  await expect(page.locator('.history-table tbody tr')).toHaveCount(3)
})
```

- [ ] **步骤 2：运行新 E2E 确认 mock 仍拒绝 count 3**

运行：

```powershell
npm run build:web
npx playwright test tests/e2e/conversion.spec.ts --project=desktop --grep "one three-code batch"
```

预期：FAIL，mock 生成端点仍要求 `body.count === 1`，页面不能得到 3 个码。

- [ ] **步骤 3：将 mock 扩展为真实批量语义**

`generated` 改为 `Map<string, RedeemCode[]>`，生成端点接受 1 到 100 的整数 count，用一次请求创建对应数组，幂等重放返回相同数组。增加：

```ts
totalGenerateRequests(): number
totalDebitRequests(): number
```

实现 `POST /api/v1/admin/redeem-codes/batch-delete`，严格接受 `{ ids: number[] }`，删除 Map 中存在的 ID 并返回 `{ deleted }`。保留现有 generic 500 模式不自动删除兑换码，用于验证不确定扣款仍进入 pending。

更新 `completeConversion` 让默认数量 1 的旧 E2E 仍可复用，并修改 iframe/mobile 中的单码选择器以匹配新结果列表。

- [ ] **步骤 4：重跑批量、iframe 复制和移动布局 E2E**

运行：

```powershell
npm run build:web
npx playwright test tests/e2e/conversion.spec.ts --project=desktop
npx playwright test tests/e2e/iframe.spec.ts --project=iframe
npx playwright test tests/e2e/mobile.spec.ts --project=mobile
```

预期：桌面批量、断线恢复、通用 500 pending、跨源 iframe 复制和移动布局全部 PASS，浏览器无 page error、console error 或控件重叠。

- [ ] **步骤 5：更新 README 的使用和风险说明**

在 README 功能/使用部分写明：金额是单码面值、数量默认 1 且上限 100、总额的计算方式、全部余额的向下取整规则，以及一批只占一次 prepare/execute 配额。

在“结果待确认与人工核对”明确：sub2api 当前批量建码在循环中逐个 Create 且无数据库事务，中途失败可留下无法安全识别的孤立码；工具不扣款、不展示部分码、不按时间/金额猜测删除。

- [ ] **步骤 6：提交 E2E 和文档**

```powershell
git add tests/e2e/fixtures/mock-sub2api.ts tests/e2e/fixtures/browser-assertions.ts tests/e2e/conversion.spec.ts tests/e2e/iframe.spec.ts tests/e2e/mobile.spec.ts README.md
git diff --cached --check
git commit -m "test: cover batch conversion workflow"
```

## 任务 9：全量验证、合并、推送和生产部署

**文件：**
- 验证：整个仓库
- 部署：`/opt/sub2api-balance-code`

- [ ] **步骤 1：扫描残留单码合约并检查差异**

运行：

```powershell
Select-String -Path 'src\**\*.ts','src\**\*.vue','tests\**\*.ts' -Pattern '\.code\b|generateCode\(|version:\s*1' -ErrorAction SilentlyContinue
git diff --check
git status -sb
```

人工分类每个命中：`.code` 只能是批内项/`HistoryItem`；`generateCode` 不能再出现在服务调用路径；`version: 1` 只能存在明确的迁移测试或会话合约中。

- [ ] **步骤 2：运行完整本地验证**

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e
git diff --check
git status --short
```

预期：Vitest 全部 PASS，类型检查和生产构建退出码为 0，desktop/iframe/mobile Playwright 全部 PASS，工作区无未提交文件。

- [ ] **步骤 3：使用 requesting-code-review 审查完整分支**

以 `bc7844f` 为基线、当前 `HEAD` 为结束提交，审查重点是：上游请求次数、Decimal 总额、重放幂等性、旧记录迁移、历史原子发布、部分码不泄露和 100 码响应式布局。修复所有 Critical/Important 问题后重跑相关测试。

- [ ] **步骤 4：按已确认的工作流合并回 main**

使用 finishing-a-development-branch。用户已在本项目的先前发布中选择“本地合并回 main 并推送”；执行前仍检查 main 和远端是否有新提交。

```powershell
git -C 'D:\Code\自助开码' pull --ff-only origin main
git -C 'D:\Code\自助开码' merge --ff-only feat/batch-redemption-codes
npm test
```

预期：合并为 fast-forward，合并后 main 全量 Vitest PASS。然后从主仓库移除 `.worktrees/batch-redemption-codes`、运行 `git worktree prune`，并删除已合并功能分支。

- [ ] **步骤 5：推送 GitHub main**

```powershell
gh auth status
git push origin main
git status -sb
git rev-parse --short HEAD
```

预期：本地 main 与 `origin/main` 同步，记录部署提交 SHA。

- [ ] **步骤 6：服务器拉取并构建新镜像**

SSH 使用 `64.83.47.63`，连接超时时最多重试 4 次、间隔 5 秒。不输出 `.env`、管理员 Key、JWT、Cookie、Secret 或真实兑换码。

```bash
set -e
cd /opt/sub2api-balance-code
git pull --ff-only origin main
git rev-parse --short HEAD
docker build -t sub2api-balance-code:local .
```

预期：服务器提交与本地部署 SHA 一致，新镜像构建成功；构建期间旧容器继续服务。

- [ ] **步骤 7：以单实例和自动回滚替换容器**

```bash
set -e
old_image=$(docker inspect --format='{{.Image}}' sub2api-balance-code)
docker stop sub2api-balance-code
docker rm sub2api-balance-code

if docker run -d \
  --name sub2api-balance-code \
  --restart unless-stopped \
  --env-file /opt/sub2api-balance-code/.env \
  -p 127.0.0.1:3100:3000 \
  sub2api-balance-code:local; then
  healthy=false
  for _ in $(seq 1 30); do
    if [ "$(docker inspect --format='{{.State.Health.Status}}' sub2api-balance-code 2>/dev/null)" = healthy ]; then
      healthy=true
      break
    fi
    sleep 2
  done
  if [ "$healthy" = true ]; then exit 0; fi
fi

docker rm -f sub2api-balance-code 2>/dev/null || true
docker run -d \
  --name sub2api-balance-code \
  --restart unless-stopped \
  --env-file /opt/sub2api-balance-code/.env \
  -p 127.0.0.1:3100:3000 \
  "$old_image"
exit 1
```

预期：成功时新容器为 healthy；失败时只恢复一个旧镜像容器并返回非零退出码。任意时刻最多一个工具容器运行。

- [ ] **步骤 8：验证生产服务和安全边界**

```powershell
curl.exe -fsS https://code.cyapi.cyou/healthz
curl.exe -sS -D - -o NUL https://code.cyapi.cyou/
```

通过 SSH 运行：

```bash
docker inspect --format='{{.State.Status}} {{.State.Health.Status}} {{json .NetworkSettings.Ports}}' sub2api-balance-code
docker ps --filter 'name=^/sub2api-balance-code$' --quiet | wc -l
/www/server/nginx/sbin/nginx -t
```

预期：`/healthz` 返回 `{"status":"ok"}`；首页为 200，CSP 仍允许 `https://www.cyapi.cyou` 嵌入且没有 `X-Frame-Options`；容器 `running healthy`，只有 1 个实例，端口仍只绑定 `127.0.0.1:3100`；Nginx 配置检查成功。

- [ ] **步骤 9：手工生产验收交接**

不在自动化部署中生成真实批次。请用户在可控余额账户上输入小额单码面值和数量 2，确认总扣款、两个结果、单条复制、复制全部、两条历史和余额刷新。同时在 sub2api 管理端确认这是一次批量建码和一笔总额扣款。
