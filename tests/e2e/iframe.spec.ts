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
