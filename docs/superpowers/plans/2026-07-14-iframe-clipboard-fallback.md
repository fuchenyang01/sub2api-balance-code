# iframe 剪贴板兼容复制实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让结果页、历史单条和复制全部在 sub2api 跨源 iframe 未授予 `clipboard-write` 时仍能复制，同时保持顶层页面优先使用现代 Clipboard API。

**架构：** 新增一个只负责浏览器复制的 `copyText()` 边界。iframe 内在用户点击的同步调用栈中优先使用临时 `textarea` 和 `execCommand('copy')`；顶层页面优先使用 `navigator.clipboard.writeText()`。两个 Vue 组件只消费布尔结果并更新现有提示，Playwright 使用与生产一致的不带 `allow="clipboard-write"` 的跨源 iframe 验收。

**技术栈：** TypeScript、Vue 3、Vitest + jsdom、Playwright Chromium、Docker、Nginx

---

## 文件结构

- 创建：`src/web/clipboard.ts`，集中处理现代复制、iframe 兼容复制、临时 DOM 清理和焦点恢复。
- 创建：`tests/web/clipboard.test.ts`，验证复制顺序、iframe 回退、清理、焦点和失败结果。
- 修改：`src/web/components/ConversionResult.vue`，结果页改用共享复制函数。
- 修改：`src/web/components/HistoryList.vue`，历史单条和复制全部改用共享复制函数。
- 修改：`tests/web/components.test.ts`，验证两个组件根据共享复制结果展示成功或失败提示。
- 修改：`tests/e2e/iframe.spec.ts`，在不授予 iframe 剪贴板写权限的真实 Chromium 场景中验证系统剪贴板内容。

## 任务 1：先锁定真实 iframe 回归红灯

**文件：**
- 修改：`tests/e2e/iframe.spec.ts`

- [ ] **步骤 1：扩展 Playwright 导入并编写失败的 iframe 复制测试**

在 `tests/e2e/iframe.spec.ts` 保留现有身份交换测试，并追加：

```ts
test('copies a completed code without clipboard-write delegation from the parent iframe', async ({
  page,
  context,
  environment,
}) => {
  const errors = collectBrowserErrors(page)
  await context.grantPermissions(['clipboard-read'], { origin: environment.mock.origin })
  await page.goto(environment.iframeParentUrl())

  expect(await page.locator('#tool-frame').getAttribute('allow')).toBeNull()
  const tool = page.frameLocator('#tool-frame')
  await expect(tool.getByText('测试用户')).toBeVisible()

  await tool.getByLabel('兑换金额').fill('10')
  await tool.getByRole('button', { name: '生成兑换码', exact: true }).click()
  await tool.getByTestId('confirm-conversion').click()
  await expect(tool.locator('.code-row code')).toHaveText('TEST-CODE-1')

  await tool.getByRole('button', { name: '复制兑换码', exact: true }).first().click()

  await expect(tool.getByText('已复制', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('TEST-CODE-1')
  expectNoBrowserErrors(errors)
})
```

- [ ] **步骤 2：运行测试并确认它因当前 iframe Clipboard API 被拒绝而失败**

运行：

```powershell
npm run build:web
npx playwright test tests/e2e/iframe.spec.ts --project=iframe --grep "copies a completed code"
```

预期：FAIL。iframe 显示“复制失败，请手动复制”或未出现“已复制”，证明测试捕获了截图中的生产问题。保存这次红灯输出，不修改测试来绕过失败。

## 任务 2：用 TDD 实现共享剪贴板边界

**文件：**
- 创建：`src/web/clipboard.ts`
- 创建：`tests/web/clipboard.test.ts`

- [ ] **步骤 1：编写剪贴板边界测试**

创建 `tests/web/clipboard.test.ts`：

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyText } from '../../src/web/clipboard.js'

const originalSelf = Object.getOwnPropertyDescriptor(window, 'self')
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function setEmbedded(embedded: boolean): void {
  Object.defineProperty(window, 'self', {
    configurable: true,
    value: embedded ? {} : window,
  })
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key)
  else Object.defineProperty(target, key, descriptor)
}

describe('copyText', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    setEmbedded(false)
  })

  afterEach(() => {
    restoreProperty(window, 'self', originalSelf)
    restoreProperty(navigator, 'clipboard', originalClipboard)
    restoreProperty(document, 'execCommand', originalExecCommand)
    document.body.replaceChildren()
  })

  it('prefers the modern clipboard API in a top-level page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const execCommand = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    await expect(copyText('CODE-TOP')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('CODE-TOP')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('copies synchronously through a temporary textarea in an iframe', async () => {
    setEmbedded(true)
    const writeText = vi.fn()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const execCommand = vi.fn(() => {
      const textarea = document.querySelector('textarea')
      expect(textarea?.value).toBe('CODE-IFRAME')
      return true
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    await expect(copyText('CODE-IFRAME')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(writeText).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('cleans up and returns false when modern and compatible copying fail', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => { throw new Error('copy blocked') }),
    })

    await expect(copyText('CODE-BLOCKED')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试，先修正模块加载，再确认行为断言处于红灯**

运行：

```powershell
npx vitest run tests/web/clipboard.test.ts
```

首次预期：测试因 `src/web/clipboard.ts` 尚不存在而无法加载。

创建最小接口，使测试能够运行但仍因行为缺失而失败：

```ts
export async function copyText(_text: string): Promise<boolean> {
  return false
}
```

再次运行相同命令。预期：前两个测试 FAIL，显示期望 `true`、实际 `false`。这才是本任务用于进入实现阶段的有效红灯。

- [ ] **步骤 3：编写最少实现**

将 `src/web/clipboard.ts` 替换为：

```ts
function isEmbedded(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

function restoreFocus(element: Element | null): void {
  if (!(element instanceof HTMLElement) || !element.isConnected) return
  try {
    element.focus({ preventScroll: true })
  } catch {
    // Focus restoration is best-effort and must not change the copy result.
  }
}

function copyWithTextarea(text: string): boolean {
  if (document.body === null || typeof document.execCommand !== 'function') return false

  const activeElement = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.tabIndex = -1
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.append(textarea)

  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    restoreFocus(activeElement)
  }
}

async function copyWithModernApi(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function copyText(text: string): Promise<boolean> {
  const embedded = isEmbedded()
  if (embedded && copyWithTextarea(text)) return true
  if (await copyWithModernApi(text)) return true
  return embedded ? false : copyWithTextarea(text)
}
```

- [ ] **步骤 4：运行共享边界测试并确认绿灯**

运行：

```powershell
npx vitest run tests/web/clipboard.test.ts
```

预期：3 tests passed，且无未处理异常或警告。

## 任务 3：接入所有复制入口并让 iframe 回归转绿

**文件：**
- 修改：`src/web/components/ConversionResult.vue`
- 修改：`src/web/components/HistoryList.vue`
- 修改：`tests/web/components.test.ts`
- 测试：`tests/e2e/iframe.spec.ts`

- [ ] **步骤 1：先把组件断言改为共享函数契约**

在 `tests/web/components.test.ts` 的组件导入之前添加：

```ts
const clipboardController = vi.hoisted(() => ({ copyText: vi.fn() }))

vi.mock('../../src/web/clipboard.js', () => ({
  copyText: clipboardController.copyText,
}))
```

将 `ConversionResult` 成功测试中的 `navigator.clipboard` mock 和 `writeText` 断言替换为：

```ts
clipboardController.copyText.mockResolvedValue(true)
// 点击后：
expect(clipboardController.copyText).toHaveBeenCalledWith('CODE-SECRET')
expect(wrapper.text()).toContain('已复制')
```

追加失败状态测试：

```ts
it('shows manual-copy feedback when compatible copying fails', async () => {
  clipboardController.copyText.mockResolvedValue(false)
  const wrapper = mount(ConversionResult, {
    props: {
      result: {
        status: 'completed', operation_id: 'op-copy-fail', amount: '1',
        code: 'CODE-BLOCKED', created_at: '2026-07-14T00:00:00.000Z',
      },
      pending: null,
    },
  })

  await wrapper.get('[aria-label="复制兑换码"]').trigger('click')

  expect(wrapper.text()).toContain('复制失败，请手动复制')
})
```

将 `HistoryList` 成功测试改为检查 `clipboardController.copyText` 的两次调用，并追加：

```ts
it('shows manual-copy feedback when history copying fails', async () => {
  clipboardController.copyText.mockResolvedValue(false)
  const wrapper = mount(HistoryList, { props: { items } })

  await wrapper.get('[aria-label="复制兑换码 CODE-ONE"]').trigger('click')

  expect(wrapper.text()).toContain('复制失败，请手动复制')
})
```

- [ ] **步骤 2：运行组件测试并确认它因组件仍直接访问 navigator.clipboard 而失败**

运行：

```powershell
npx vitest run tests/web/components.test.ts
```

预期：新增共享函数调用断言 FAIL，证明组件尚未使用统一边界。

- [ ] **步骤 3：最小化修改两个组件**

在 `ConversionResult.vue` 中导入：

```ts
import { copyText } from '../clipboard.js'
```

将 `copyCode()` 改为：

```ts
async function copyCode(): Promise<void> {
  if (props.result === null) return
  copyState.value = await copyText(props.result.code) ? 'success' : 'error'
}
```

在 `HistoryList.vue` 中导入：

```ts
import { copyText } from '../clipboard.js'
```

将 `copy()` 改为：

```ts
async function copy(text: string, success: string): Promise<void> {
  copyStatus.value = await copyText(text) ? success : '复制失败，请手动复制'
}
```

- [ ] **步骤 4：运行单元和组件测试确认绿灯**

运行：

```powershell
npx vitest run tests/web/clipboard.test.ts tests/web/components.test.ts
```

预期：两个测试文件全部通过。

- [ ] **步骤 5：重新构建前端并重跑任务 1 的真实 iframe 测试**

运行：

```powershell
npm run build:web
npx playwright test tests/e2e/iframe.spec.ts --project=iframe --grep "copies a completed code"
```

预期：PASS。父 iframe 仍没有 `allow="clipboard-write"`，系统剪贴板内容为 `TEST-CODE-1`，页面显示“已复制”。

- [ ] **步骤 6：提交功能修复**

```powershell
git add src/web/clipboard.ts src/web/components/ConversionResult.vue src/web/components/HistoryList.vue tests/web/clipboard.test.ts tests/web/components.test.ts tests/e2e/iframe.spec.ts
git diff --cached --check
git commit -m "fix: copy codes inside embedded iframe"
```

预期：提交只包含共享剪贴板边界、两个组件和对应测试。

## 任务 4：完整验证、推送和生产部署

**文件：**
- 验证：整个仓库
- 部署：`/opt/sub2api-balance-code`

- [ ] **步骤 1：运行完整本地验证**

```powershell
npm test
npm run typecheck
npm run build
npm run test:e2e
git diff --check
git status --short
```

预期：Vitest 全部通过，类型检查退出码为 0，生产构建退出码为 0，desktop/iframe/mobile Playwright 全部通过，工作区无未提交文件。

- [ ] **步骤 2：推送 main 到 GitHub**

```powershell
git push origin main
git status -sb
```

预期：本地 `main` 与 `origin/main` 同步。

- [ ] **步骤 3：服务器拉取并构建新镜像，不影响运行中的旧容器**

```powershell
ssh 64.83.47.63 "cd /opt/sub2api-balance-code && git pull --ff-only origin main && git rev-parse --short HEAD && docker build -t sub2api-balance-code:local ."
```

预期：拉取为 fast-forward，镜像构建成功。构建期间旧容器继续运行。

- [ ] **步骤 4：以单实例方式替换容器，并保留自动回滚所需的旧镜像 ID**

通过 SSH 执行以下脚本。它先记录旧镜像，再停止并删除旧容器；新容器健康检查失败时，使用旧镜像重新创建原容器：

```bash
set -e
old_image=$(docker inspect --format='{{.Image}}' sub2api-balance-code)
docker stop sub2api-balance-code
docker rm sub2api-balance-code

if docker run -d \
  --name sub2api-balance-code \
  --restart unless-stopped \
  --env-file /opt/sub2api-balance-code/.env \
  -p 127.0.0.1:3100:3000 \
  sub2api-balance-code:local; then
  healthy=false
  for _ in $(seq 1 30); do
    if [ "$(docker inspect --format='{{.State.Health.Status}}' sub2api-balance-code 2>/dev/null)" = healthy ]; then
      healthy=true
      break
    fi
    sleep 2
  done
  if [ "$healthy" = true ]; then
    exit 0
  fi
fi

docker rm -f sub2api-balance-code 2>/dev/null || true
docker run -d \
  --name sub2api-balance-code \
  --restart unless-stopped \
  --env-file /opt/sub2api-balance-code/.env \
  -p 127.0.0.1:3100:3000 \
  "$old_image"
exit 1
```

预期：任意时刻最多一个工具容器运行；成功后新容器为 `healthy`，失败时恢复旧镜像并返回非零退出码。

- [ ] **步骤 5：验证生产服务和安全边界**

```powershell
curl.exe -fsS https://code.cyapi.cyou/healthz
curl.exe -sS -D - -o NUL https://code.cyapi.cyou/
ssh 64.83.47.63 "docker inspect --format='{{.State.Status}} {{.State.Health.Status}} {{json .NetworkSettings.Ports}}' sub2api-balance-code; /www/server/nginx/sbin/nginx -t"
```

预期：

- `/healthz` 返回 `{"status":"ok"}`。
- 首页返回 200，CSP 仍允许 `https://www.cyapi.cyou`，且没有 `X-Frame-Options`。
- 容器为 `running healthy`，端口仍仅绑定 `127.0.0.1:3100`。
- Nginx 配置检查成功。

- [ ] **步骤 6：生产 iframe 手工验收**

在 `https://www.cyapi.cyou` 登录后打开“余额转换”，对已有历史记录点击复制图标，不生成新的兑换码。将剪贴板内容粘贴到本地临时文本框核对，并确认页面显示“已复制”。随后测试“复制全部”。

预期：内嵌模式两个入口都能复制；新窗口复制仍正常；不会产生新的余额扣减或兑换码。
