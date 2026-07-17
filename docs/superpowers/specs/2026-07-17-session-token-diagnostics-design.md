# 会话 Token 脱敏诊断设计

## 目标

在不修改 sub2api、不改变用户登录与兑换行为的前提下，定位独立工具向 sub2api 提交的 JWT 为什么被拒绝。

## 方案

当 `/api/session/exchange` 收到 sub2api 的认证拒绝时，独立工具写入一条结构化警告日志。日志只包含：

- sub2api HTTP 状态码和稳定错误原因；
- JWT 的 `iat`、`exp` 对应 UTC 时间；
- JWT SHA-256 摘要的短前缀，用于比较两次请求是否为同一 Token；
- 当前请求 ID，由现有 Fastify 日志自动关联。

日志不得包含 JWT 原文、Authorization、Cookie、用户余额或上游响应正文。浏览器仍收到现有的 `SESSION_INVALID` 或 `SESSION_EXPIRED`，业务行为不变。

## 数据流

1. 浏览器把 URL 中的 Token 发送到独立工具的 `/api/session/exchange`。
2. 独立工具请求 sub2api 用户资料接口。
3. sub2api 返回认证错误时，独立工具先生成脱敏诊断字段，再沿用现有错误映射。
4. 运维人员通过 `iat` 判断页面是否传入刚登录签发的 Token，通过摘要比较多次失败是否重复使用同一 Token。

## 验证

- 单元测试验证摘要稳定、不同 Token 摘要不同、非法 JWT 不抛出异常。
- 路由测试验证认证失败会记录诊断字段，同时日志中不存在 JWT 原文和响应正文。
- 完整测试、构建和生产健康检查必须通过。
