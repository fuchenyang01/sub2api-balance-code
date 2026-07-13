import type { ConsoleMessage, Frame, Locator, Page, TestInfo } from '@playwright/test'

import { expect, test } from './fixtures/test-server.js'

interface BrowserErrors {
  consoleErrors: string[]
  pageErrors: string[]
}

function collectBrowserErrors(page: Page): BrowserErrors {
  const errors: BrowserErrors = { consoleErrors: [], pageErrors: [] }
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => errors.pageErrors.push(error.message))
  return errors
}

async function expectVisibleBox(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
}

async function expectNoOverlap(first: Locator, second: Locator): Promise<void> {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()])
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  const overlaps = a!.x < b!.x + b!.width
    && a!.x + a!.width > b!.x
    && a!.y < b!.y + b!.height
    && a!.y + a!.height > b!.y
  expect(overlaps).toBe(false)
}

async function openConfirmation(page: Page, amount = '10'): Promise<void> {
  const amountInput = page.getByLabel('兑换金额')
  const fillButton = page.getByTestId('fill-balance')
  const generateButton = page.getByRole('button', { name: '生成兑换码', exact: true })
  await expectVisibleBox(amountInput)
  await expectVisibleBox(fillButton)
  await expectNoOverlap(amountInput, fillButton)
  await expectNoOverlap(page.locator('.amount-row'), generateButton)
  await amountInput.fill(amount)
  await generateButton.click()
  await expectVisibleBox(page.getByRole('dialog', { name: '确认兑换' }))
  await expectNoOverlap(page.locator('.confirmation-list'), page.locator('.dialog-actions'))
}

async function completeConversion(page: Page): Promise<void> {
  await openConfirmation(page)
  await page.getByTestId('confirm-conversion').click()
  await expect(page.getByText('生成完成')).toBeVisible()
  await expect(page.locator('.code-row code')).toHaveText('TEST-CODE-1')
  await expect(page.locator('.history-section')).toContainText('TEST-CODE-1')
  await expectNoOverlap(page.locator('.code-row'), page.locator('.history-section'))
}

function expectNoBrowserErrors(errors: BrowserErrors): void {
  expect(errors.pageErrors).toEqual([])
  expect(errors.consoleErrors).toEqual([])
}

test.describe('desktop conversion', () => {
  test('@desktop completes, copies, and persists a local history row', async ({ page, context, environment }, testInfo) => {
    const errors = collectBrowserErrors(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.origin })
    await page.goto(environment.authenticatedUrl())
    await expect(page.getByText('测试用户')).toBeVisible()

    await completeConversion(page)
    await page.getByRole('button', { name: '复制兑换码', exact: true }).first().click()
    await expect(page.getByText('已复制', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('TEST-CODE-1')

    await expectVisibleBox(page.locator('.conversion-panel'))
    await expectVisibleBox(page.locator('.result-panel'))
    await expectVisibleBox(page.locator('.history-section'))
    await expectNoOverlap(page.locator('.tool-grid'), page.locator('.history-section'))
    await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true })
    expectNoBrowserErrors(errors)
  })

  test('@desktop recovers a lost debit response with the same idempotency key', async ({ page, environment }, testInfo) => {
    const errors = collectBrowserErrors(page)
    environment.mock.setMode('timeout-after-success')
    await page.goto(environment.authenticatedUrl())

    await openConfirmation(page)
    await page.getByTestId('confirm-conversion').click()
    await expect(page.getByTestId('resume-pending')).toBeVisible()
    await expect(page.getByText('兑换结果待确认')).toBeVisible()
    await expect(page.getByText('TEST-CODE-1')).toHaveCount(0)
    expect(environment.mock.totalSuccessfulDebits()).toBe(1)

    await page.getByTestId('resume-pending').click()
    await expect(page.getByText('生成完成')).toBeVisible()
    await expect(page.locator('.code-row code')).toHaveText('TEST-CODE-1')
    expect(environment.mock.totalSuccessfulDebits()).toBe(1)
    await page.screenshot({ path: testInfo.outputPath('recovery.png'), fullPage: true })
    expectNoBrowserErrors(errors)
  })
})

test.describe('same-site iframe exchange', () => {
  test('@iframe exchanges the URL token, cleans sensitive parameters, and keeps the cookie usable', async ({ page, environment }, testInfo) => {
    const errors = collectBrowserErrors(page)
    await page.goto(environment.iframeParentUrl())
    const tool = page.frameLocator('#tool-frame')
    await expect(tool.getByText('测试用户')).toBeVisible()

    const frame = page.frames().find((candidate: Frame) => candidate !== page.mainFrame())
    expect(frame).toBeDefined()
    const cleaned = new URL(frame!.url())
    expect(cleaned.searchParams.has('token')).toBe(false)
    expect(cleaned.searchParams.has('user_id')).toBe(false)
    expect(cleaned.searchParams.get('theme')).toBe('dark')
    expect(cleaned.searchParams.get('ui_mode')).toBe('iframe')
    expect(cleaned.searchParams.get('lang')).toBe('zh-CN')

    const me = await frame!.evaluate(async () => {
      const response = await fetch('/api/me', { credentials: 'same-origin' })
      return { status: response.status, body: await response.json() }
    })
    expect(me).toMatchObject({ status: 200, body: { id: 7, username: '测试用户', balance: '100' } })
    await expectVisibleBox(tool.locator('.workspace'))
    await expectNoOverlap(tool.locator('.tool-grid'), tool.locator('.history-section'))
    await page.screenshot({ path: testInfo.outputPath('iframe.png'), fullPage: true })
    expectNoBrowserErrors(errors)
  })
})

test.describe('mobile conversion', () => {
  test('@mobile keeps confirmation, result, and history readable without horizontal overflow', async ({ page, environment }, testInfo) => {
    const errors = collectBrowserErrors(page)
    await page.goto(environment.authenticatedUrl())
    await openConfirmation(page)
    await expectVisibleBox(page.locator('.dialog-surface'))
    await page.getByTestId('confirm-conversion').click()
    await expect(page.locator('.code-row code')).toHaveText('TEST-CODE-1')
    await expectVisibleBox(page.locator('.history-mobile-list'))
    await expectNoOverlap(page.locator('.result-panel'), page.locator('.history-section'))

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }))
    expect(overflow.document).toBeLessThanOrEqual(0)
    expect(overflow.body).toBeLessThanOrEqual(0)
    await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true })
    expectNoBrowserErrors(errors)
  })
})
