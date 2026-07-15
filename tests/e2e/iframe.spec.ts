import type { Frame } from '@playwright/test'

import {
  collectBrowserErrors,
  expectNoBrowserErrors,
  expectNoOverlap,
  expectVisibleBox,
} from './fixtures/browser-assertions.js'
import { expect, test } from './fixtures/test-server.js'

test('exchanges the URL token across same-site origins and keeps the cookie usable', async ({ page, environment }, testInfo) => {
  const errors = collectBrowserErrors(page)
  await page.goto(environment.iframeParentUrl())
  const tool = page.frameLocator('#tool-frame')
  await expect(tool.getByText('测试用户')).toBeVisible()

  const frame = page.frames().find((candidate: Frame) => candidate !== page.mainFrame())
  expect(frame).toBeDefined()
  const parentUrl = new URL(page.url())
  const cleaned = new URL(frame!.url())
  expect(parentUrl.origin).not.toBe(cleaned.origin)
  expect(parentUrl.protocol).toBe(cleaned.protocol)
  expect(parentUrl.hostname).toBe(cleaned.hostname)
  expect(cleaned.searchParams.has('token')).toBe(false)
  expect(cleaned.searchParams.has('user_id')).toBe(false)
  expect(cleaned.searchParams.get('theme')).toBe('dark')
  expect(cleaned.searchParams.get('ui_mode')).toBe('iframe')
  expect(cleaned.searchParams.get('lang')).toBe('zh-CN')

  const meRequest = page.waitForRequest((request) => (
    request.method() === 'GET' && new URL(request.url()).pathname === '/api/me'
  ))
  const me = await frame!.evaluate(async () => {
    const response = await fetch('/api/me', { credentials: 'same-origin' })
    return { status: response.status, body: await response.json() }
  })
  expect((await meRequest).headers().authorization).toBeUndefined()
  expect(me).toMatchObject({ status: 200, body: { id: 7, username: '测试用户', balance: '100' } })
  await expectVisibleBox(tool.locator('.workspace'))
  await expectNoOverlap(tool.locator('.tool-grid'), tool.locator('.history-section'))
  await page.screenshot({ path: testInfo.outputPath('iframe.png'), fullPage: true })
  expectNoBrowserErrors(errors)
})

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
  await expect(tool.locator('.result-code-list .code-row code')).toHaveText('TEST-CODE-1')

  await tool.getByLabel('复制兑换码 TEST-CODE-1').first().click()

  await expect(tool.getByText('已复制', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('TEST-CODE-1')
  expectNoBrowserErrors(errors)
})

test('restores iframe access after group membership is granted', async ({ page, environment }) => {
  environment.mock.setAllowedGroups([])

  await page.goto(environment.iframeParentUrl())

  const tool = page.frameLocator('#tool-frame')
  await expect(tool.getByRole('heading', { name: '暂无余额兑换权限' })).toBeVisible()
  const errors = collectBrowserErrors(page)
  await expect(tool.getByLabel('兑换金额')).toHaveCount(0)
  expect(environment.mock.totalGenerateRequests()).toBe(0)
  expect(environment.mock.totalDebitRequests()).toBe(0)

  const frame = page.frames().find((candidate: Frame) => candidate !== page.mainFrame())
  expect(frame).toBeDefined()
  expect(new URL(frame!.url()).searchParams.has('token')).toBe(false)

  environment.mock.setAllowedGroups([24])
  await tool.getByTestId('retry-access').click()

  await expect(tool.getByText('测试用户')).toBeVisible()
  await expect(tool.getByLabel('兑换金额')).toBeVisible()
  expect(new URL(frame!.url()).searchParams.has('token')).toBe(false)
  expect(environment.mock.totalGenerateRequests()).toBe(0)
  expect(environment.mock.totalDebitRequests()).toBe(0)
  expectNoBrowserErrors(errors)
})
