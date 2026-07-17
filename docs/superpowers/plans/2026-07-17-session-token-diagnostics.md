# 会话 Token 脱敏诊断实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在独立工具记录可关联但不可还原的 JWT 认证失败信息，定位生产 `401`，不修改 sub2api。

**架构：** 新增一个纯函数负责生成 JWT 脱敏诊断字段；会话交换路径只在上游认证失败时调用它并写结构化日志，然后继续现有错误映射。诊断逻辑与路由解耦，便于独立测试和后续删除。

**技术栈：** Node.js `crypto`、TypeScript、Fastify/Pino、Jose、Vitest

---

## 文件结构

- 创建：`src/server/security/token-diagnostics.ts`，生成不可逆摘要和安全时间字段。
- 修改：`src/server/routes/session.ts`，在上游认证失败边界写脱敏日志。
- 创建：`tests/server/token-diagnostics.test.ts`，覆盖纯诊断函数。
- 修改：`tests/server/routes.test.ts`，覆盖认证失败日志及敏感信息不泄漏。

### 任务 1：记录脱敏的上游认证失败

**文件：**
- 创建：`src/server/security/token-diagnostics.ts`
- 修改：`src/server/routes/session.ts`
- 创建：`tests/server/token-diagnostics.test.ts`
- 修改：`tests/server/routes.test.ts`

- [ ] **步骤 1：编写失败的纯函数测试**

```ts
expect(tokenDiagnostics(firstToken)).toMatchObject({
  fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
  issued_at: '2026-07-17T10:00:00.000Z',
  expires_at: '2026-07-17T11:00:00.000Z',
})
expect(tokenDiagnostics(firstToken).fingerprint).not.toBe(
  tokenDiagnostics(secondToken).fingerprint,
)
expect(JSON.stringify(tokenDiagnostics(firstToken))).not.toContain(firstToken)
```

- [ ] **步骤 2：运行纯函数测试并验证红灯**

运行：`npx vitest run tests/server/token-diagnostics.test.ts`

预期：FAIL，因为 `src/server/security/token-diagnostics.ts` 尚不存在。

- [ ] **步骤 3：实现最少纯函数**

```ts
export function tokenDiagnostics(token: string): TokenDiagnostics {
  const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 16)
  try {
    const claims = decodeJwt(token)
    return {
      fingerprint,
      issued_at: numericDate(claims.iat),
      expires_at: numericDate(claims.exp),
    }
  } catch {
    return { fingerprint, issued_at: null, expires_at: null }
  }
}
```

- [ ] **步骤 4：运行纯函数测试并验证绿灯**

运行：`npx vitest run tests/server/token-diagnostics.test.ts`

预期：PASS。

- [ ] **步骤 5：编写失败的路由日志测试**

```ts
expect(record).toMatchObject({
  msg: 'sub2api rejected user token',
  upstream_status: 401,
  upstream_reason: 'INVALID_TOKEN',
  jwt_diagnostics: {
    fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
    issued_at: expect.any(String),
    expires_at: expect.any(String),
  },
})
expect(output).not.toContain(userJwt)
expect(output).not.toContain('UPSTREAM-PRIVATE-BODY')
```

- [ ] **步骤 6：运行路由测试并验证红灯**

运行：`npx vitest run tests/server/routes.test.ts -t "logs token diagnostics when sub2api rejects an exchange"`

预期：FAIL，因为路由尚未写入诊断日志。

- [ ] **步骤 7：在认证失败边界写结构化日志**

```ts
request.log.warn({
  upstream_status: error.status,
  upstream_reason: error.reason ?? null,
  jwt_diagnostics: tokenDiagnostics(userJwt),
}, 'sub2api rejected user token')
```

通过一个仅在 `exchangeIdentity` 捕获上游认证错误时执行的回调传入 `request.log`，不改变成功路径、状态码或响应内容。

- [ ] **步骤 8：运行定向测试并验证绿灯**

运行：`npx vitest run tests/server/token-diagnostics.test.ts tests/server/routes.test.ts`

预期：两个测试文件全部 PASS，输出中无凭据。

- [ ] **步骤 9：运行完整验证**

运行：`npm test && npm run build`

预期：497 项以上测试全部 PASS，TypeScript、Vue 和生产构建成功。

- [ ] **步骤 10：提交**

```bash
git add docs/superpowers/specs/2026-07-17-session-token-diagnostics-design.md docs/superpowers/plans/2026-07-17-session-token-diagnostics.md src/server/security/token-diagnostics.ts src/server/routes/session.ts tests/server/token-diagnostics.test.ts tests/server/routes.test.ts
git commit -m "chore: add safe session token diagnostics"
```
