# 会话失效一键重新进入实现计划

> **面向 AI 代理的工作者：** 使用 `superpowers:executing-plans` 在当前隔离工作树中逐任务实现，所有生产代码遵循 TDD。

**目标：** 在工具会话失效时提供安全的一键返回 sub2api 自定义页面入口，以重新获得当前 JWT。

**架构：** 服务端验证并公开固定的 sub2api 自定义页面 URL 与主站 origin；前端在初始化时读取该公开配置，并在会话失效状态渲染普通链接。链接在 iframe 内使用顶层导航，在独立窗口内使用当前窗口导航。

**技术栈：** TypeScript、Fastify、Vue 3、Zod、Vitest、Playwright。

---

## 文件结构

- 修改 `.env.example`：声明必填的 `SUB2API_ENTRY_URL`。
- 修改 `src/server/config.ts`：验证入口 URL 并加入 `AppConfig`。
- 创建 `src/server/routes/public-config.ts`：提供最小公开配置接口。
- 修改 `src/server/app.ts`：注册公开配置路由。
- 修改 `src/shared/contracts.ts`：定义公开配置响应。
- 修改 `src/web/api.ts`：校验并读取公开配置。
- 修改 `src/web/composables/useConversion.ts`：在会话初始化前加载公开配置。
- 修改 `src/web/App.vue`：渲染失效重入链接和主站退路。
- 修改 `src/web/styles.css`：复用按钮视觉并支持链接布局。
- 修改 `README.md`：补充必要变量和失效处理说明。
- 修改对应 Vitest、部署契约和 Playwright 测试。

### 任务 1：配置与公开接口

- [x] 在 `tests/server/config.test.ts` 添加 `SUB2API_ENTRY_URL` 必填、规范化和安全边界测试。
- [x] 在 `tests/server/routes.test.ts` 添加未登录读取 `/api/config` 的失败测试，断言固定字段且无秘密。
- [x] 运行 `npm test -- tests/server/config.test.ts tests/server/routes.test.ts`，确认因配置字段和路由缺失而失败。
- [x] 修改 `src/server/config.ts` 与 `.env.example`，实现同源、安全 URL 校验。
- [x] 创建 `src/server/routes/public-config.ts`，修改 `src/server/app.ts` 注册路由。
- [x] 运行上述测试，确认通过。

### 任务 2：前端公开配置与失效操作

- [x] 在 `tests/web/useConversion.test.ts` 添加初始化加载公开配置和配置失败状态测试。
- [x] 在 `tests/web/components.test.ts` 添加失效页面文案、iframe `_top`、独立窗口 `_self` 和主站链接测试。
- [x] 运行 `npm test -- tests/web/useConversion.test.ts tests/web/components.test.ts`，确认因 API 和 UI 缺失而失败。
- [x] 修改 `src/shared/contracts.ts`、`src/web/api.ts` 和 `src/web/composables/useConversion.ts` 读取并暴露公开配置。
- [x] 修改 `src/web/App.vue` 和 `src/web/styles.css` 实现链接与响应式布局。
- [x] 运行上述测试，确认通过。

### 任务 3：端到端与文档契约

- [x] 修改 E2E 测试环境配置，提供测试入口 URL。
- [x] 在 `tests/e2e/iframe.spec.ts` 添加失效状态链接目标测试。
- [x] 修改 `tests/deployment.test.ts`，要求 README 和 `.env.example` 包含新变量与关键说明。
- [x] 运行 `npm run test:e2e -- tests/e2e/iframe.spec.ts` 和 `npm test -- tests/deployment.test.ts`，确认新增断言先失败。
- [x] 精简修改 README 的配置、部署、排错章节，使新增契约通过。
- [x] 重跑专项测试确认通过。

### 任务 4：完整验证

- [x] 运行 `npm run typecheck`，退出码 0。
- [x] 运行 `npm test`，全部测试通过。
- [x] 运行 `npm run build`，退出码 0。
- [x] 运行 `npm run test:e2e`，全部 E2E 通过。
- [x] 运行 `git diff --check` 并检查 `git status --short`，确保仅包含计划内文件，且 `宣传博文/` 未进入工作树。
