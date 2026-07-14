# 新手部署 README 改版设计

## 目标

将项目根目录的 `README.md` 重写为一份面向零基础站长的完整中文指南。读者只需要具备一台 Ubuntu 或 Debian 云服务器、一个可管理 DNS 的域名、一个已运行的 sub2api 站点，以及 sub2api 管理员权限，即可按顺序完成部署和验收。

文档首先解释项目用途和边界，再提供可复制执行的生产部署步骤。每个关键步骤都包含成功标志和常见失败原因，避免读者只执行命令却不知道结果是否正确。

## 读者与主路径

- 目标读者：不了解 Node.js、Docker、Nginx、JWT 或反向代理的新手。
- 服务器：Ubuntu 22.04、Ubuntu 24.04 或仍受支持的 Debian 版本。
- 操作方式：通过 SSH 使用命令行。
- 运行方式：单 Docker 容器，只绑定服务器回环地址。
- 公网入口：Nginx 反向代理并由 Certbot 配置 HTTPS。
- iframe 部署：sub2api 与工具使用同一注册域下的两个 HTTPS 子域。
- 示例域名：sub2api 使用 `sub.example.com`，本工具使用 `code.example.com`。

宝塔、1Panel、Kubernetes、多实例部署、一键安装脚本和完全跨站 iframe 不属于本次教程范围。完全不同站点只说明使用新窗口的限制。

## README 信息结构

README 按实际执行顺序组织：

1. 项目用途、适用场景和不提供的能力。
2. 用户身份与余额兑换的工作流程。
3. 风险摘要和单实例约束。
4. 部署前准备清单与示例值替换表。
5. DNS 解析和 SSH 登录。
6. 安装 Git、Docker、Nginx 和 Certbot。
7. 在 sub2api 的“系统设置 -> 安全”创建管理员 API Key。
8. 克隆项目、生成两条独立密钥并填写 `.env`。
9. 构建镜像、启动单容器并检查 `/healthz`。
10. 配置 Nginx、安全访问日志和反向代理。
11. 使用 Certbot 申请 HTTPS 证书。
12. 在 sub2api 的“系统设置 -> 常规 -> 自定义菜单”添加用户入口。
13. 验证页面、身份、余额、开码和余额刷新。
14. 日常查看日志、重启、升级、回滚和停止服务。
15. 按错误现象组织的故障排查。
16. pending 人工核对、安全注意事项、环境变量参考和本地开发。

README 顶部提供目录，但不额外拆分部署文档，确保新手始终在同一个页面完成操作。

## 命令与配置原则

- 所有生产命令基于仓库现有 `Dockerfile`，不引入 Docker Compose。
- 容器映射固定示例为 `127.0.0.1:3100:3000`，不直接暴露公网端口。
- `.env` 的生产示例必须使用 HTTPS，并设置 `NODE_ENV=production`、`COOKIE_SECURE=true` 和 `TRUST_PROXY=true`。
- 两条安全密钥分别生成，禁止复用；Admin API Key 只进入服务端 `.env`。
- Nginx 示例将日志中的请求行拆成 method、`$uri` 和 protocol，不能记录 query string，避免泄露用户 JWT。
- Nginx 配置包含请求体限制、连接超时、读写超时和必要的代理请求头。
- Certbot 前先验证 HTTP 站点和 Nginx 配置，证书签发后再验证 HTTPS。
- 自定义菜单只填写工具根 URL，sub2api 自动附带用户 JWT，读者不需要手工拼接 `token`。

## 新手解释规则

- 专有名词首次出现时用一句话解释，例如 DNS、SSH、反向代理、origin、JWT 和 iframe。
- 每段命令前说明“在哪里执行”和“命令会做什么”。
- 所有需要替换的值都集中列入示例表，并在命令附近再次提醒。
- 每个阶段给出明确成功标志，例如健康检查必须返回 `{"status":"ok"}`。
- 密钥示例只使用无效占位文本，禁止放入真实密钥或容易被误用的固定值。
- 明确区分用户 JWT、管理员 API Key 和模型 API Key。

## 故障排查范围

至少覆盖以下现象：

- 容器启动后立即退出。
- `healthz` 无法访问。
- Nginx 返回 502。
- HTTPS 证书申请失败。
- iframe 显示“内容被屏蔽”。
- iframe 显示“会话失效”，但新窗口可以使用。
- 页面显示需要登录或 401。
- Admin API Key 鉴权失败。
- 转换完成后余额或页面状态异常。
- 页面显示“结果待确认”。

每个问题按“常见原因 -> 检查命令 -> 处理方式”给出，不建议关闭 Cookie、CSP 或其他安全保护来绕过部署错误。

## 验收标准

- README 能让新手从一台空白 Ubuntu/Debian 服务器完成生产部署。
- 所有命令与当前仓库文件、端口和环境变量一致。
- iframe 部署要求与 `SameSite=Lax` Cookie 行为一致。
- Nginx 示例不会记录入口 URL 的 query string。
- 文档保留现有单实例、非原子兑换和 pending 人工核对警告。
- Markdown 链接、代码块、标题层级和示例配置可读且无占位遗漏。
- `npm test`、`npm run build` 和 `git diff --check` 继续通过。

