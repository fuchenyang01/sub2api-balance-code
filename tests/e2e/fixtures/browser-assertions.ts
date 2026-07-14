import type { ConsoleMessage, Locator, Page } from '@playwright/test'

import { expect } from './test-server.js'

export interface BrowserErrors {
  consoleErrors: string[]
  pageErrors: string[]
}

export function collectBrowserErrors(page: Page): BrowserErrors {
  const errors: BrowserErrors = { consoleErrors: [], pageErrors: [] }
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => errors.pageErrors.push(error.message))
  return errors
}

export async function expectVisibleBox(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
}

export async function expectNoOverlap(first: Locator, second: Locator): Promise<void> {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()])
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  const overlaps = a!.x < b!.x + b!.width
    && a!.x + a!.width > b!.x
    && a!.y < b!.y + b!.height
    && a!.y + a!.height > b!.y
  expect(overlaps).toBe(false)
}

export async function openConfirmation(page: Page, amount = '10'): Promise<void> {
  const amountInput = page.getByLabel('兑换金额')
  const fillButton = page.getByTestId('fill-balance')
  const generateButton = page.getByRole('button', { name: '生成兑换码', exact: true })
  await expectVisibleBox(amountInput)
  await expectVisibleBox(fillButton)
  await expectNoOverlap(amountInput, fillButton)
  await expectNoOverlap(page.locator('.conversion-summary'), generateButton)
  await amountInput.fill(amount)
  await generateButton.click()
  await expectVisibleBox(page.getByRole('dialog', { name: '确认兑换' }))
  await expectNoOverlap(page.locator('.confirmation-list'), page.locator('.dialog-actions'))
}

export async function completeConversion(page: Page): Promise<void> {
  await openConfirmation(page)
  await page.getByTestId('confirm-conversion').click()
  await expect(page.getByText('生成完成')).toBeVisible()
  await expect(page.locator('.result-code-list .code-row code')).toHaveText('TEST-CODE-1')
  await expect(page.locator('.history-section')).toContainText('TEST-CODE-1')
  await expectNoOverlap(page.locator('.result-code-list'), page.locator('.history-section'))
}

export function expectNoBrowserErrors(errors: BrowserErrors): void {
  expect(errors.pageErrors).toEqual([])
  expect(errors.consoleErrors).toEqual([])
}
