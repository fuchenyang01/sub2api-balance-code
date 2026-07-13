# sub2api 余额兑换码工具

这是一个独立的单实例 Web 工具，通过 sub2api 现有 HTTP API 将当前用户余额按 1:1 转换为永久兑换码。它不修改 sub2api，也不复制或嵌入 sub2api 源码。

用户以 sub2api JWT 登录。工具需要一个由 sub2api 管理员创建、以 `admin-` 开头且能够调用兑换码和用户管理接口的 Admin API Key。该 Key 只能配置在本服务端，禁止发送到浏览器、写入 URL、提交到仓库或记录到日志。普通模型 API Key 不能替代用户 JWT 或 Admin API Key。

## 生产约束

- 只能运行一个进程实例、一个容器副本。禁止水平扩容、滚动更新期间双实例并行或多节点主动服务。同用户锁位于进程内，而 sub2api 的“生成码”和“扣余额”是两个非原子管理员请求；多实例会绕过锁并扩大竞态窗口。
- `OPERATION_TTL_MINUTES` 必须小于或等于 sub2api 管理员写操作的幂等 TTL。超过上游 TTL 后，不能安全地自动恢复操作。
- 生产环境必须使用 HTTPS，`COOKIE_SECURE=true`。服务必须位于可信反向代理后方，且不能将容器端口直接暴露到公网。
- 浏览器必须支持 [Web Locks API](https://developer.mozilla.org/docs/Web/API/Web_Locks_API)。不支持或锁服务异常时，前端会 fail closed，不会执行开码。
- 本工具不提供资金级原子性。进程重启会丢失内存锁；上游生成码与扣款之间可能中断；管理员扣款与模型消费可能发生读写竞态；极端故障可能留下未展示给用户的孤立兑换码。

## 环境变量

| 变量 | 默认值 | 含义与生产约束 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 生产镜像固定为 `production`，此时由同一 Fastify 进程托管 `dist/web`。 |
| `SUB2API_BASE_URL` | 无，必填 | sub2api HTTP API 根地址。生产必须为 HTTPS；不能含凭据、查询参数或 fragment。 |
| `SUB2API_ADMIN_API_KEY` | 无，必填 | 仅服务端使用的 sub2api Admin API Key，必须以 `admin-` 开头并具备兑换码、用户管理权限。 |
| `APP_ORIGIN` | 无，必填 | 用户访问本工具的精确 origin，例如 `https://balance.example.com`。不含路径。 |
| `SUB2API_ORIGIN` | 无，必填 | 允许嵌入/发起写请求的 sub2api 精确 origin，用于 Origin 校验和 CSP `frame-ancestors`。 |
| `SESSION_SECRET` | 无，必填 | 加密 HttpOnly 会话 Cookie 的独立随机秘密，至少 32 UTF-8 字节。 |
| `OPERATION_SIGNING_SECRET` | 无，必填 | 签名操作令牌的另一条独立随机秘密，至少 32 UTF-8 字节，禁止与会话密钥复用。 |
| `PORT` | `3000` | HTTP 监听端口，范围 1-65535。 |
| `OPERATION_TTL_MINUTES` | `60` | 操作令牌有效分钟数，范围 1-1440，且不得超过 sub2api 管理员写幂等 TTL。 |
| `UPSTREAM_TIMEOUT_MS` | `10000` | 单次上游请求超时，范围 1000-60000 毫秒。 |
| `TRUST_PROXY` | `false` | 仅当服务只能从可信反向代理访问时设为 `true`，用于取得真实客户端 IP。 |
| `LOG_LEVEL` | `info` | `fatal`、`error`、`warn`、`info`、`debug`、`trace` 或 `silent`。生产建议 `info`。 |
| `COOKIE_SECURE` | `true` | 生产必须为 `true`；会话 Cookie 同时使用 HttpOnly、Secure、SameSite=Lax。 |

从 `.env.example` 创建本地 `.env` 后，必须替换所有 `REPLACE_ME` 占位值。模板故意使用无法通过配置校验的 Admin Key 和短密钥，原样复制时服务一定拒绝启动；这些值不是生产秘密，也不能临时用于部署。生成两条独立 32-byte 随机密钥时，分别执行两次以下命令，并把两次不同的输出分别配置给两个变量：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

也可以分别执行两次 `openssl rand -base64 32`。不要复用输出，不要把 `.env` 提交到 Git。

## Docker 部署

```bash
docker build -t sub2api-balance-code:local .
docker run -d --name sub2api-balance-code \
  --env-file .env \
  -p 127.0.0.1:3100:3000 \
  --restart unless-stopped \
  sub2api-balance-code:local
curl -fsS http://127.0.0.1:3100/healthz
```

健康检查只返回 `{"status":"ok"}`，不包含版本、配置、上游响应或秘密。缺少必需配置、两个密钥相同/不足 32 字节、Admin Key 不以 `admin-` 开头，或生产 URL/Cookie 不安全时，容器会拒绝启动。

`PORT` 同时决定应用监听端口和容器内 HEALTHCHECK 端口。若 `.env` 使用 `PORT=4000`，宿主机 3100 端口必须映射到容器 4000 端口：`-p 127.0.0.1:3100:4000`，不能继续映射到 3000。

反向代理必须终止 TLS、限制请求体大小、设置合理的读写超时，并把 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto` 传给应用。只有在容器端口不对外暴露且代理可信时才设置 `TRUST_PROXY=true`。边缘、WAF、CDN 和反向代理的访问日志不得记录 query string；尤其不能记录入口 URL 中的 `token` 或 `user_id`。Nginx 日志应使用 `$uri`，不要使用 `$request` 或 `$request_uri`。

## iframe 部署

SameSite=Lax 会话只支持以下两类 iframe 部署：

1. 同站点子域：例如 sub2api 为 `https://sub.example.com`，工具为 `https://code.example.com`。设置 `APP_ORIGIN=https://code.example.com`、`SUB2API_ORIGIN=https://sub.example.com`。
2. sub2api 同源路径反代：例如 `https://sub.example.com/code-tool/`。代理必须剥离 `/code-tool/` 后再转发给工具，并把工具构建资源重写到该前缀；只将本工具拥有的 `/api/session/*`、`/api/conversions/*` 和 `/api/me` 精确转发给工具，不能覆盖 sub2api 的其他 `/api/*`。

同站点子域 iframe 示例：

```html
<iframe
  src="https://code.example.com/?token=REPLACE_WITH_URL_ENCODED_SUB2API_USER_JWT"
  title="余额兑换码"
></iframe>
```

同源路径 iframe 示例：

```html
<iframe
  src="https://sub.example.com/code-tool/?token=REPLACE_WITH_URL_ENCODED_SUB2API_USER_JWT"
  title="余额兑换码"
></iframe>
```

完全不同站点只支持独立窗口，不支持 iframe。本工具不会改用 `SameSite=None` 绕过限制，因为浏览器仍可能阻止第三方 Cookie。入口 JWT 交换后会从地址栏移除，但代理日志必须从一开始就忽略 query string。

## pending 与人工核对

页面显示“结果待确认”时，不代表明确失败。按以下顺序处理：

1. 记录原 `operation_id`、用户、金额、时间和应用 `request_id`，禁止为同一笔操作生成新 ID。
2. 在 sub2api 管理端按原幂等键查询生成码结果 `code-<operation_id>` 和扣款结果 `debit-<operation_id>`。始终复用这两个键，不要构造替代键。
3. 在操作令牌和上游幂等 TTL 内，优先让用户点击“继续处理”，由工具携带原操作令牌恢复。不要人工盲目补扣、退款、删码或重放一个新操作。
4. 对照兑换码是否存在、扣款是否成功及金额/用户是否一致。两侧状态不一致或无法确认时保持 pending，并转交管理员。
5. 超过任一 TTL 后停止自动恢复，保留证据并人工处理。任何补扣、退款或删除都必须基于已核实的上游结果和审计记录。

服务端没有数据库或事务日志。待处理记录、最近历史和兑换码只保存在当前浏览器的 `localStorage`：清理浏览器数据会永久丢失；不会跨设备或跨浏览器同步；共享设备、浏览器扩展或本机账户被入侵时可能泄露兑换码。完成后应及时复制到受控系统，并在共享设备上清除历史。

## 开发与验证

`npm run dev` 使用 Node.js 22 的 `--env-file=.env` 显式加载服务端配置；先按上文创建并完整填写 `.env`。Docker 部署仍由 `docker run --env-file .env` 注入配置。

```bash
npm ci
npm run dev
npm run dev:web
npm test -- tests/server/routes.test.ts
npm run typecheck
npm run build
npm test
git diff --check
```

开发模式下 Vite 把 `/api/` 和 `/healthz` 代理到 `127.0.0.1:3000`。生产构建把 Vue 资源输出到 `dist/web`，服务端 bundle 输出到 `dist/server`，最终由一个 Fastify 进程同时提供静态资源、API 和健康检查。
