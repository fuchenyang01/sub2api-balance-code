# 用户余额转兑换码工具设计

日期：2026-07-13

## 1. 目标

开发一个独立部署的自助开码工具。sub2api 用户从站内自定义页面或独立窗口进入工具，使用 sub2api 传入的用户 JWT 完成身份验证，自由输入金额，并将本人余额按 1:1 转换为一个永久有效的 sub2api 余额兑换码。

首版只支持余额兑换码，不支持并发额度、订阅、邀请、手续费、固定面额、服务端历史、独立账号体系或管理后台。

## 2. 已确认约束

- 不修改 sub2api 源码。
- 只通过 sub2api HTTP API 对接。
- 工具持有 sub2api Admin API Key，但密钥只存在于服务端。
- 用户认证使用 sub2api JWT。普通模型 API Key 不能用于用户资料接口。
- 余额与兑换码面值按 1:1 换算，不收手续费。
- 用户可自由输入金额，不设置业务上的最低或最高金额。
- 技术校验要求金额大于 0、不超过实时余额、最多 8 位小数。
- 兑换码永久有效。
- 每次操作必须二次确认。
- 同时支持 iframe 和独立窗口。iframe 模式要求工具与 sub2api 同站点部署，或由 sub2api 同源反向代理。
- 不使用服务端数据库、Redis、SQLite 或文件事务日志。
- 历史记录和未完成操作只保存在当前浏览器的 `localStorage`。
- 服务只能部署一个实例。
- 技术栈采用 Node.js/TypeScript 后端和 Vue 3 前端，交付单个 Docker 镜像。

## 3. 上游能力核对

设计基于 `Wei-Shaw/sub2api` commit `a1930ea6f29fc5f17ae0020f4e2d38e789c49d73`。

已确认的上游接口和行为：

- `GET /api/v1/user/profile` 使用 `Authorization: Bearer <用户 JWT>`，可返回当前用户资料和余额。
- 用户侧自定义页面会附带 `user_id`、`token`、`theme`、`lang` 和 `ui_mode` 查询参数。
- `POST /api/v1/admin/redeem-codes/generate` 可生成余额兑换码，支持 `Idempotency-Key`。
- `GET /api/v1/admin/redeem-codes/:id` 可检查兑换码是否仍存在及其状态。
- `DELETE /api/v1/admin/redeem-codes/:id` 可删除兑换码，但该接口本身没有幂等协调器。
- `POST /api/v1/admin/users/:id/balance` 支持 `subtract` 并支持 `Idempotency-Key`。
- 生成兑换码和扣减余额是两个独立管理员请求，不在同一数据库事务内。
- 管理员扣款实现为先读取用户、在内存计算新余额、再更新用户，不是数据库条件更新；并发时存在竞态。
- sub2api 的幂等 TTL 可配置。工具的操作令牌 TTL 必须小于或等于该 TTL。

## 4. 风险声明

本方案不能提供资金级原子性。原因是用户明确选择了“不修改 sub2api、只使用现有管理员 API、且不使用任何服务端持久化”。

剩余风险包括：

- 工具进程重启会丢失内存用户锁。
- 多实例部署无法共享用户锁，因此明确禁止多副本运行。
- sub2api 管理员扣款与模型消费并发时可能发生读写竞态。
- 浏览器清理本地存储会丢失待恢复操作和本地历史。
- 操作超过 sub2api 幂等 TTL 后，不能再保证安全自动恢复。
- 兑换码存储在浏览器本地历史中；共用设备或浏览器被入侵时可能泄露。
- 极端故障可能留下未公开给用户的孤立兑换码，需要管理员人工核对。

工具必须在 UI 和运维文档中把“结果待确认”与“明确失败”区分开。遇到不确定结果时不能自动发起新操作 ID，也不能盲目补扣或退款。

## 5. 总体架构

系统为单个 Node.js 进程，包含以下边界清晰的模块：

### 5.1 Web 前端

- Vue 3 + TypeScript + Vite。
- 负责会话交换、余额展示、金额输入、确认弹窗、结果展示、本地历史和待处理操作恢复。
- 不直接调用 sub2api 管理员 API。
- 不把原始用户 JWT、Admin API Key 或服务端会话密钥写入 Web Storage。

### 5.2 HTTP 后端

- Fastify + TypeScript。
- 托管构建后的前端静态文件。
- 提供会话、用户资料、操作准备和操作执行接口。
- 负责来源校验、限流、日志脱敏和统一错误映射。

### 5.3 sub2api 客户端

拆分成两个独立客户端：

- `UserClient`：只携带当前用户 JWT，调用用户资料接口。
- `AdminClient`：只携带 Admin API Key，调用生成码、查询码、删除码和扣余额接口。

两个客户端不能共享默认请求头，避免管理员密钥误发到用户接口或日志。

### 5.4 会话封装

- 用户 JWT 使用服务端密钥通过 JWE（`dir` + `A256GCM`）加密后放入 Cookie。
- Cookie 名默认为 `redeem_session`。
- Cookie 属性为 `HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`。
- 后端每次需要用户信息时仍通过 sub2api 验证 JWT 和读取实时用户状态，不把 Cookie 内容当作余额真相。

`SameSite=Lax` Cookie 不能可靠用于跨站 iframe。生产部署必须满足以下条件之一：

- 工具与 sub2api 使用相同 scheme 和可注册域，例如 `sub.example.com` 与 `code.example.com`。
- 通过 sub2api 域名下的同源路径反向代理工具，例如 `https://sub.example.com/code-tool/`。

若工具部署在完全不同的站点，独立窗口仍可使用，但 iframe 模式不在支持范围内。设计不采用 `SameSite=None` 绕过该限制，因为现代浏览器仍可能拦截第三方 Cookie。

### 5.5 操作令牌

- 准备接口签发短期 JWS 操作令牌。
- 载荷包含 `version`、`operation_id`、`user_id`、规范化金额字符串、`issued_at` 和 `expires_at`。
- 默认有效期 1 小时，可通过环境变量缩短。
- 配置时必须保证操作令牌 TTL 不超过 sub2api 的管理员写操作幂等 TTL。
- 操作令牌绑定当前会话用户，不能转交给其他用户执行。

### 5.6 单用户锁

- 使用进程内 keyed mutex，以 `user_id` 为键。
- 同一用户同一时间只允许一个执行请求进入上游编排。
- 锁只解决当前单实例内并发，不作为持久化或跨实例协调方案。

## 6. 认证流程

1. sub2api 以 iframe 或新窗口打开工具，并在 URL 中附带 `token`。
2. 前端读取 `token` 后立即调用 `POST /api/session/exchange`。
3. 后端使用该 JWT 调用 `GET /api/v1/user/profile`。
4. 后端只采用 profile 返回的用户 ID，完全忽略 URL 中的 `user_id` 作为身份依据。
5. 验证成功后，后端设置加密 HttpOnly Cookie。
6. 前端使用 `history.replaceState` 删除地址栏中的 `token` 和 `user_id`。
7. 页面后续只通过 Cookie 调用本工具后端。
8. Token 过期、撤销或用户停用时，清除本地会话并显示会话失效状态。

服务必须设置 `Referrer-Policy: no-referrer`。应用日志不得记录查询字符串，部署文档必须要求反向代理关闭带查询参数的访问日志。

## 7. 金额模型

- API 输入金额类型为十进制字符串，不接受 JSON 浮点数作为内部业务值。
- 使用 `decimal.js` 解析、规范化、比较和限制小数位。
- 合法格式为普通十进制，不接受指数形式、正负号、空白、`NaN` 或 `Infinity`。
- 金额必须大于 0，最多 8 位小数，且不超过准备阶段读取的实时余额。
- 向 sub2api 发送请求时，在最后边界转换为 JSON number；转换前后必须进行等值检查。
- 永久兑换码请求不传 `expires_at` 或 `expires_in_days`。

用户选择了“不设置业务上下限”，因此不额外限制金额。但仍受 sub2api 自身数值范围、当前余额和 8 位小数技术约束。

## 8. 开码状态流

### 8.1 准备阶段

前端：

1. 生成 UUID v4 `operation_id`。
2. 将 `{operation_id, amount, state: "preparing"}` 写入 `localStorage`。
3. 调用 `POST /api/conversions/prepare`。

后端：

1. 验证会话和请求来源。
2. 规范化金额。
3. 调用用户 profile 接口获取真实用户 ID 和实时余额。
4. 验证金额不超过余额。
5. 签发操作令牌并返回其过期时间。

前端必须先把操作令牌写入本地待处理记录，再调用执行接口。

### 8.2 执行阶段

`POST /api/conversions/execute` 按以下顺序执行：

1. 验证会话、操作令牌签名、有效期、用户绑定和金额。
2. 获取当前用户的进程内锁。
3. 调用 `POST /api/v1/admin/redeem-codes/generate`：
   - `Idempotency-Key: code-<operation_id>`
   - `count: 1`
   - `type: balance`
   - `value: <amount>`
   - 不传过期字段
4. 从响应中取得兑换码 ID 和兑换码文本。
5. 调用 `GET /api/v1/admin/redeem-codes/:id` 检查代码存在性：
   - 不存在表示该操作曾被补偿删除，当前操作终止，不能扣款。
   - 存在但面值、类型与操作令牌不一致时，停止并报告上游数据冲突。
   - 未使用时继续扣款。
   - 已使用时仍只允许使用原 `debit-<operation_id>` 重放扣款结果，不生成新扣款键。
6. 调用 `POST /api/v1/admin/users/:id/balance`：
   - `Idempotency-Key: debit-<operation_id>`
   - `balance: <amount>`
   - `operation: subtract`
   - `notes: balance-to-code:<operation_id>`
7. 只有收到确定成功或成功回放后，才把兑换码返回浏览器。
8. 释放用户锁。

### 8.3 补偿与不确定结果

- 生成失败：不发生扣款，操作保持可重试。
- 扣款返回可识别的余额不足错误：删除未使用兑换码；删除成功或查询确认 404 后，将操作标记为终止失败。
- 扣款返回鉴权或请求格式错误：不自动重试，兑换码不公开，提示管理员检查配置。
- 扣款超时、连接中断、`IDEMPOTENCY_IN_PROGRESS`、幂等存储不可用或无法判断是否执行：不得删除兑换码，返回 `pending`。
- 删除兑换码超时：重新查询兑换码；404 视为删除成功，仍存在则保持待处理，不把代码返回用户。
- 扣款成功但响应丢失：使用相同 `debit-<operation_id>` 重试，由 sub2api 回放成功结果。
- 同一操作令牌重复提交：始终复用相同的两个幂等键。
- 操作令牌过期或已超过上游幂等 TTL：禁止自动执行，显示“需要管理员核对”。

前端收到 `pending` 时保留操作令牌，并显示“继续处理”按钮。不得静默循环重试，不得为同一待处理金额自动创建新操作 ID。

## 9. HTTP 接口

### 9.1 `POST /api/session/exchange`

请求：

```json
{
  "token": "<sub2api-user-jwt>"
}
```

成功时设置会话 Cookie，只返回前端需要的最小用户资料。响应不得回显 JWT。

### 9.2 `GET /api/me`

返回当前用户名、用户 ID、实时余额和主题无关的基础资料。不返回角色权限、Admin API Key 或完整上游响应。

### 9.3 `POST /api/conversions/prepare`

请求：

```json
{
  "operation_id": "uuid-v4",
  "amount": "100.00"
}
```

响应：

```json
{
  "operation_token": "<signed-token>",
  "expires_at": "2026-07-13T13:00:00Z",
  "amount": "100"
}
```

### 9.4 `POST /api/conversions/execute`

请求：

```json
{
  "operation_token": "<signed-token>"
}
```

成功响应：

```json
{
  "status": "completed",
  "operation_id": "uuid-v4",
  "amount": "100",
  "code": "<redeem-code>",
  "created_at": "2026-07-13T12:00:00Z"
}
```

不确定响应使用 `status: "pending"`，不包含兑换码文本，并返回可本地化的错误代码。

### 9.5 `POST /api/session/logout`

清除会话 Cookie。该接口不删除浏览器本地开码历史；本地历史由用户单独清除。

## 10. 前端体验

### 10.1 主界面

- 顶部显示当前用户、可用余额和刷新图标按钮。
- 主区域包含金额输入、全部余额快捷按钮和生成兑换码按钮。
- 按钮启用状态由规范化金额和当前余额决定。
- 不使用营销式 hero、装饰性渐变或嵌套卡片。
- 布局适配 iframe、桌面独立窗口和手机窄屏。

### 10.2 二次确认

确认弹窗明确显示：

- 将扣除的余额。
- 将生成的兑换码面值。
- 换算比例为 1:1。
- 兑换码永久有效。

确认后立即创建并持久化本地操作 ID，避免重复点击生成不同操作。

### 10.3 成功结果

- 显示兑换码、金额和生成时间。
- 提供复制图标按钮，并使用 Lucide 图标。
- 复制成功通过非阻塞状态提示反馈。
- 成功结果写入本地历史后，移除待处理记录。

### 10.4 本地历史

- 保存最近 100 条成功记录。
- 字段为操作 ID、金额、兑换码、创建时间。
- 支持单条复制、复制全部和清除历史。
- 不保存 JWT、Cookie、Admin API Key、操作令牌或完整上游响应。
- 清除历史前需要确认。

### 10.5 恢复体验

页面加载时检测待处理记录：

- 未过期时显示继续处理按钮。
- 已过期时显示需要管理员核对，不允许自动创建替代操作。
- 用户主动放弃仅隐藏本地提示，不代表上游操作已取消；UI 必须明确这一点。

## 11. 安全设计

- 只允许配置的 `APP_ORIGIN` 和 `SUB2API_ORIGIN`。
- 对所有写接口校验 `Origin`，并使用 SameSite Cookie 防止跨站请求。
- 设置严格 CSP、`frame-ancestors` 白名单、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。
- 管理员密钥仅通过后端环境变量注入。
- 用户 JWT、Cookie、Admin API Key、操作令牌和兑换码默认视为敏感数据。
- 日志中对 Authorization、Cookie、查询字符串、请求体敏感字段和上游响应兑换码做脱敏。
- 不在错误跟踪系统中附带原始请求头或响应体。
- 会话交换、准备和执行接口分别设置 IP 与用户维度限流。
- 请求体设置较小上限，上游调用设置连接、响应和整体超时。
- 服务启动时检查会话密钥、操作令牌密钥和 Admin API Key，缺失时拒绝启动。
- `SESSION_SECRET` 和 `OPERATION_SIGNING_SECRET` 必须独立且至少 32 字节随机值。

## 12. 配置

必需环境变量：

- `SUB2API_BASE_URL`
- `SUB2API_ADMIN_API_KEY`
- `APP_ORIGIN`
- `SUB2API_ORIGIN`
- `SESSION_SECRET`
- `OPERATION_SIGNING_SECRET`

可选环境变量及默认值：

- `PORT=3000`
- `OPERATION_TTL_MINUTES=60`
- `UPSTREAM_TIMEOUT_MS=10000`
- `TRUST_PROXY=false`
- `LOG_LEVEL=info`
- `COOKIE_SECURE=true`

`OPERATION_TTL_MINUTES` 必须不大于 sub2api 实际配置的幂等 TTL。生产环境不允许 `COOKIE_SECURE=false`。

iframe 模式必须通过同站点子域或同源路径部署；跨站部署只支持独立窗口。

## 13. 错误模型

前端只依赖稳定错误代码，不直接解析英文上游消息。首版定义：

- `SESSION_REQUIRED`
- `SESSION_INVALID`
- `SESSION_EXPIRED`
- `AMOUNT_INVALID`
- `AMOUNT_EXCEEDS_BALANCE`
- `OPERATION_TOKEN_INVALID`
- `OPERATION_TOKEN_EXPIRED`
- `OPERATION_TERMINATED`
- `CONVERSION_IN_PROGRESS`
- `CONVERSION_PENDING`
- `UPSTREAM_AUTH_FAILED`
- `UPSTREAM_IDEMPOTENCY_UNAVAILABLE`
- `UPSTREAM_DATA_CONFLICT`
- `UPSTREAM_UNAVAILABLE`
- `MANUAL_REVIEW_REQUIRED`

所有错误响应包含请求追踪 ID，但不包含上游密钥、JWT、兑换码或堆栈。

## 14. 测试策略

### 14.1 后端单元测试

- 十进制金额格式、精度、余额比较和边界转换。
- 会话 JWE 加解密和过期。
- 操作 JWS 签名、用户绑定、金额绑定和过期。
- 幂等键派生稳定性。
- 上游错误分类和日志脱敏。
- keyed mutex 的同用户串行与不同用户并行行为。

### 14.2 上游契约测试

使用可编程 mock sub2api 覆盖：

- profile 成功、Token 过期、用户停用。
- 首次生成成功和生成结果回放。
- 生成失败。
- 兑换码存在、已使用、被删除和字段冲突。
- 扣款成功、余额不足、超时、连接中断、幂等处理中、成功回放。
- 删除成功、404、超时后查询确认。

### 14.3 编排集成测试

- 双击执行只扣款一次。
- 响应丢失后使用同一操作令牌恢复。
- 扣款明确失败后删除兑换码。
- 补偿删除成功但客户端未收到响应时，重试不会再次扣款。
- 同一用户两个不同操作串行执行。
- 不同用户可并行执行。
- 操作令牌过期后进入人工核对状态。

### 14.4 前端测试

- iframe 查询参数交换后被清除，且同站点 Cookie 可正常发送。
- 金额输入和全部余额。
- 二次确认。
- 成功码复制。
- 最近 100 条本地历史及清除确认。
- 待处理操作恢复。
- 浅色、深色、中文参数。
- 桌面、iframe 和移动端不溢出、不重叠。

### 14.5 端到端与交付验证

- Playwright 覆盖 iframe、独立窗口和手机视口。
- 检查浏览器控制台无敏感信息和运行错误。
- 检查地址栏在交换后不含 Token。
- 检查 Docker 健康端点和生产构建。
- 检查仅启动一个副本的部署说明。

## 15. 验收标准

1. 有效 sub2api JWT 可以建立会话并显示本人实时余额。
2. URL 中伪造 `user_id` 不会改变真实操作用户。
3. 用户可输入任意合法正数金额，金额不超过余额且最多 8 位小数。
4. 用户确认后生成同面值、永久有效的余额兑换码。
5. 兑换码只在扣款确定成功后展示。
6. 同一操作 ID 重试不会重复生成新码或重复扣款。
7. 扣款明确失败时，未公开兑换码被删除或进入待人工核对状态。
8. 网络不确定时保留待处理操作，不创建新的操作 ID。
9. 成功记录只保存在当前浏览器，刷新后仍可查看和复制。
10. JWT 和 Admin API Key 不出现在浏览器存储、应用日志或错误响应中。
11. 在同站点部署条件下，iframe、桌面独立窗口和移动端均可完整操作；跨站部署时独立窗口可完整操作。
12. 单元、契约、集成、前端和端到端测试通过，Docker 镜像可健康启动。

## 16. 非目标

- 不修改或 fork sub2api。
- 不实现真正原子的余额扣减与兑换码创建。
- 不提供服务端订单历史、跨设备恢复或管理员查询页。
- 不支持多实例、高可用或水平扩容。
- 不支持用户 API Key 登录。
- 不支持手续费、汇率、固定面额、批量开码或兑换码有效期。
- 不自动处理超过幂等 TTL 的待处理操作。
