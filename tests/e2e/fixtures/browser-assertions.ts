import type { ConsoleMessage, Locator, Page } from '@playwright/test'

import { expect } from './test-server.js'

export interface BrowserErrors {
  consoleErrors: BrowserConsoleError[]
  pageErrors: string[]
  responses: BrowserResponse[]
  ignoreExpectedAuthorization403: boolean
}

export interface BrowserConsoleError {
  text: string
  url: string
}

export interface BrowserResponse {
  method: string
  url: string
  status: number
}

export interface CollectBrowserErrorsOptions {
  ignoreExpectedAuthorization403?: boolean
}

interface UnexpectedBrowserErrors {
  consoleErrors: BrowserConsoleError[]
  pageErrors: string[]
}

const CHROMIUM_FORBIDDEN_RESOURCE_ERROR = 'Failed to load resource: the server responded with a status of 403 (Forbidden)'

function isExpectedAuthorizationResponse(response: BrowserResponse): boolean {
  if (response.status !== 403) return false
  const path = new URL(response.url).pathname
  return (response.method === 'POST' && path === '/api/session/exchange')
    || (response.method === 'GET' && path === '/api/me')
}

export function unexpectedBrowserErrors(errors: BrowserErrors): UnexpectedBrowserErrors {
  if (!errors.ignoreExpectedAuthorization403) {
    return { consoleErrors: errors.consoleErrors, pageErrors: errors.pageErrors }
  }

  const expectedResponses = new Map<string, number>()
  for (const response of errors.responses) {
    if (!isExpectedAuthorizationResponse(response)) continue
    expectedResponses.set(response.url, (expectedResponses.get(response.url) ?? 0) + 1)
  }
  const consoleErrors = errors.consoleErrors.filter((error) => {
    if (error.text !== CHROMIUM_FORBIDDEN_RESOURCE_ERROR) return true
    const available = expectedResponses.get(error.url) ?? 0
    if (available === 0) return true
    expectedResponses.set(error.url, available - 1)
    return false
  })
  return { consoleErrors, pageErrors: errors.pageErrors }
}

export function collectBrowserErrors(
  page: Page,
  options: CollectBrowserErrorsOptions = {},
): BrowserErrors {
  const errors: BrowserErrors = {
    consoleErrors: [],
    pageErrors: [],
    responses: [],
    ignoreExpectedAuthorization403: options.ignoreExpectedAuthorization403 ?? false,
  }
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      errors.consoleErrors.push({ text: message.text(), url: message.location().url })
    }
  })
  page.on('pageerror', (error) => errors.pageErrors.push(error.message))
  page.on('response', (response) => {
    errors.responses.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    })
  })
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
  const unexpected = unexpectedBrowserErrors(errors)
  expect(unexpected.pageErrors).toEqual([])
  expect(unexpected.consoleErrors).toEqual([])
}
