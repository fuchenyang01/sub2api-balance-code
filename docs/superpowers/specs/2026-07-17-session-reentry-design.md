# 会话失效一键重新进入设计

## 背景

余额兑换工具首次加载时，从 sub2api 自定义页面附带的 `token` 查询参数取得用户 JWT，调用 `/api/session/exchange` 换取工具自己的 HttpOnly Cookie，并立即从地址栏清除 Token。工具 Cookie 的有效期与该 JWT 的 `exp` 一致。

sub2api 主站可以刷新自身登录状态，但已经打开的跨子域 iframe 无法读取主站的新 JWT。因此主站仍显示登录时，工具仍可能因为旧 JWT 或工具 Cookie 过期而显示“会话已失效”。工具没有 sub2api 的刷新凭证，不能自行安全续期。

## 目标

会话失效时，让用户通过一次明确点击进入 sub2api 同源的重新登录桥接页。桥接页只清理 sub2api 的旧认证存储，再转到带自定义页返回地址的登录页。登录成功后，sub2api 重新创建工具 iframe 并传入新 JWT。整个过程不修改 sub2api 源码，不延长 JWT 有效期，也不在工具中持久化 JWT。

## 非目标

- 不在工具内实现 sub2api JWT 刷新。
- 不把 JWT 写入 `localStorage`、`sessionStorage` 或普通 Cookie。
- 不自动循环重试已经失效的 Token。
- 不更改当前 `SameSite=Lax`、HttpOnly、Secure 会话 Cookie 策略。
- 不修改 sub2api 源码或自定义页实现。

## 配置

新增必填环境变量 `SUB2API_ENTRY_URL`，值为 sub2api 中承载余额转换工具的自定义页面完整地址，例如：

```dotenv
SUB2API_ENTRY_URL=https://www.cyapi.cyou/custom/71038ae6498c1ecb
```

服务启动时必须验证：

- 地址使用绝对 `http` 或 `https` URL；
- 地址不得包含用户名、密码、查询参数或 fragment；
- 地址的 origin 必须与 `SUB2API_ORIGIN` 完全一致；
- 生产环境必须使用 HTTPS。

配置错误时服务拒绝启动，避免把重新登录按钮变成任意外部跳转入口。`.env.example` 和 README 必须同步说明该变量。

## 服务端接口

新增只读公开接口 `GET /api/config`，只返回由入口地址构造的同源重新登录 URL：

```json
{
  "sub2api_relogin_url": "https://www.cyapi.cyou/balance-code-relogin?redirect=%2Fcustom%2F71038ae6498c1ecb"
}
```

该接口不返回管理员 API Key、密钥、分组 ID 或其他运行环境信息。前端从已经过服务端同源校验的地址解析主站 origin。响应使用固定结构校验，并允许未建立工具会话的浏览器访问。

## 前端行为

应用初始化时先加载公开配置，再继续执行现有 Token 交换或 `/api/me` 会话检查。公开配置加载失败属于“服务暂时不可用”，不能展示目标未知的重新进入按钮。

当状态为 `expired` 时，页面显示：

- 标题：`登录状态已过期`
- 说明：`点击下方按钮重新登录，登录成功后会自动返回。`
- 主操作：`重新登录并进入`
- 次操作：`打开主站`

主操作使用普通链接：工具位于 iframe 中时目标为 `_top`；位于独立窗口中时目标为 `_self`。次操作始终在新窗口打开 `SUB2API_ORIGIN`，并使用 `noopener noreferrer`。若父页面 sandbox 拦截顶层导航，用户仍可使用“打开主站”后从菜单重新进入。

## 数据流与错误处理

1. 工具加载公开配置。
2. 工具检测 `/api/me` 返回 `SESSION_REQUIRED`、`SESSION_INVALID` 或 `SESSION_EXPIRED`。
3. 前端清除内存中的待交换旧 Token并进入 `expired` 状态。
4. 用户点击“重新登录并进入”，浏览器导航到 sub2api 同源桥接页。
5. 桥接页清除 `auth_token`、`auth_user`、`refresh_token`、`token_expires_at` 和 `pending_auth_session`，然后进入 `/login?redirect=/custom/...`。
6. 登录成功后 sub2api 返回自定义页、传入新 JWT，工具重新交换会话、校验用户与分组并加载实时资料。

配置接口失败时显示“服务暂时不可用”和“重试”；主站已退出时由 sub2api 展示登录页；新 JWT 仍被拒绝时继续显示失效状态且不自动循环；分组拒绝和上游故障保持各自现有页面。

## 测试与验收

- 配置测试覆盖同源 HTTPS、跨源、凭据、查询、fragment、生产 HTTP 和缺失变量。
- 服务端测试确认未登录可读公开配置，且不泄露任何秘密。
- 前端测试覆盖 iframe `_top`、独立窗口 `_self`、文案、两个入口与配置失败。
- 端到端测试覆盖 iframe 会话失效后清除旧认证状态、进入登录页和保留非认证设置，并保持正常交换流程通过。
- 部署后检查 `/healthz`、`/api/config`、正常兑换、失效重入、权限拒绝和单实例约束。
