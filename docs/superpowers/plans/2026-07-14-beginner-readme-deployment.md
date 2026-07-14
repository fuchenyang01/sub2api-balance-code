# 新手部署 README 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将根目录 README 重写为零基础用户可以从空白 Ubuntu/Debian 服务器完成部署、接入和排错的完整中文教程。

**架构：** 保持单 README 结构，以执行顺序组织生产部署主路径，再提供运维、故障排查、安全限制和开发说明。命令严格复用现有 Dockerfile、环境变量和单实例架构，不新增运行组件。

**技术栈：** Markdown、Ubuntu/Debian、Docker、Nginx、Certbot、sub2api 管理后台

---

### 任务 1：重写用途说明和生产部署主路径

**文件：**
- 修改：`README.md`

- [ ] **步骤 1：建立教程目录和概念说明**

  在 README 顶部写明项目用途、不适用场景、用户 JWT 与 Admin API Key 的区别、单实例限制，并提供完整目录。

- [ ] **步骤 2：写入部署前准备和示例替换表**

  使用 `sub.example.com`、`code.example.com`、`203.0.113.10` 作为文档示例，逐项解释服务器、DNS、SSH、同站点子域和管理员权限。

- [ ] **步骤 3：写入服务器安装与 sub2api 准备步骤**

  提供 Ubuntu/Debian 上安装 Git、Docker、Nginx、Certbot 的命令，并写明 sub2api“系统设置 -> 安全 -> 管理员 API Key”的操作路径。

- [ ] **步骤 4：写入项目配置与容器启动步骤**

  给出克隆仓库、创建 `.env`、分别生成两条密钥、构建镜像、以 `127.0.0.1:3100:3000` 启动单容器和检查 `/healthz` 的完整命令及预期输出。

- [ ] **步骤 5：写入 Nginx 与 HTTPS 步骤**

  提供不记录 query string 的 `log_format`、完整站点反向代理配置、`nginx -t`、Certbot 命令和 HTTPS 验证命令。

- [ ] **步骤 6：写入 sub2api 自定义菜单和用户验收步骤**

  说明“系统设置 -> 常规 -> 自定义菜单”的字段，明确 URL 只填写 `https://code.example.com`，并列出 iframe 身份、余额、开码、余额刷新和新窗口的验收项。

### 任务 2：补全运维、排错和安全参考

**文件：**
- 修改：`README.md`

- [ ] **步骤 1：写入日常运维命令**

  覆盖查看状态和日志、重启、停止、升级前备份镜像标签、拉取代码、重建、健康检查和失败回滚。

- [ ] **步骤 2：按现象写入故障排查**

  覆盖容器退出、健康检查失败、502、证书失败、iframe 内容被屏蔽、iframe 会话失效但新窗口正常、401、Admin API Key 失败、余额未刷新和 pending。

- [ ] **步骤 3：保留完整安全和资金风险说明**

  保留单实例、非原子生成码与扣款、Web Locks、浏览器 localStorage、操作 TTL、人工核对顺序和日志脱敏要求。

- [ ] **步骤 4：补全环境变量与本地开发**

  保留所有现有环境变量约束，给出 Windows/PowerShell 与通用 shell 的本地启动说明，并明确本地跨站 iframe 使用新窗口。

### 任务 3：验证文档与仓库

**文件：**
- 验证：`README.md`
- 验证：`.env.example`
- 验证：`Dockerfile`
- 验证：`src/server/config.ts`

- [ ] **步骤 1：检查教程中的固定值**

  运行：

  ```powershell
  Select-String -Path README.md -Pattern '127.0.0.1:3100:3000','NODE_ENV=production','COOKIE_SECURE=true','TRUST_PROXY=true','healthz','\$uri'
  ```

  预期：每个生产关键值至少命中一次。

- [ ] **步骤 2：检查未完成占位符和 Markdown 差异**

  运行：

  ```powershell
  Select-String -Path README.md -Pattern 'TODO|TBD|待定|待补'
  git diff --check
  ```

  预期：占位符扫描无输出，`git diff --check` 退出码为 0。

- [ ] **步骤 3：运行完整测试和构建**

  运行：

  ```bash
  npm test
  npm run build
  ```

  预期：Vitest 全部通过，类型检查、前端构建和服务端构建退出码均为 0。

- [ ] **步骤 4：检查最终改动范围**

  运行：

  ```bash
  git status --short
  git diff -- README.md
  ```

  预期：README 改写完整；已有 `src/server/app.ts` 和 `tests/server/routes.test.ts` 修改保持不变，没有被覆盖。

