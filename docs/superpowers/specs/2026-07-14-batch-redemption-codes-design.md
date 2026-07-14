# 批量生成兑换码设计

## 目标

在不修改 sub2api 的前提下，将现有单码余额兑换扩展为批量兑换。用户输入单个兑换码的面值和数量，整批共用一个 `operation_id`，正常路径中只调用一次 sub2api 批量建码接口，并只执行一次总额扣款。

数量默认为 1，允许 1 到 100 的整数。输入金额始终表示单个兑换码的面值，总扣款为单码面值乘以数量。

## 不在范围内

- 不修改 Wei-Shaw/sub2api 的源码、数据库或部署。
- 不将批量操作拆成多个独立的单码 `prepare/execute` 请求。
- 不支持每个码不同面值、不同有效期或不同类型。
- 不将本地历史改为服务端持久化。
- 不通过时间、金额或相邻 ID 猜测哪些 sub2api 兑换码属于失败批次。

## 核心决策

1. 保留现有 `prepare -> execute` 两阶段流程、操作令牌和断线恢复机制。
2. 整批只使用一个 `operation_id`，不为批内每个兑换码创建独立操作。
3. `prepare` 校验单码面值、数量和总额；`execute` 从签名操作令牌重新取得这些值，不信任浏览器传入的总额。
4. 数量为 1 时也使用统一批量合约，不保留平行的单码实现。
5. 一个批次无论包含多少个兑换码，都只消耗一次 `prepare` 和一次 `execute` 限流配额。

## 公共合约

### Prepare

`PrepareRequest` 扩展为：

```ts
interface PrepareRequest {
  operation_id: string
  amount: string
  count: number
}
```

`amount` 是单码面值，`count` 必须是 1 到 100 的整数。服务端用 `Decimal` 计算 `total_amount = amount * count`，并用总额与实时余额比较。

`PrepareResponse` 返回标准化单码面值、数量和总额：

```ts
interface PrepareResponse {
  operation_token: string
  expires_at: string
  amount: string
  count: number
  total_amount: string
}
```

### Execute

操作令牌负载包含 `operationId`、`userId`、`amount` 和 `count`。`total_amount` 每次从已签名的单码面值和数量重新计算，不作为独立的可修改值。

完成响应为：

```ts
interface CompletedCode {
  code: string
  created_at: string
}

interface CompletedBatch {
  status: 'completed'
  operation_id: string
  amount: string
  count: number
  total_amount: string
  codes: CompletedCode[]
}
```

`codes.length` 必须与 `count` 完全相等。待确认响应继续只返回 `status`、`operation_id` 和安全错误码，不泄露部分兑换码。

## 服务端数据流

### Prepare 阶段

1. 验证 `amount` 是最多 8 位小数的正数。
2. 验证 `count` 是 1 到 100 的整数。
3. 使用 `Decimal` 计算总额，确保计算结果可精确转换为 sub2api 接口接受的数值。
4. 查询实时用户 profile，确认用户 ID 一致且总额不超过余额。
5. 签发包含单码面值和数量的操作令牌。

### Execute 正常路径

1. 验证操作令牌，并在现有用户级互斥锁内执行整批操作。
2. 重新查询实时 profile 并核对用户 ID。
3. 只发起一次 `POST /api/v1/admin/redeem-codes/generate`，请求体为 `{ count, type: "balance", value: amount }`，幂等键为 `code-<operation_id>`。
4. 直接校验批量建码响应，不按数量循环调用单码查询接口。校验内容包括数量、类型、面值、唯一 ID 和唯一兑换码。
5. 只发起一次用户余额扣减，金额为 `amount * count`，幂等键为 `debit-<operation_id>`。
6. 扣款确认成功后，返回整批兑换码。

`AdminClient` 将单码 `generateCode` 替换为 `generateCodes(operationId, amount, count)`，并增加使用 sub2api `POST /api/v1/admin/redeem-codes/batch-delete` 的批量删除方法。

## 失败、补偿与恢复

- 建码超时、网络失败、幂等存储不可用或响应无法验证时，整批进入待确认状态，不扣款、不展示任何部分兑换码。
- 扣款超时或返回不确定错误时，保留原操作令牌。恢复时重放相同的批量建码和扣款幂等键，不创建新批次。
- 扣款明确因余额不足失败且已获得完整兑换码 ID 集合时，调用一次 sub2api 批量删除。只有已删除数量与本批数量完全相等时才确认操作终止。
- 批量删除超时、返回数量不符或任何结果不可判定时，整批转人工核对。
- 只有本地历史完整写入并成功清除恢复记录后，前端才将整批标记为完成。

## sub2api 非事务批量建码的已知限制

已核对 Wei-Shaw/sub2api 当前实现：管理员接口允许 `count` 为 1 到 100，但 `GenerateRedeemCodes` 在循环中逐个调用仓储 `Create`，没有数据库事务。

因此，如果 sub2api 在批次中途写入失败，它可能已经保存前几个兑换码，却只向调用方返回整体错误。本工具在这种情况下拿不到部分成功记录的 ID，无法安全删除它们。

根据用户确认，本项目继续保持“不修改 sub2api”的边界，并接受这个残余风险：

- 页面不会将部分结果当作成功，也不会扣款。
- 整批显示为待确认，保留 `operation_id` 和请求时间供管理员核对。
- 不按时间、金额或 ID 范围自动删除兑换码，因为这会导致误删并发的其他管理员操作。
- README 明确说明此限制和人工核对要点。

只有将 sub2api 的批量创建改为数据库事务，才能从根本上保证“全部生成或一个都不生成”。

## 前端状态与界面

### 表单

- 增加数量数字输入框，默认为 1，`min=1`、`max=100`、`step=1`。
- 数量必须是纯数字整数，不接受小数、科学计数法、符号或空值。
- 金额验证从“单码面值不超过余额”改为“单码面值乘以数量不超过余额”。
- 表单显示预计总扣款。
- 点击“全部余额”时，使用 `Decimal`将余额除以数量，向下保留最多 8 位小数。结果无法得到正数时保持不可提交。

### 确认框

确认框显示单码面值、数量、总扣款、兑换比例和有效期。用户明确确认后才创建 `operation_id`。

### 结果

- 完成状态显示本批所有兑换码，每条可单独复制。
- 提供“复制全部”操作，每行一个兑换码，继续使用现有 iframe 兼容 `copyText()` 边界。
- 结果元数据显示单码面值、数量、总额和生成时间。
- 待确认状态只显示批次操作编号和恢复指引，不显示任何部分码。

## 本地存储与向后兼容

现有历史按 `operation_id` 去重，无法保存同批的多个兑换码。新历史记录使用版本 2，包含：

- `history_id`：由 `operation_id` 和从 1 开始的 `batch_index` 稳定派生。
- `operation_id`：整批共用的操作编号。
- `batch_index` 和 `batch_size`：批内序号和总数。
- `amount`、`code` 和 `created_at`：单个兑换码的现有字段。

待处理记录也升级为版本 2 并增加 `count`。读取时同时接受版本 1：

- 版本 1 历史记录在内存中规范化为 `batch_index=1`、`batch_size=1`，`history_id` 使用原 `operation_id`。
- 版本 1 待处理记录规范化为 `count=1`。
- 新写入统一使用版本 2，不清空旧历史或旧恢复记录。

历史仍最多保留 100 个兑换码。当新批次包含 100 个码时，它们占满历史容量，更旧记录按既有规则移除。

为恢复部署前已签发的单码操作令牌，令牌验证层接受缺失 `count` 的旧负载并将其视为 `count=1`。新签发令牌必须显式包含 `count`。

## 限流语义

现有每用户每分钟 10 次 `prepare` 和 10 次 `execute` 的限制保持不变。限流按 HTTP 批次请求计数，不按返回的兑换码数量计数。因此一批生成 100 个码只占用一次 `prepare` 和一次 `execute` 配额。

## 测试策略

### 合约和数值

- 验证数量 1 和 100 的边界，拒绝 0、101、小数、字符串和额外字段。
- 验证服务端独立计算总额，防止浮点误差、溢出或超额扣款。
- 验证客户端严格解析完整批次响应，拒绝部分或多余兑换码。

### 服务和上游客户端

- 数量为 10 时，断言只调用一次 `generateCodes`、一次 `debitBalance`，并按总额扣款。
- 验证批量建码请求体、幂等键、响应长度和安全管理员请求头。
- 验证返回数量不符、重复 ID、重复兑换码、错误类型和错误面值。
- 验证建码不确定、扣款不确定、明确余额不足和批量删除不完整。
- 验证同一批次重放使用原幂等键，不重复生成或扣款。

### 存储和前端

- 验证版本 1 历史、待处理记录和操作令牌的数量 1 兼容逻辑。
- 验证同一 `operation_id` 下多个历史项不被去重。
- 验证数量默认值、边界、总额校验和“全部余额”向下取 8 位的行为。
- 验证确认框展示单码面值、数量和总额。
- 验证批量结果、单条复制、iframe 兼容的复制全部和失败提示。

### E2E

模拟 sub2api 一次生成 3 个码，验证：

- 页面只发起一组 `prepare/execute`。
- 上游只收到一次批量建码和一次总额扣款。
- 结果区显示 3 个码，复制全部与系统剪贴板一致。
- 历史包含 3 条独立记录，余额在完成后只刷新一次。
- 桌面、跨源 iframe 和移动窄屏均无溢出或控件重叠。

## 部署与生产验收

实现完成后运行全量 Vitest、类型检查、生产构建和全部 Playwright 项目。合并并推送 `main` 后，服务器仍使用单实例容器替换和健康失败自动回滚流程。

生产环境不生成测试批次，避免实际扣款。部署验证限于 HTTPS 健康接口、首页响应头、CSP、Nginx 配置、容器健康状态和 localhost 端口绑定。实际批量生成由用户在可控余额的账户上手工验收。
