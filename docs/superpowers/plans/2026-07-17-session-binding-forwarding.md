# sub2api 会话绑定 User-Agent 转发实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让独立兑换工具在所有用户身份复验请求中转发当前浏览器的精确 `User-Agent`，兼容 sub2api 的 IP + User-Agent 会话绑定，同时保持失败关闭和敏感信息不落盘。

**架构：** 新建一个只含 `userAgent` 的短生命周期上游上下文，由当前 Fastify 请求头经过长度和控制字符校验后生成。该上下文作为显式参数依次传入用户客户端、会话交换/复验、兑换路由和兑换服务；它不进入 Cookie、操作 Token、日志或全局状态。

**技术栈：** Node.js 22、TypeScript、Fastify 5、Undici `fetch`、Vitest、Playwright、Docker

---

## 范围与文件结构

- 创建 `src/server/sub2api/user-context.ts`：定义 `UpstreamUserContext`，校验当前请求的 `User-Agent`。
- 创建 `tests/server/user-context.test.ts`：覆盖合法、缺失、空值、控制字符和 UTF-8 超长输入。
- 修改 `src/server/sub2api/user-client.ts`：对 profile 和 auth probe 使用同一个已校验 `User-Agent`。
- 修改 `src/server/routes/session.ts`：在交换和每次会话复验时从当前请求创建上下文并显式传递。
- 修改 `src/server/routes/conversions.ts`：把当前会话的上下文传给 prepare 和 execute。
- 修改 `src/server/conversion/service.ts`：把上下文传给服务内部的实时 profile 请求，包括进入用户锁后的复验。
- 修改 `tests/server/sub2api-clients.test.ts`：验证真实上游请求头和管理员凭据隔离。
- 修改 `tests/server/routes.test.ts`：验证 exchange、auth probe、`/api/me`、prepare、execute 的逐请求传播以及日志不泄露。
- 修改 `tests/server/conversion-service.test.ts`：验证 prepare/execute 内部复验收到上下文，失败时没有管理员副作用。

硬性边界：不修改、重启或重新构建 sub2api；不转发客户端 IP；不从 query/body/Cookie 接收 `User-Agent`；不把 `User-Agent` 写入 Cookie、操作 Token或日志；不在缺失或非法时伪造浏览器值。

### 任务 1：建立经过校验的当前请求上下文

**文件：**
- 创建：`src/server/sub2api/user-context.ts`
- 创建：`tests/server/user-context.test.ts`

- [ ] **步骤 1：编写上下文校验的失败测试**

创建 `tests/server/user-context.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { createUpstreamUserContext } from '../../src/server/sub2api/user-context.js'

describe('createUpstreamUserContext', () => {
  it('preserves an exact valid browser User-Agent', () => {
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) 测试'

    expect(createUpstreamUserContext(userAgent)).toEqual({ userAgent })
  })

  it('accepts exactly 512 UTF-8 bytes', () => {
    const userAgent = 'x'.repeat(512)

    expect(createUpstreamUserContext(userAgent)).toEqual({ userAgent })
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['NUL control character', 'Browser\\u0000Agent'],
    ['tab control character', 'Browser\\tAgent'],
    ['DEL control character', 'Browser\\u007fAgent'],
    ['over 512 UTF-8 bytes', '测'.repeat(171)],
  ] as const)('rejects %s without fabricating a value', (_label, userAgent) => {
    expect(createUpstreamUserContext(userAgent)).toBeUndefined()
  })
})
```

- [ ] **步骤 2：运行测试并确认因模块不存在而失败**

运行：`npx vitest run tests/server/user-context.test.ts`

预期：FAIL，提示无法解析 `src/server/sub2api/user-context.js`。

- [ ] **步骤 3：实现最小校验器**

创建 `src/server/sub2api/user-context.ts`：

```ts
const maxUserAgentBytes = 512
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u

export interface UpstreamUserContext {
  userAgent: string
}

export function createUpstreamUserContext(
  userAgent: string | undefined,
): UpstreamUserContext | undefined {
  if (
    userAgent === undefined ||
    userAgent.length === 0 ||
    controlCharacterPattern.test(userAgent) ||
    Buffer.byteLength(userAgent, 'utf8') > maxUserAgentBytes
  ) {
    return undefined
  }

  return { userAgent }
}
```

- [ ] **步骤 4：运行聚焦测试和类型检查**

运行：`npx vitest run tests/server/user-context.test.ts && npm run typecheck`

预期：全部 PASS，类型检查退出码为 0。

- [ ] **步骤 5：提交上下文边界**

```bash
git add src/server/sub2api/user-context.ts tests/server/user-context.test.ts
git commit -m "feat: validate upstream user context"
```

### 任务 2：用户客户端转发精确 User-Agent

**文件：**
- 修改：`src/server/sub2api/user-client.ts:1-47`
- 修改：`tests/server/sub2api-clients.test.ts:84-115`

- [ ] **步骤 1：先让 profile 和 auth probe 测试要求相同的浏览器值**

在 `tests/server/sub2api-clients.test.ts` 的两个用户客户端测试中使用同一上下文，并保留管理员凭据隔离断言：

```ts
const upstreamContext = { userAgent: 'Browser-UA/123 (exact)' }

it('parses a profile and sends only user credentials with the browser User-Agent', async () => {
  handler = (request, response) => {
    expect(request.url).toBe('/api/v1/user/profile')
    expect(request.headers.authorization).toBe('Bearer user-jwt')
    expect(request.headers['user-agent']).toBe(upstreamContext.userAgent)
    expect(request.headers['x-api-key']).toBeUndefined()
    json(response, 200, { code: 0, message: 'success', metadata: {}, data: profile })
  }

  const client = new Sub2ApiUserClient(baseUrl, 1_000)
  await expect(client.getProfile('user-jwt', upstreamContext)).resolves.toMatchObject({ id: 7 })
})

it('probes auth/me with the same token and browser User-Agent', async () => {
  handler = (request, response) => {
    expect(request.url).toBe('/api/v1/auth/me')
    expect(request.headers.authorization).toBe('Bearer user-jwt')
    expect(request.headers['user-agent']).toBe(upstreamContext.userAgent)
    expect(request.headers['x-api-key']).toBeUndefined()
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"code":"INVALID_TOKEN"}')
  }

  const client = new Sub2ApiUserClient(baseUrl, 1_000)
  await expect(client.probeAuthentication('user-jwt', upstreamContext)).resolves.toBe(401)
})
```

- [ ] **步骤 2：运行客户端测试并确认 User-Agent 断言失败**

运行：`npx vitest run tests/server/sub2api-clients.test.ts`

预期：FAIL；上游收到 Node.js/Undici 的默认值，而不是 `Browser-UA/123 (exact)`。

- [ ] **步骤 3：扩展 UserClient 接口并仅在上下文有效时覆盖请求头**

在 `src/server/sub2api/user-client.ts` 中导入类型，保持参数可为 `undefined` 以表达失败关闭：

```ts
import type { UpstreamUserContext } from './user-context.js'

export interface UserClient {
  getProfile(userJwt: string, context?: UpstreamUserContext): Promise<Profile>
  probeAuthentication?(userJwt: string, context?: UpstreamUserContext): Promise<number | null>
}

function userHeaders(userJwt: string, context: UpstreamUserContext | undefined): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${userJwt}` }
  if (context !== undefined) headers['User-Agent'] = context.userAgent
  return headers
}
```

把 `getProfile` 和 `probeAuthentication` 改为接收 `context`，两处请求都使用 `headers: userHeaders(userJwt, context)`。不得加入 `X-Forwarded-For`、`X-Real-IP` 或 `X-API-Key`。

- [ ] **步骤 4：运行客户端测试和完整类型检查**

运行：`npx vitest run tests/server/sub2api-clients.test.ts && npm run typecheck`

预期：全部 PASS，现有 401/403 分类、错误原因和响应体丢弃测试保持通过。

- [ ] **步骤 5：提交用户客户端转发**

```bash
git add src/server/sub2api/user-client.ts tests/server/sub2api-clients.test.ts
git commit -m "fix: forward browser user agent upstream"
```

### 任务 3：覆盖登录交换、诊断探针和会话复验

**文件：**
- 修改：`src/server/routes/session.ts:25-294`
- 修改：`tests/server/routes.test.ts:61-161`
- 修改：`tests/server/routes.test.ts:210-427`
- 修改：`tests/server/routes.test.ts:914-981`

- [ ] **步骤 1：让路由假对象分别记录 JWT 与上下文**

在 `tests/server/routes.test.ts` 中保留现有 `calls`/`probeCalls`，新增上下文记录，避免削弱原有 JWT 断言：

```ts
import type { UpstreamUserContext } from '../../src/server/sub2api/user-context.js'

const browserUserAgent = 'Browser-UA/route-test'

class FakeUsers implements UserClient {
  calls: string[] = []
  contexts: Array<UpstreamUserContext | undefined> = []
  probeCalls: string[] = []
  probeContexts: Array<UpstreamUserContext | undefined> = []

  async getProfile(userJwt: string, context?: UpstreamUserContext): Promise<Profile> {
    this.calls.push(userJwt)
    this.contexts.push(context)
    if (this.error !== undefined) throw this.error
    return this.currentProfile
  }

  async probeAuthentication(
    userJwt: string,
    context?: UpstreamUserContext,
  ): Promise<number | null> {
    this.probeCalls.push(userJwt)
    this.probeContexts.push(context)
    if (this.probeError !== undefined) throw this.probeError
    return this.probeStatus
  }
}
```

扩展测试辅助函数，使每次注入都明确携带当前 UA：

```ts
async function exchange(
  app: FastifyInstance,
  userJwt = jwt(),
  url = '/api/session/exchange',
  userAgent = browserUserAgent,
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { origin: appOrigin, 'user-agent': userAgent },
    payload: { token: userJwt },
  })
}
```

- [ ] **步骤 2：编写当前请求传播与不持久化的失败测试**

在 session routes 测试组加入：

```ts
it('uses each current request User-Agent without persisting it in the session cookie', async () => {
  const { app, users } = await setup()
  const userJwt = jwt()
  const loginUserAgent = 'Browser-UA/login'
  const revalidationUserAgent = 'Browser-UA/revalidation'

  const login = await exchange(
    app,
    userJwt,
    '/api/session/exchange?user_agent=FORGED-QUERY-UA',
    loginUserAgent,
  )
  const cookie = (login.headers['set-cookie'] as string).split(';', 1)[0]!
  const response = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { cookie, 'user-agent': revalidationUserAgent },
  })

  expect(response.statusCode).toBe(200)
  expect(users.contexts).toEqual([
    { userAgent: loginUserAgent },
    { userAgent: revalidationUserAgent },
  ])

  const sealed = cookie.slice('redeem_session='.length)
  expect(await secrets().unsealSession(sealed)).not.toHaveProperty('upstreamContext')
})

it.each(['', 'x'.repeat(513)])('does not fabricate a User-Agent for invalid input', async (userAgent) => {
  const { app, users } = await setup()
  const userJwt = jwt()

  const response = await exchange(app, userJwt, '/api/session/exchange', userAgent)

  expect(response.statusCode).toBe(200)
  expect(users.calls).toEqual([userJwt])
  expect(users.contexts).toEqual([undefined])
})
```

在认证拒绝诊断测试中把 UA 设为 `SECRET-BROWSER-UA/diagnostic`，然后断言：

```ts
expect(users.probeContexts).toEqual([{ userAgent: 'SECRET-BROWSER-UA/diagnostic' }])
expect(output).not.toContain('SECRET-BROWSER-UA/diagnostic')
expect(response.body).not.toContain('SECRET-BROWSER-UA/diagnostic')
```

- [ ] **步骤 3：运行路由测试并确认上下文尚未传播**

运行：`npx vitest run tests/server/routes.test.ts`

预期：FAIL；`users.contexts` 和 `probeContexts` 收到 `undefined`。

- [ ] **步骤 4：在单次 Fastify 请求内显式携带上下文**

在 `src/server/routes/session.ts` 导入：

```ts
import {
  createUpstreamUserContext,
  type UpstreamUserContext,
} from '../sub2api/user-context.js'
```

给两个请求内对象增加字段，不修改 `SessionPayload`：

```ts
export interface SessionIdentity {
  userJwt: string
  userId: number
  upstreamContext: UpstreamUserContext | undefined
}

export interface AuthenticatedSession extends SessionIdentity {
  profile: Profile
}
```

完成以下显式传递：

```ts
// readSessionIdentity 返回当前请求值，不从 Cookie 读取。
return {
  userJwt: session.userJwt,
  userId: session.userId,
  upstreamContext: createUpstreamUserContext(request.headers['user-agent']),
}

// revalidateSession
latest = await verifiedProfile(
  dependencies.users,
  identity.userJwt,
  identity.upstreamContext,
  'SESSION_EXPIRED',
)

// exchange handler 只创建一次，profile 和 probe 复用同一个对象。
const upstreamContext = createUpstreamUserContext(request.headers['user-agent'])
const { profile, expiresAt } = await exchangeIdentity(
  dependencies.users,
  userJwt,
  upstreamContext,
  async (error) => {
    let authMeStatus: number | null = null
    try {
      authMeStatus =
        dependencies.users.probeAuthentication === undefined
          ? null
          : await dependencies.users.probeAuthentication(userJwt, upstreamContext)
    } catch {
      authMeStatus = null
    }
    request.log.warn({
      upstream_status: error.status ?? null,
      upstream_reason: stableUpstreamReason(error.reason),
      auth_me_status: authMeStatus,
      jwt_diagnostics: tokenDiagnostics(userJwt),
    }, 'sub2api rejected user token')
  },
)
```

相应调整 `verifiedProfile` 和 `exchangeIdentity` 的函数签名，并把上下文传给 `users.getProfile(userJwt, upstreamContext)`。诊断探针原有 `try/catch` 必须保留，探针异常仍返回原始 `SESSION_INVALID`。

- [ ] **步骤 5：验证会话路径和完整类型检查**

运行：`npx vitest run tests/server/routes.test.ts && npm run typecheck`

预期：全部 PASS；交换和复验使用各自当前 UA，Cookie 解密结果仍只有现有会话字段，日志中没有测试 UA。

- [ ] **步骤 6：提交会话传播**

```bash
git add src/server/routes/session.ts tests/server/routes.test.ts
git commit -m "fix: bind user validation to current browser"
```

### 任务 4：覆盖兑换准备和执行内部的实时复验

**文件：**
- 修改：`src/server/routes/conversions.ts:12-20`
- 修改：`src/server/routes/conversions.ts:88-129`
- 修改：`src/server/conversion/service.ts:132-200`
- 修改：`tests/server/routes.test.ts:82-118`
- 修改：`tests/server/routes.test.ts:562-700`
- 修改：`tests/server/conversion-service.test.ts:77-143`
- 修改：`tests/server/conversion-service.test.ts:220-405`

- [ ] **步骤 1：编写 ConversionService 上下文传播的失败测试**

在 `tests/server/conversion-service.test.ts` 中让 `FakeUserClient` 额外记录上下文：

```ts
import type { ExecuteResponse, PrepareResponse } from '../../src/shared/contracts.js'
import type { UpstreamUserContext } from '../../src/server/sub2api/user-context.js'

const upstreamContext: UpstreamUserContext = { userAgent: 'Browser-UA/service-test' }

class FakeUserClient implements UserClient {
  calls: string[] = []
  contexts: Array<UpstreamUserContext | undefined> = []

  async getProfile(userJwt: string, context?: UpstreamUserContext): Promise<typeof this.profile> {
    this.calls.push(userJwt)
    this.contexts.push(context)
    if (this.error !== undefined) throw this.error
    return this.profile
  }
}
```

给 prepare 和 execute 各增加一个断言；execute 的失败用例继续确认管理员调用为空：

```ts
await service.prepare('user-jwt', userId, operationId, '10', 1, upstreamContext)
expect(users.contexts).toEqual([upstreamContext])
expect(secrets.signed).toHaveLength(1)
expect(secrets.signed[0]).not.toHaveProperty('upstreamContext')
expect(secrets.signed[0]).not.toHaveProperty('userAgent')

await service.execute('operation-token', 'user-jwt', userId, upstreamContext)
expect(users.contexts).toEqual([upstreamContext])

users.error = upstream('auth')
await expectAppError(
  () => service.execute('operation-token', 'user-jwt', userId, upstreamContext),
  'SESSION_EXPIRED',
)
expect(admin.calls).toEqual([])
```

把 `TestConversionService` 更新为以下便捷重载：旧测试默认传 `undefined`，新增测试则原样传递上下文。这样生产接口仍要求路由显式提供 `UpstreamUserContext | undefined`，而无关的既有测试不需要批量添加参数。

```ts
class TestConversionService extends ConversionService {
  prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
  ): Promise<PrepareResponse>
  prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
    context: UpstreamUserContext,
  ): Promise<PrepareResponse>
  override prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
    context?: UpstreamUserContext,
  ): Promise<PrepareResponse> {
    return super.prepare(userJwt, userId, operationId, rawAmount, count, context)
  }

  execute(operationToken: string, userId: number): Promise<ExecuteResponse>
  execute(
    operationToken: string,
    userJwt: string,
    userId: number,
    context?: UpstreamUserContext,
  ): Promise<ExecuteResponse>
  override execute(
    operationToken: string,
    userJwtOrUserId: string | number,
    explicitUserId?: number,
    context?: UpstreamUserContext,
  ): Promise<ExecuteResponse> {
    const effectiveUserId = explicitUserId ?? userJwtOrUserId as number
    const userJwt = typeof userJwtOrUserId === 'string'
      ? userJwtOrUserId
      : `user-${effectiveUserId}-jwt`
    return super.execute(operationToken, userJwt, effectiveUserId, context)
  }
}
```

不得删除现有用户锁、权限复验和管理员副作用断言。

- [ ] **步骤 2：让路由假对象记录 prepare/execute 的上下文**

在 `tests/server/routes.test.ts` 的 `FakeConversions` 中增加独立数组，保留现有调用元组：

```ts
prepareContexts: Array<UpstreamUserContext | undefined> = []
executeContexts: Array<UpstreamUserContext | undefined> = []

async prepare(
  userJwt: string,
  userId: number,
  requestedOperationId: string,
  amount: string,
  count: number,
  context: UpstreamUserContext | undefined,
): Promise<PrepareResponse> {
  this.prepareCalls.push([userJwt, userId, requestedOperationId, amount, count])
  this.prepareContexts.push(context)
  if (this.prepareError !== undefined) throw this.prepareError
  return {
    operation_token: 'signed-operation-token',
    expires_at: '2026-07-13T01:00:00.000Z',
    amount,
    count,
    total_amount: amount,
  }
}

async execute(
  operationToken: string,
  userJwt: string,
  userId: number,
  context: UpstreamUserContext | undefined,
): Promise<ExecuteResponse> {
  this.executeCalls.push([operationToken, userJwt, userId])
  this.executeContexts.push(context)
  if (this.executeError !== undefined) throw this.executeError
  return this.executeResponse
}
```

分别对 `/api/conversions/prepare` 和 `/api/conversions/execute` 注入 `user-agent: Browser-UA/conversion`，断言会话复验和转换调用都收到 `{ userAgent: 'Browser-UA/conversion' }`。

- [ ] **步骤 3：运行两组测试并确认转换层参数缺失**

运行：`npx vitest run tests/server/conversion-service.test.ts tests/server/routes.test.ts`

预期：FAIL；ConversionService 和 FakeConversions 的新增上下文断言收到 `undefined` 或签名不匹配。

- [ ] **步骤 4：扩展 ConversionOperations 并由路由传入当前上下文**

在 `src/server/routes/conversions.ts` 导入 `UpstreamUserContext`，把接口改为：

```ts
export interface ConversionOperations {
  prepare(
    userJwt: string,
    userId: number,
    operationId: string,
    rawAmount: string,
    count: number,
    context: UpstreamUserContext | undefined,
  ): Promise<PrepareResponse>
  execute(
    operationToken: string,
    userJwt: string,
    userId: number,
    context: UpstreamUserContext | undefined,
  ): Promise<ExecuteResponse>
}
```

prepare 和 execute 路由都从 `sessions.get(request)` 取得 `session.upstreamContext`，作为最后一个参数传入；不得重新从 body/query 构造上下文。

- [ ] **步骤 5：让 ConversionService 的两次实时 profile 请求使用上下文**

在 `src/server/conversion/service.ts` 导入 `UpstreamUserContext`，只做以下签名和调用点替换；未列出的金额、权限、互斥锁、生成、扣款和补偿代码逐行保持原样：

```diff
 async prepare(
   userJwt: string,
   userId: number,
   operationId: string,
   rawAmount: string,
   count: number,
+  context: UpstreamUserContext | undefined,
 ): Promise<PrepareResponse> {
@@
-  const profile = await this.#users.getProfile(userJwt)
+  const profile = await this.#users.getProfile(userJwt, context)

 async execute(
   operationToken: string,
   userJwt: string,
   userId: number,
+  context: UpstreamUserContext | undefined,
 ): Promise<ExecuteResponse> {
@@
-    return this.#executeLocked(operation, userJwt)
+    return this.#executeLocked(operation, userJwt, context)
@@
-async #executeLocked(operation: OperationPayload, userJwt: string): Promise<ExecuteResponse> {
+async #executeLocked(
+  operation: OperationPayload,
+  userJwt: string,
+  context: UpstreamUserContext | undefined,
+): Promise<ExecuteResponse> {
@@
-    profile = await this.#users.getProfile(userJwt)
+    profile = await this.#users.getProfile(userJwt, context)
```

不得改变生成一批兑换码、扣款一次、幂等键、用户级互斥锁或补偿逻辑。

- [ ] **步骤 6：运行转换、路由和类型验证**

运行：`npx vitest run tests/server/conversion-service.test.ts tests/server/routes.test.ts && npm run typecheck`

预期：全部 PASS；prepare/execute 的 SessionReader 复验和 ConversionService 内部复验均收到同一个当前请求上下文，profile 失败时 `admin.calls` 为空。

- [ ] **步骤 7：提交完整调用链**

```bash
git add src/server/routes/conversions.ts src/server/conversion/service.ts tests/server/routes.test.ts tests/server/conversion-service.test.ts
git commit -m "fix: preserve browser binding through conversions"
```

### 任务 5：完整回归、审查、合并与生产发布

**文件：**
- 检查：本计划列出的全部源文件和测试文件
- 禁止加入：`宣传博文/`

- [ ] **步骤 1：扫描安全边界和意外改动**

运行：

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short --branch
```

预期：无空白错误；改动只覆盖计划文件、上游上下文、用户客户端、会话/兑换调用链及对应测试；`宣传博文/` 不在此 worktree 的提交中。

再运行：

```powershell
Get-ChildItem src/server -Recurse -Filter *.ts |
  Select-String -Pattern 'X-Forwarded-For|X-Real-IP|upstreamContext.*seal|userAgent.*log' -CaseSensitive:$false
```

预期：没有转发客户端 IP、把上下文写入 Cookie/Token 或主动记录 UA 的实现。

- [ ] **步骤 2：运行全部自动化验证**

依次运行：

```bash
npm test
npm run build
npm run test:e2e
```

预期：Vitest 全部 PASS；TypeScript、Vite 和服务端构建成功；Playwright 全部 PASS。任一命令失败都停止合并和部署。

- [ ] **步骤 3：执行独立代码审查并处理阻断项**

使用 `superpowers:requesting-code-review` 审查 `main...HEAD`，重点检查：

- 每条 `getProfile`/`probeAuthentication` 用户调用链是否带当前请求上下文；
- UA 是否可能来自 body/query/Cookie、进入日志或持久化载荷；
- profile 失败是否仍发生在任何管理员生成/扣款之前；
- auth probe 异常是否仍保留原始认证错误；
- 是否无意修改了 sub2api、IP 头或既有批量幂等逻辑。

如有必须修复项，先新增复现测试、实施最小修复、重新运行步骤 2，再单独提交修复。

- [ ] **步骤 4：在本地合并回 main 并推送 GitHub**

先在主工作区确认除既有 `宣传博文/` 外没有会被覆盖的改动：

```powershell
git -C 'D:\Code\自助开码' status --short --branch
git -C 'D:\Code\自助开码' merge --no-ff codex/fix-session-binding-forwarding
git -C 'D:\Code\自助开码' push origin main
```

预期：合并和推送成功；`origin/main` 指向新的 merge commit；`宣传博文/` 保持未跟踪且未提交。

- [ ] **步骤 5：只重建独立工具容器**

SSH 登录 `64.83.47.63` 后，在服务器执行：

```bash
cd /opt/sub2api-balance-code
git pull --ff-only origin main
RELEASE=$(git rev-parse --short=12 HEAD)
sudo docker build -t "sub2api-balance-code:${RELEASE}" .
sudo docker rm -f sub2api-balance-code
sudo docker run -d \
  --name sub2api-balance-code \
  --env-file .env \
  -p 127.0.0.1:3100:3000 \
  --restart unless-stopped \
  "sub2api-balance-code:${RELEASE}"
```

预期：只替换 `sub2api-balance-code`；不执行任何针对 sub2api 容器、镜像、源码、配置或进程的命令。

- [ ] **步骤 6：验证本机和公网健康状态**

在服务器执行：

```bash
sudo docker ps --filter name=sub2api-balance-code
sudo docker logs --tail 100 sub2api-balance-code
curl -fsS http://127.0.0.1:3100/healthz
curl -fsS https://code.cyapi.cyou/healthz
```

预期：容器状态为 healthy/running，两次健康检查均返回 `{"status":"ok"}`，日志不包含 JWT、Cookie、Authorization、管理员 API Key、响应正文或 User-Agent。

- [ ] **步骤 7：用新登录态完成真实会话绑定验收**

在同一浏览器中重新登录 sub2api，打开余额兑换入口，依次验证：

1. 页面可以进入并显示用户资料；
2. prepare 成功；
3. 用测试账号和小额余额完成一次 execute；
4. 余额及时刷新；
5. 独立工具日志不再出现 `SESSION_BINDING_MISMATCH`，也不输出浏览器 UA。

生产验收只使用浏览器正常请求，不把 JWT、Cookie 或 User-Agent 粘贴到终端、日志或聊天中。
