# 用户余额转兑换码工具实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个无服务端数据库的单实例 Web 工具，让 sub2api 用户将本人余额按 1:1 转成永久兑换码，并通过上游幂等键和浏览器待处理记录恢复不确定请求。

**架构：** 一个 Fastify 进程提供 API 并托管 Vue 3 静态资源。用户 JWT 封装进加密 HttpOnly Cookie；转换使用签名操作令牌、进程内用户锁、sub2api 管理员生成码与扣款接口完成。浏览器只持久化成功历史和尚未终止的操作令牌。

**技术栈：** Node.js 22、TypeScript、Fastify 5、Vue 3、Vite、Zod、Decimal.js、JOSE、Vitest、Vue Test Utils、Playwright、Docker

---

## 范围护栏

- 依据规格：`docs/superpowers/specs/2026-07-13-balance-to-redeem-code-design.md`。
- 不修改 sub2api，不把上游源码复制进本仓库。
- 无服务端数据库、Redis、SQLite 或文件事务日志。
- 金额 1:1 转换，无业务最低或最高限制；技术上必须大于 0、不超过余额且最多 8 位小数。
- 永久兑换码不传任何过期字段。
- 幂等键固定派生为 `code-<operation_id>` 与 `debit-<operation_id>`。
- 只部署单实例；不得在容器编排中配置多个副本。

## 文件结构

### 工程与交付

- 创建：`package.json` - 单包脚本、运行依赖和开发依赖。
- 创建：`package-lock.json` - npm 锁文件，由 `npm install` 生成。
- 创建：`tsconfig.json` - 服务端、共享代码和 Vue 的严格类型配置。
- 创建：`vite.config.ts` - Vue 构建与本地 `/api` 代理。
- 创建：`vitest.config.ts` - Node 与 jsdom 测试发现规则。
- 创建：`playwright.config.ts` - 桌面、iframe 和移动端项目。
- 创建：`.gitignore` - 忽略依赖、构建物、测试产物和本地环境文件。
- 创建：`.env.example` - 无秘密的完整配置模板。
- 创建：`Dockerfile` - 非 root、多阶段、单镜像构建。
- 创建：`.dockerignore` - 缩小 Docker 构建上下文。
- 创建：`README.md` - 配置、同站点 iframe、单副本和故障处理说明。

### 共享契约

- 创建：`src/shared/contracts.ts` - 浏览器与后端共享的请求、响应和错误码。
- 创建：`src/shared/storage-types.ts` - 本地历史和待处理操作的数据结构。

### 服务端

- 创建：`src/server/main.ts` - 读取配置、创建应用、监听端口和优雅退出。
- 创建：`src/server/app.ts` - Fastify 组装、插件、路由和静态资源。
- 创建：`src/server/config.ts` - Zod 环境变量解析和跨字段约束。
- 创建：`src/server/errors.ts` - 稳定错误码、HTTP 状态和敏感信息安全映射。
- 创建：`src/server/amount.ts` - 十进制金额解析、比较与上游 number 转换。
- 创建：`src/server/security/origin.ts` - 写请求 Origin 白名单校验。
- 创建：`src/server/security/secrets.ts` - JWE 会话与 JWS 操作令牌。
- 创建：`src/server/security/redaction.ts` - 日志脱敏配置。
- 创建：`src/server/sub2api/types.ts` - 上游 envelope、profile、兑换码 DTO。
- 创建：`src/server/sub2api/http.ts` - 超时、JSON envelope 解析与错误分类。
- 创建：`src/server/sub2api/user-client.ts` - 用户 JWT profile 请求。
- 创建：`src/server/sub2api/admin-client.ts` - 管理员生成、查询、删除和扣款请求。
- 创建：`src/server/conversion/keyed-mutex.ts` - 单进程按用户串行执行。
- 创建：`src/server/conversion/service.ts` - 准备、执行、补偿和 pending 状态机。
- 创建：`src/server/routes/session.ts` - 会话交换与退出。
- 创建：`src/server/routes/me.ts` - 实时当前用户资料。
- 创建：`src/server/routes/conversions.ts` - 准备和执行 API。
- 创建：`src/server/routes/health.ts` - 不泄密的健康检查。

### 前端

- 创建：`src/web/index.html` - Vite HTML 入口和 no-referrer 元信息。
- 创建：`src/web/env.d.ts` - Vite 与 Vue SFC 类型声明。
- 创建：`src/web/main.ts` - Vue 挂载和主题初始化。
- 创建：`src/web/App.vue` - 页面状态编排。
- 创建：`src/web/styles.css` - 响应式、浅色和深色设计变量。
- 创建：`src/web/api.ts` - same-origin API 客户端和错误解析。
- 创建：`src/web/storage.ts` - 版本化 localStorage、100 条上限和损坏数据恢复。
- 创建：`src/web/composables/useConversion.ts` - prepare、execute、恢复与结果状态。
- 创建：`src/web/components/AccountBar.vue` - 用户、余额和刷新。
- 创建：`src/web/components/ConversionForm.vue` - 金额、全部余额和提交。
- 创建：`src/web/components/ConfirmDialog.vue` - 二次确认。
- 创建：`src/web/components/ConversionResult.vue` - 成功码和复制反馈。
- 创建：`src/web/components/PendingOperation.vue` - 继续处理和人工核对状态。
- 创建：`src/web/components/HistoryList.vue` - 本地历史、复制全部和清除。

### 测试

- 创建：`tests/server/config.test.ts`
- 创建：`tests/server/amount.test.ts`
- 创建：`tests/server/secrets.test.ts`
- 创建：`tests/server/sub2api-clients.test.ts`
- 创建：`tests/server/keyed-mutex.test.ts`
- 创建：`tests/server/conversion-service.test.ts`
- 创建：`tests/server/routes.test.ts`
- 创建：`tests/web/storage.test.ts`
- 创建：`tests/web/useConversion.test.ts`
- 创建：`tests/web/components.test.ts`
- 创建：`tests/e2e/fixtures/mock-sub2api.ts`
- 创建：`tests/e2e/fixtures/test-server.ts`
- 创建：`tests/e2e/conversion.spec.ts`

## 任务 1：初始化单包 TypeScript 工程

**文件：**
- 创建：`package.json`
- 创建：`package-lock.json`
- 创建：`tsconfig.json`
- 创建：`vite.config.ts`
- 创建：`vitest.config.ts`
- 创建：`.gitignore`
- 测试：`tests/setup.test.ts`

- [ ] **步骤 1：创建 package 脚本并安装依赖**

```json
{
  "name": "sub2api-balance-code",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/server/main.ts",
    "dev:web": "vite --config vite.config.ts",
    "build": "npm run typecheck && npm run build:web && npm run build:server",
    "build:web": "vite build --config vite.config.ts",
    "build:server": "tsup src/server/main.ts --format esm --platform node --out-dir dist/server --clean",
    "typecheck": "vue-tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  }
}
```

运行：

```bash
npm install fastify @fastify/cookie @fastify/helmet @fastify/rate-limit @fastify/static decimal.js jose lucide-vue-next vue zod
npm install -D @playwright/test @types/node @vitejs/plugin-vue @vue/test-utils jsdom tsup tsx typescript vite vitest vue-tsc
```

预期：生成 `package-lock.json`，`npm ls --depth=0` 退出码为 0。

- [ ] **步骤 2：创建严格 TypeScript、Vite 和 Vitest 配置**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"],
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"], "@web/*": ["src/web/*"] }
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "tests/**/*.ts", "*.config.ts"]
}
```

```ts
// vite.config.ts
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/web',
  plugins: [vue()],
  resolve: { alias: { '@web': fileURLToPath(new URL('./src/web', import.meta.url)), '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/healthz': 'http://127.0.0.1:3000' } }
})
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['tests/**/*.test.ts'], restoreMocks: true, clearMocks: true } })
```

- [ ] **步骤 3：创建测试框架烟雾测试**

```ts
// tests/setup.test.ts
import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs under a supported Node.js version', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22)
  })
})
```

- [ ] **步骤 4：运行烟雾测试和依赖检查**

运行：`npm test -- tests/setup.test.ts && npm ls --depth=0`

预期：1 个测试 PASS，依赖树检查退出码为 0。

- [ ] **步骤 5：提交工程骨架**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts .gitignore tests/setup.test.ts
git commit -m "chore: initialize TypeScript application"
```

## 任务 2：实现配置、错误和金额领域模型

**文件：**
- 创建：`src/server/config.ts`
- 创建：`src/server/errors.ts`
- 创建：`src/server/amount.ts`
- 创建：`src/shared/contracts.ts`
- 测试：`tests/server/config.test.ts`
- 测试：`tests/server/amount.test.ts`

- [ ] **步骤 1：编写配置与金额失败测试**

```ts
// tests/server/config.test.ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config.js'

describe('loadConfig', () => {
  it('rejects missing production secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SUB2API_BASE_URL/)
  })
})
```

```ts
// tests/server/amount.test.ts
import { describe, expect, it } from 'vitest'
import { parseAmount } from '../../src/server/amount.js'

describe('parseAmount', () => {
  it.each(['0', '-1', '+1', '1e2', ' 1', '1.123456789'])('rejects %s', (input) => {
    expect(() => parseAmount(input)).toThrow()
  })

  it('normalizes without losing precision', () => {
    expect(parseAmount('001.23000000').toString()).toBe('1.23')
  })
})
```

在 `tests/server/config.test.ts` 增加成功配置、非 HTTPS 生产 origin、短密钥和 `OPERATION_TTL_MINUTES <= 0` 用例。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- tests/server/config.test.ts tests/server/amount.test.ts`

预期：FAIL，缺少 `loadConfig` 和 `parseAmount`。

- [ ] **步骤 3：实现稳定错误契约**

```ts
// src/shared/contracts.ts
export const errorCodes = [
  'SESSION_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'AMOUNT_INVALID',
  'AMOUNT_EXCEEDS_BALANCE', 'OPERATION_TOKEN_INVALID', 'OPERATION_TOKEN_EXPIRED',
  'OPERATION_TERMINATED', 'CONVERSION_IN_PROGRESS', 'CONVERSION_PENDING',
  'UPSTREAM_AUTH_FAILED', 'UPSTREAM_IDEMPOTENCY_UNAVAILABLE',
  'UPSTREAM_DATA_CONFLICT', 'UPSTREAM_UNAVAILABLE', 'MANUAL_REVIEW_REQUIRED'
] as const

export type ErrorCode = typeof errorCodes[number]
export interface ApiErrorBody { error: { code: ErrorCode; message: string; request_id: string } }
export interface MeResponse { id: number; username: string; balance: string }
export interface PrepareRequest { operation_id: string; amount: string }
export interface PrepareResponse { operation_token: string; expires_at: string; amount: string }
export interface ExecuteRequest { operation_token: string }
export type ExecuteResponse =
  | { status: 'completed'; operation_id: string; amount: string; code: string; created_at: string }
  | { status: 'pending'; operation_id: string; error: ErrorCode }
```

```ts
// src/server/errors.ts
import type { ErrorCode } from '../shared/contracts.js'

export class AppError extends Error {
  constructor(public readonly code: ErrorCode, public readonly status: number, message: string, public readonly cause?: unknown) {
    super(message)
  }
}
```

- [ ] **步骤 4：实现配置和十进制金额**

```ts
// src/server/amount.ts
import Decimal from 'decimal.js'
import { AppError } from './errors.js'

const amountPattern = /^\d+(?:\.\d{1,8})?$/

export function parseAmount(input: string): Decimal {
  if (!amountPattern.test(input)) throw new AppError('AMOUNT_INVALID', 400, '金额格式无效')
  const value = new Decimal(input)
  if (!value.isPositive()) throw new AppError('AMOUNT_INVALID', 400, '金额必须大于 0')
  return value
}

export function amountToUpstreamNumber(value: Decimal): number {
  const output = value.toNumber()
  if (!Number.isFinite(output) || !new Decimal(output).equals(value)) throw new AppError('AMOUNT_INVALID', 400, '金额无法安全转换')
  return output
}
```

`src/server/config.ts` 使用 Zod 定义全部环境变量，生产环境要求 HTTPS origin、两个独立的至少 32 字节密钥、Admin API Key 以 `admin-` 开头，返回冻结的 `AppConfig`。

```ts
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SUB2API_BASE_URL: z.string().url(),
  SUB2API_ADMIN_API_KEY: z.string().startsWith('admin-'),
  APP_ORIGIN: z.string().url(),
  SUB2API_ORIGIN: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  OPERATION_SIGNING_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  OPERATION_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(60),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true')
})

export function loadConfig(input: NodeJS.ProcessEnv): Readonly<AppConfig> {
  const env = envSchema.parse(input)
  if (env.SESSION_SECRET === env.OPERATION_SIGNING_SECRET) throw new Error('session and operation secrets must differ')
  if (env.NODE_ENV === 'production' && (!env.APP_ORIGIN.startsWith('https://') || !env.SUB2API_ORIGIN.startsWith('https://') || !env.COOKIE_SECURE)) {
    throw new Error('production origins and cookies must use HTTPS')
  }
  return Object.freeze(toAppConfig(env))
}
```

- [ ] **步骤 5：运行领域测试和类型检查**

运行：`npm test -- tests/server/config.test.ts tests/server/amount.test.ts && npm run typecheck`

预期：全部 PASS，类型检查退出码为 0。

- [ ] **步骤 6：提交领域基础**

```bash
git add src/shared/contracts.ts src/server/config.ts src/server/errors.ts src/server/amount.ts tests/server/config.test.ts tests/server/amount.test.ts
git commit -m "feat: add configuration and amount validation"
```

## 任务 3：实现 sub2api 用户与管理员客户端

**文件：**
- 创建：`src/server/sub2api/types.ts`
- 创建：`src/server/sub2api/http.ts`
- 创建：`src/server/sub2api/user-client.ts`
- 创建：`src/server/sub2api/admin-client.ts`
- 测试：`tests/server/sub2api-clients.test.ts`

- [ ] **步骤 1：编写上游契约失败测试**

使用测试内 `createServer()` 启动临时 HTTP 服务，覆盖：profile envelope、生成码成功、`X-Idempotency-Replayed`、查询 404、删除 404、扣款成功、401、余额不足消息、超时和非 JSON 响应。断言所有管理员请求含 `x-api-key`，生成和扣款含准确的 `Idempotency-Key`，用户请求只含用户 Bearer JWT。

核心断言：

```ts
const operationId = '11111111-1111-4111-8111-111111111111'
expect(seen.generate.headers['idempotency-key']).toBe(`code-${operationId}`)
expect(seen.debit.headers['idempotency-key']).toBe(`debit-${operationId}`)
expect(seen.profile.headers.authorization).toBe('Bearer user-jwt')
expect(seen.profile.headers['x-api-key']).toBeUndefined()
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- tests/server/sub2api-clients.test.ts`

预期：FAIL，客户端模块不存在。

- [ ] **步骤 3：定义并校验上游 DTO**

```ts
// src/server/sub2api/types.ts
import { z } from 'zod'

export const profileSchema = z.object({ id: z.number().int().positive(), username: z.string(), balance: z.number().finite(), status: z.string() })
export const redeemCodeSchema = z.object({
  id: z.number().int().positive(), code: z.string().min(3), type: z.string(), value: z.number().finite(),
  status: z.string(), used_by: z.number().int().nullable(), created_at: z.string()
})
export const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ code: z.number(), message: z.string(), reason: z.string().optional(), data })
export type Profile = z.infer<typeof profileSchema>
export type RedeemCode = z.infer<typeof redeemCodeSchema>
```

- [ ] **步骤 4：实现隔离的 HTTP、用户和管理员客户端**

`src/server/sub2api/http.ts` 必须使用 `AbortSignal.timeout(timeoutMs)`、限制错误响应文本长度、解析 envelope，并将 401/403、幂等存储不可用、幂等处理中、确定余额不足、404 和未知 5xx 映射为可区分的 `UpstreamError.kind`。

```ts
export interface AdminClient {
  generateCode(operationId: string, amount: number): Promise<RedeemCode>
  getCode(id: number): Promise<RedeemCode | null>
  deleteCode(id: number): Promise<'deleted' | 'missing'>
  debitBalance(userId: number, operationId: string, amount: number): Promise<void>
}

export interface UserClient {
  getProfile(userJwt: string): Promise<Profile>
}
```

生成 body 固定为 `{ count: 1, type: 'balance', value: amount }`，扣款 body 固定为 `{ balance: amount, operation: 'subtract', notes: 'balance-to-code:<operationId>' }`。不得传任何兑换码过期字段。

- [ ] **步骤 5：运行客户端测试**

运行：`npm test -- tests/server/sub2api-clients.test.ts`

预期：全部 PASS，测试确认用户与管理员请求头完全隔离。

- [ ] **步骤 6：提交上游客户端**

```bash
git add src/server/sub2api tests/server/sub2api-clients.test.ts
git commit -m "feat: add isolated sub2api clients"
```

## 任务 4：实现加密会话、操作令牌和用户锁

**文件：**
- 创建：`src/server/security/secrets.ts`
- 创建：`src/server/conversion/keyed-mutex.ts`
- 测试：`tests/server/secrets.test.ts`
- 测试：`tests/server/keyed-mutex.test.ts`

- [ ] **步骤 1：编写密钥和锁失败测试**

```ts
it('rejects an operation token used by another user', async () => {
  const signed = await secrets.signOperation({ operationId: crypto.randomUUID(), userId: 7, amount: '5' })
  await expect(secrets.verifyOperation(signed.token, 8)).rejects.toMatchObject({ code: 'OPERATION_TOKEN_INVALID' })
})

it('serializes the same user and allows different users', async () => {
  const order: string[] = []
  await Promise.all([
    mutex.run(1, async () => { order.push('a-start'); await gate; order.push('a-end') }),
    mutex.run(1, async () => order.push('b')),
    mutex.run(2, async () => order.push('c'))
  ])
  expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a-end'))
  expect(order.indexOf('c')).toBeLessThan(order.indexOf('a-end'))
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- tests/server/secrets.test.ts tests/server/keyed-mutex.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 JWE 会话和 JWS 操作令牌**

`src/server/security/secrets.ts` 使用 `jose`：

- 会话：`CompactEncrypt`/`compactDecrypt`，算法 `dir` + `A256GCM`，载荷只含原始用户 JWT、用户 ID 和过期时间。
- 操作：`SignJWT`/`jwtVerify`，算法 `HS256`，载荷含 `version: 1`、operation ID、用户 ID、规范化金额和 1 小时内过期时间。
- verify 时检查 issuer、audience、算法、UUID、用户绑定和金额格式。
- JOSE 的过期错误映射为 `OPERATION_TOKEN_EXPIRED`，其他验证错误映射为 `OPERATION_TOKEN_INVALID`。

- [ ] **步骤 4：实现自动清理的 keyed mutex**

```ts
// src/server/conversion/keyed-mutex.ts
export class KeyedMutex<K> {
  private readonly tails = new Map<K, Promise<void>>()

  async run<T>(key: K, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try { return await work() } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  sizeForTest(): number { return this.tails.size }
}
```

测试必须断言所有任务执行结束后 `sizeForTest()` 为 0，避免长时间运行时按用户键泄漏内存。

- [ ] **步骤 5：运行密钥、锁和类型测试**

运行：`npm test -- tests/server/secrets.test.ts tests/server/keyed-mutex.test.ts && npm run typecheck`

预期：全部 PASS，无未处理 Promise rejection。

- [ ] **步骤 6：提交安全原语**

```bash
git add src/server/security/secrets.ts src/server/conversion/keyed-mutex.ts tests/server/secrets.test.ts tests/server/keyed-mutex.test.ts
git commit -m "feat: add sealed sessions and operation tokens"
```

## 任务 5：实现转换编排状态机

**文件：**
- 创建：`src/server/conversion/service.ts`
- 测试：`tests/server/conversion-service.test.ts`

- [ ] **步骤 1：编写表驱动失败测试**

创建内存 fake `UserClient`、`AdminClient`、时钟和密钥服务，逐项覆盖：

| 场景 | 预期 |
|---|---|
| 准备金额超过余额 | `AMOUNT_EXCEEDS_BALANCE`，不生成 token |
| 生成失败 | 不调用扣款 |
| 生成回放且 code 存在 | 使用相同 debit key |
| code 查询 404 | `OPERATION_TERMINATED`，不扣款 |
| code 类型或金额冲突 | `UPSTREAM_DATA_CONFLICT` |
| 扣款成功 | 返回 completed 和 code |
| 扣款成功回放 | 返回相同 completed |
| 明确余额不足 | 删除 code，返回终止失败 |
| 删除超时后查询 404 | 返回终止失败 |
| 扣款超时 | 返回 pending，不删除 code |
| 幂等处理中 | 返回 pending，不删除 code |
| 同用户并发 | 第二个调用等待第一个释放锁 |

关键断言：

```ts
const operationId = '11111111-1111-4111-8111-111111111111'
expect(admin.calls).toEqual([
  ['generate', `code-${operationId}`, 10],
  ['getCode', 91],
  ['debit', 7, `debit-${operationId}`, 10]
])
expect(result).toEqual({ status: 'completed', operation_id: operationId, amount: '10', code: 'CODE-1', created_at: now })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- tests/server/conversion-service.test.ts`

预期：FAIL，`ConversionService` 不存在。

- [ ] **步骤 3：实现 prepare**

```ts
async prepare(userJwt: string, userId: number, operationId: string, rawAmount: string): Promise<PrepareResponse> {
  const amount = parseAmount(rawAmount)
  const profile = await this.users.getProfile(userJwt)
  if (profile.id !== userId) throw new AppError('SESSION_INVALID', 401, '会话用户不一致')
  if (amount.gt(profile.balance)) throw new AppError('AMOUNT_EXCEEDS_BALANCE', 409, '余额不足')
  const signed = await this.secrets.signOperation({ operationId, userId, amount: amount.toString() })
  return { operation_token: signed.token, expires_at: signed.expiresAt, amount: amount.toString() }
}
```

- [ ] **步骤 4：实现 execute 和补偿**

实现严格顺序：verify token → keyed lock → generate → getCode → validate code → debit。只有 `UpstreamError.kind === 'insufficient-balance'` 才进入删除补偿；timeout、network、in-progress、idempotency-store-unavailable 和未知 5xx 一律返回 pending 且不删除。

```ts
try {
  await this.admin.debitBalance(op.userId, op.operationId, amountToUpstreamNumber(amount))
  return completed(op, code)
} catch (error) {
  if (isUpstreamError(error, 'insufficient-balance')) {
    await this.compensateUnusedCode(code.id)
    throw new AppError('OPERATION_TERMINATED', 409, '余额不足，兑换码已撤销')
  }
  if (isUncertainUpstreamError(error)) return pending(op.operationId)
  throw mapUpstreamError(error)
}
```

- [ ] **步骤 5：运行编排测试**

运行：`npm test -- tests/server/conversion-service.test.ts`

预期：全部 PASS，覆盖每个上游调用点的失败和重试。

- [ ] **步骤 6：提交编排服务**

```bash
git add src/server/conversion/service.ts tests/server/conversion-service.test.ts
git commit -m "feat: orchestrate idempotent balance conversion"
```

## 任务 6：组装 Fastify API 与安全边界

**文件：**
- 创建：`src/server/security/origin.ts`
- 创建：`src/server/security/redaction.ts`
- 创建：`src/server/routes/session.ts`
- 创建：`src/server/routes/me.ts`
- 创建：`src/server/routes/conversions.ts`
- 创建：`src/server/routes/health.ts`
- 创建：`src/server/app.ts`
- 创建：`src/server/main.ts`
- 测试：`tests/server/routes.test.ts`

- [ ] **步骤 1：编写路由失败测试**

使用 `buildApp()` 注入 fake 客户端，覆盖：

- exchange 成功设置 `HttpOnly; Secure; SameSite=Lax` Cookie，响应不含 JWT。
- 伪造 URL/user body ID 不影响 profile 返回 ID。
- 无 Cookie 访问 `/api/me` 返回 `SESSION_REQUIRED`。
- 非白名单 Origin 写请求返回 403。
- prepare schema 拒绝非 UUID 和 number 类型 amount。
- execute 的 pending 使用 HTTP 202，completed 使用 200。
- error response 只含稳定 code、message 和 request ID。
- `/healthz` 不返回配置或依赖信息。

```ts
expect(exchange.headers['set-cookie']).toContain('HttpOnly')
expect(exchange.headers['set-cookie']).toContain('SameSite=Lax')
expect(exchange.json()).not.toHaveProperty('token')
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- tests/server/routes.test.ts`

预期：FAIL，`buildApp` 不存在。

- [ ] **步骤 3：实现 Cookie 会话和路由 schema**

所有请求/响应使用 Fastify JSON Schema 或 Zod 编译后的 schema。实现 `readSession()`：解密 Cookie、用 user client 重新读取 profile、检查 profile ID 一致。exchange 成功后只返回 `{ id, username, balance }`。

路由路径固定为：`POST /api/session/exchange`、`POST /api/session/logout`、`GET /api/me`、`POST /api/conversions/prepare`、`POST /api/conversions/execute` 和 `GET /healthz`。

- [ ] **步骤 4：实现安全插件和错误处理器**

`buildApp()` 注册：

- Pino `redact` 路径：authorization、cookie、token、operation_token、code、Admin API Key。
- `@fastify/cookie`。
- `@fastify/helmet`，CSP `frame-ancestors` 只含 self 和 `SUB2API_ORIGIN`，referrer policy 为 no-referrer。
- `@fastify/rate-limit`，exchange、prepare、execute 使用独立限制。
- `onRequest` Origin 校验：GET/HEAD/OPTIONS 跳过，其他请求只接受 APP_ORIGIN 或 SUB2API_ORIGIN。
- 全局错误处理器，生产环境不返回 stack、cause 或上游 body。

- [ ] **步骤 5：实现启动与优雅退出**

```ts
// src/server/main.ts
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig(process.env)
const app = await buildApp(config)
await app.listen({ host: '0.0.0.0', port: config.port })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close())
```

- [ ] **步骤 6：运行服务端全套测试**

运行：`npm test -- tests/server && npm run typecheck`

预期：全部 PASS，Fastify inject 测试没有真实外部请求。

- [ ] **步骤 7：提交 HTTP 应用**

```bash
git add src/server tests/server/routes.test.ts
git commit -m "feat: expose secure conversion API"
```

## 任务 7：实现主界面和二次确认流程

**文件：**
- 创建：`src/web/index.html`
- 创建：`src/web/env.d.ts`
- 创建：`src/web/main.ts`
- 创建：`src/web/App.vue`
- 创建：`src/web/styles.css`
- 创建：`src/web/api.ts`
- 创建：`src/web/composables/useConversion.ts`
- 创建：`src/web/components/AccountBar.vue`
- 创建：`src/web/components/ConversionForm.vue`
- 创建：`src/web/components/ConfirmDialog.vue`
- 创建：`src/web/components/ConversionResult.vue`
- 测试：`tests/web/useConversion.test.ts`
- 测试：`tests/web/components.test.ts`

- [ ] **步骤 1：编写 composable 与组件失败测试**

每个 Web 测试文件首行添加 `// @vitest-environment jsdom`。覆盖：

- 初始 URL token 只提交一次，成功后 `history.replaceState` 删除 token 和 user_id，保留 theme/lang。
- 金额为 0、超过余额或 9 位小数时按钮禁用。
- “全部余额”填入规范化余额。
- 点击生成先打开确认框，不直接请求 execute。
- 确认框显示扣款、面值、1:1 和永久有效。
- completed 显示兑换码和复制按钮。
- pending 不显示兑换码。

```ts
expect(wrapper.get('[data-testid="submit"]').attributes('disabled')).toBeDefined()
await wrapper.get('[data-testid="amount"]').setValue('10')
await wrapper.get('[data-testid="submit"]').trigger('click')
expect(wrapper.get('[role="dialog"]').text()).toContain('永久有效')
expect(api.execute).not.toHaveBeenCalled()
```

- [ ] **步骤 2：运行 Web 测试验证失败**

运行：`npm test -- tests/web/useConversion.test.ts tests/web/components.test.ts`

预期：FAIL，Vue 文件和 composable 不存在。

- [ ] **步骤 3：实现 same-origin API 客户端和会话交换**

`src/web/api.ts` 统一使用 `credentials: 'same-origin'`、`Content-Type: application/json`，解析稳定错误 envelope。不得记录请求 body 或响应 code 字段。

```ts
// src/web/env.d.ts
/// <reference types="vite/client" />
```

`App.vue` 加载时：读取 theme/lang/ui_mode → 交换 token → 清理 URL → 调用 `/api/me`。无 token 且无 Cookie 时显示会话失效状态，不提供独立密码登录。

- [ ] **步骤 4：实现工作型主界面**

`ConversionForm.vue` 使用文本 input 和 `inputmode="decimal"`，前端校验仅用于交互，后端仍是权威。按钮使用 Lucide `RefreshCw`、`Copy`、`WalletCards` 图标并带 `aria-label` 和 tooltip。确认弹窗 focus trap、Escape 关闭、确认期间禁用关闭与重复提交。

- [ ] **步骤 5：实现响应式样式**

`styles.css` 定义中性色底、白色工具面、绿色成功和红色错误；卡片圆角不超过 8px；不使用渐变、装饰球或嵌套卡片。固定按钮高度、代码区域最小高度和表格列宽，保证状态变化不引发布局跳动。使用 media query 切换两列/单列，不用 viewport width 缩放字体。

- [ ] **步骤 6：运行 Web 测试和构建**

运行：`npm test -- tests/web/useConversion.test.ts tests/web/components.test.ts && npm run build:web && npm run typecheck`

预期：全部 PASS，`dist/web/index.html` 和带 hash 的资源文件存在。

- [ ] **步骤 7：提交核心界面**

```bash
git add src/web tests/web/useConversion.test.ts tests/web/components.test.ts
git commit -m "feat: add balance conversion interface"
```

## 任务 8：实现本地历史和待处理恢复

**文件：**
- 创建：`src/shared/storage-types.ts`
- 创建：`src/web/storage.ts`
- 创建：`src/web/components/PendingOperation.vue`
- 创建：`src/web/components/HistoryList.vue`
- 修改：`src/web/App.vue`
- 修改：`src/web/composables/useConversion.ts`
- 测试：`tests/web/storage.test.ts`
- 修改：`tests/web/useConversion.test.ts`
- 修改：`tests/web/components.test.ts`

- [ ] **步骤 1：编写 storage 和恢复失败测试**

覆盖版本不匹配、损坏 JSON、最多 100 条、相同 operation ID 去重、待处理 token 在 execute 前落盘、completed 后先写历史再清 pending、pending 保留、expired 显示人工核对、用户清除历史确认。

```ts
saveHistory(Array.from({ length: 101 }, (_, i) => historyItem(i)))
expect(loadHistory()).toHaveLength(100)
expect(loadHistory()[0]?.operation_id).toBe('100')
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- tests/web/storage.test.ts tests/web/useConversion.test.ts tests/web/components.test.ts`

预期：FAIL，storage 与恢复组件不存在。

- [ ] **步骤 3：实现版本化 storage**

```ts
// src/shared/storage-types.ts
export interface PendingOperation {
  version: 1; operation_id: string; amount: string; operation_token: string; expires_at: string; state: 'ready' | 'pending'
}
export interface HistoryItem {
  version: 1; operation_id: string; amount: string; code: string; created_at: string
}
```

storage key 固定为 `sub2api-code:pending:v1` 和 `sub2api-code:history:v1`。读取时逐字段验证，损坏记录删除并返回空值；历史插入按 operation ID 去重并截断为最近 100 条。

- [ ] **步骤 4：实现恢复顺序**

`useConversion` 必须遵守：生成 operation ID 并落盘 preparing → prepare → 保存完整 token → execute → completed 时写历史 → 再清 pending。页面加载只提示继续处理，不自动 execute。过期记录保留最小元数据用于人工核对，但移除 operation token。

- [ ] **步骤 5：实现历史和 pending UI**

历史桌面使用表格，窄屏改为 unframed 列表；提供单条复制、复制全部、清除历史确认。Pending 组件提供继续处理和隐藏提示；隐藏提示文案必须说明不会取消上游操作。

- [ ] **步骤 6：运行 Web 全套测试**

运行：`npm test -- tests/web && npm run typecheck`

预期：全部 PASS，本地存储测试间使用 `localStorage.clear()` 隔离。

- [ ] **步骤 7：提交恢复与历史**

```bash
git add src/shared/storage-types.ts src/web tests/web
git commit -m "feat: persist conversion recovery and local history"
```

## 任务 9：完成 Docker、运维文档和安全验证

**文件：**
- 创建：`.env.example`
- 创建：`Dockerfile`
- 创建：`.dockerignore`
- 创建：`README.md`
- 修改：`src/server/app.ts`
- 修改：`tests/server/routes.test.ts`

- [ ] **步骤 1：增加敏感信息和安全头失败测试**

断言 CSP 包含准确 `frame-ancestors`、Referrer-Policy 为 `no-referrer`、错误响应不含测试 JWT/Admin Key/code、日志捕获不含原始秘密、生产 Cookie 必须 Secure、query token 不进入应用访问日志。

- [ ] **步骤 2：运行安全测试验证失败**

运行：`npm test -- tests/server/routes.test.ts -t "security"`

预期：至少一个安全头或脱敏断言 FAIL。

- [ ] **步骤 3：补齐安全头与日志脱敏**

```ts
// src/server/security/redaction.ts
export const redactPaths = [
  'req.headers.authorization', 'req.headers.cookie', 'req.query.token',
  'req.body.token', 'req.body.operation_token', 'res.body.code',
  'config.sub2apiAdminApiKey'
]
```

日志序列化器只记录 method、pathname、statusCode、request ID 和 duration，不记录 query string 或业务 body。

- [ ] **步骤 4：创建生产镜像**

```dockerfile
# Dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server/main.js"]
```

- [ ] **步骤 5：编写部署文档**

README 必须给出：Admin API Key 创建前提、所有环境变量、32 字节密钥生成命令、同站点子域/同源路径 iframe 示例、跨站仅支持独立窗口、反向代理不记录 query、仅一个副本、操作 TTL 小于上游幂等 TTL、pending 人工处理步骤、浏览器历史安全提示。

- [ ] **步骤 6：验证生产构建和镜像**

运行：

```bash
npm run build
docker build -t sub2api-balance-code:test .
docker run -d --name sub2api-balance-code-test -p 3100:3000 \
  -e SUB2API_BASE_URL=https://sub.example.com \
  -e SUB2API_ADMIN_API_KEY=admin-test-key \
  -e APP_ORIGIN=https://code.example.com \
  -e SUB2API_ORIGIN=https://sub.example.com \
  -e SESSION_SECRET=0123456789abcdef0123456789abcdef \
  -e OPERATION_SIGNING_SECRET=abcdef0123456789abcdef0123456789 \
  sub2api-balance-code:test
```

在另一终端运行：`curl -fsS http://127.0.0.1:3100/healthz`

预期：返回 `{"status":"ok"}`；缺少任一必需秘密时容器拒绝启动。验证后运行 `docker rm -f sub2api-balance-code-test`。

- [ ] **步骤 7：提交交付文件**

```bash
git add .env.example Dockerfile .dockerignore README.md src/server/app.ts src/server/security/redaction.ts tests/server/routes.test.ts
git commit -m "docs: add secure single-instance deployment"
```

## 任务 10：端到端流程和最终回归

**文件：**
- 创建：`playwright.config.ts`
- 创建：`tests/e2e/fixtures/mock-sub2api.ts`
- 创建：`tests/e2e/fixtures/test-server.ts`
- 创建：`tests/e2e/conversion.spec.ts`
- 修改：`package.json`

- [ ] **步骤 1：创建可编程 mock sub2api**

fixture 提供 profile、generate、get code、delete 和 debit 路由；在内存记录每个 Idempotency-Key 的成功响应，支持通过测试控制端点切换 `success`、`timeout-after-success`、`insufficient` 和 `in-progress`。测试结束必须关闭监听端口并清空状态。

- [ ] **步骤 2：编写 Playwright 失败测试**

覆盖三个项目：

- `desktop`：1280x800 独立窗口完整开码、复制、本地历史。
- `iframe`：父页与工具同站点，token 交换后 URL 清理、Cookie 可用。
- `mobile`：390x844，确认框、兑换码和历史不溢出。

另写恢复用例：mock 在扣款成功后断开连接，页面显示 pending；点击继续处理后相同 debit key 被回放且只扣一次。

```ts
await page.getByLabel('兑换金额').fill('10')
await page.getByRole('button', { name: '生成兑换码' }).click()
await page.getByRole('button', { name: '确认生成' }).click()
await expect(page.getByTestId('redeem-code')).toHaveText('TEST-CODE-1')
expect(await mock.totalSuccessfulDebits()).toBe(1)
```

- [ ] **步骤 3：运行 E2E 验证失败**

运行：`npx playwright install chromium && npm run test:e2e`

预期：FAIL，fixture 或浏览器流程尚未完整接通。

- [ ] **步骤 4：接通测试服务器和 E2E 配置**

`tests/e2e/fixtures/test-server.ts` 在随机空闲端口启动 mock sub2api 和真实 `buildApp()`；将 APP_ORIGIN、SUB2API_ORIGIN、固定测试密钥和 mock Admin API Key 直接作为测试配置对象传入，不读取开发者本机 `.env`。

Playwright 失败时保留 trace 和 screenshot，成功时不保留视频。

- [ ] **步骤 5：运行所有验证**

运行：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
git diff --check
git status --short
```

预期：类型检查、全部 Vitest、生产构建、三个 Playwright 项目和 diff check 全部通过；`git status --short` 只显示本任务预期文件。

- [ ] **步骤 6：检查浏览器像素和控制台**

在 Playwright 测试中为 desktop、iframe、mobile 截图，断言主要工具区域 bounding box 宽高大于 0；收集 `pageerror` 和 `console.error`，断言均为空；检查金额、按钮、确认框、兑换码和历史区域互不重叠。

- [ ] **步骤 7：提交端到端覆盖**

```bash
git add package.json package-lock.json playwright.config.ts tests/e2e
git commit -m "test: cover conversion flow end to end"
```

- [ ] **步骤 8：最终提交审计**

运行：

```bash
git log --oneline --decorate -12
git status --short
```

预期：看到每个任务的独立提交，工作树为空。不得把 `.env.test`、真实 JWT、Admin API Key、兑换码或 Playwright trace 提交到 Git。
