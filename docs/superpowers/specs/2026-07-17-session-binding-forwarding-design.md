# sub2api 会话绑定兼容设计

## 背景与根因

生产 sub2api 实际运行版本为 `0.1.160`。该版本默认启用会话绑定，把 access token 与登录请求的客户端 IP 和 `User-Agent` 绑定。独立工具收到浏览器 JWT 后，由 Node.js 服务端调用 sub2api；当前网络配置下两次请求在 sub2api 看到的来源 IP 一致，但 `User-Agent` 从浏览器值变成 Node.js 默认值，因此 `/api/v1/user/profile` 和 `/api/v1/auth/me` 均返回 `SESSION_BINDING_MISMATCH`。

## 目标

在不修改 sub2api、不关闭全站会话绑定的前提下，让独立工具代表当前浏览器验证 JWT 时使用同一个 `User-Agent`，并覆盖登录交换、会话复验、兑换准备和兑换执行的全部用户资料请求。

## 非目标

- 不修改或重启 sub2api。
- 不关闭 `session_binding_enabled`。
- 不从查询参数、请求体或 Cookie 接收客户端特征。
- 不绕过 JWT 验证，不使用管理员 API 代替用户身份验证。
- 不转发客户端 IP。生产 `api_key_acl_trust_forwarded_ip=false`，sub2api 当前看到的来源 IP 在浏览器和工具请求路径中一致。

## 设计

新增一个小型上游请求上下文，只包含经过服务端校验的 `userAgent`。它由 Fastify 当前请求的 `User-Agent` 头生成，并沿现有调用链显式传递：

1. `/api/session/exchange` 使用当前请求上下文验证 URL 中的 JWT，并以相同上下文执行 `/auth/me` 诊断探针。
2. `SessionReader` 在每次 `/api/me`、兑换准备和兑换执行请求中重新生成上下文，再向 sub2api 复验用户资料。
3. 转换路由把同一上下文传给 `ConversionService`，确保其内部再次读取实时 profile 时不会恢复成 Node.js 默认 `User-Agent`。
4. `Sub2ApiUserClient` 只在上下文有效时显式设置 `User-Agent`，并继续只发送用户 JWT，不发送管理员 API Key。

上下文不写入加密会话 Cookie，也不写入操作 Token。用户后续请求必须继续携带与登录时一致的浏览器 `User-Agent`；浏览器特征变化时仍由 sub2api 正常拒绝。

## 输入与安全边界

- `User-Agent` 只能来自 Fastify 已解析的当前 HTTP 请求头。
- 值必须是非空字符串，UTF-8 长度最多 512 字节；缺失、空值、包含控制字符或超长时不构造上游上下文。
- 无有效上下文时不伪造固定浏览器值，sub2api 可按原安全策略拒绝请求。
- 日志、错误响应、会话 Cookie 和操作 Token 均不得包含 `User-Agent`。
- 诊断探针继续禁用重定向并丢弃响应体；探针失败不得改变原始认证错误。

## 接口调整

- `UserClient.getProfile` 和可选的 `probeAuthentication` 接收上游请求上下文。
- `SessionIdentity` 与 `AuthenticatedSession` 在单次 Fastify 请求内携带该上下文。
- `ConversionOperations.prepare`、`ConversionOperations.execute` 及 `ConversionService` 对应方法接收并向 profile 请求传递该上下文。

所有新增参数均显式传递，避免使用全局状态或 `AsyncLocalStorage`，使测试能够逐层验证数据没有丢失。

## 错误处理

- 上下文无效时，用户资料请求仍会发送 JWT，但不覆盖默认 `User-Agent`；sub2api 的认证拒绝沿用现有安全错误映射。
- profile 请求失败时不进入管理员生成或扣款步骤。
- 诊断探针异常降级为 `auth_me_status: null`，不改变 `SESSION_INVALID`。

## 验证

- 单元测试覆盖合法、缺失、控制字符和超长 `User-Agent` 的上下文生成。
- 用户客户端测试验证 profile 与 auth probe 使用完全相同的浏览器 `User-Agent`，且不发送管理员 API Key。
- 路由测试验证登录交换、会话复验、准备和执行均使用当前请求上下文。
- 转换服务测试验证其内部 profile 调用收到同一上下文，失败时不产生管理员副作用。
- 日志测试验证 JWT、Cookie、响应正文和 `User-Agent` 均不进入日志。
- 完成后运行完整单元测试、生产构建和 Playwright E2E；部署后使用新登录签发的 JWT 验证生产不再返回 `SESSION_BINDING_MISMATCH`。
