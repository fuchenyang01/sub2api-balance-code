import {
  collectBrowserErrors,
  completeConversion,
  expectNoBrowserErrors,
  expectNoOverlap,
  expectVisibleBox,
  openConfirmation,
} from './fixtures/browser-assertions.js'
import { expect, test } from './fixtures/test-server.js'

test.describe('desktop conversion', () => {
  test('creates one three-code batch with one generate and one debit request', async ({
    page,
    context,
    environment,
  }) => {
    const errors = collectBrowserErrors(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: environment.origin,
    })
    await page.goto(environment.authenticatedUrl())
    await page.getByLabel('兑换金额').fill('10')
    await page.getByLabel('兑换数量').fill('3')
    await page.getByRole('button', { name: '生成兑换码', exact: true }).click()
    await expect(page.getByText('总扣款')).toBeVisible()
    await page.getByTestId('confirm-conversion').click()

    await expect(page.locator('.result-code-list .code-row')).toHaveCount(3)
    await expect(page.getByLabel('当前余额')).toContainText('70')
    expect(environment.mock.totalGenerateRequests()).toBe(1)
    expect(environment.mock.totalDebitRequests()).toBe(1)
    expect(environment.mock.totalSuccessfulDebits()).toBe(1)

    await page.getByTestId('copy-result-all').click()
    await expect.poll(() => page.evaluate(async () => (
      await navigator.clipboard.readText()
    ).replaceAll('\r\n', '\n')))
      .toBe('TEST-CODE-1\nTEST-CODE-2\nTEST-CODE-3')
    await expect(page.locator('.history-table tbody tr')).toHaveCount(3)
    expectNoBrowserErrors(errors)
  })

  test('completes, copies, and persists a local history row', async ({ page, context, environment }, testInfo) => {
    const errors = collectBrowserErrors(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.origin })
    await page.goto(environment.authenticatedUrl())
    await expect(page.getByText('测试用户')).toBeVisible()

    await completeConversion(page)
    await expect(page.getByLabel('当前余额')).toContainText('90')
    await page.getByLabel('复制兑换码 TEST-CODE-1').first().click()
    await expect(page.getByText('已复制', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('TEST-CODE-1')

    await expectVisibleBox(page.locator('.conversion-panel'))
    await expectVisibleBox(page.locator('.result-panel'))
    await expectVisibleBox(page.locator('.history-section'))
    await expectNoOverlap(page.locator('.tool-grid'), page.locator('.history-section'))
    await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true })
    expectNoBrowserErrors(errors)
  })

  test('recovers a lost debit response with the same idempotency key', async ({ page, environment }, testInfo) => {
    const errors = collectBrowserErrors(page)
    environment.mock.setMode('timeout-after-success')
    await page.goto(environment.authenticatedUrl())

    await openConfirmation(page, '60')
    await page.getByTestId('confirm-conversion').click()
    await expect(page.getByTestId('resume-pending')).toBeVisible()
    await expect(page.getByText('兑换结果待确认')).toBeVisible()
    await expect(page.getByText('TEST-CODE-1')).toHaveCount(0)
    expect(environment.mock.totalSuccessfulDebits()).toBe(1)

    await page.getByTestId('resume-pending').click()
    await expect(page.getByText('生成完成')).toBeVisible()
    await expect(page.locator('.result-code-list .code-row code')).toHaveText('TEST-CODE-1')
    await expect(page.getByTestId('resume-pending')).toHaveCount(0)
    await expect(page.locator('.history-section')).toContainText('TEST-CODE-1')
    expect(environment.mock.totalSuccessfulDebits()).toBe(1)
    await page.screenshot({ path: testInfo.outputPath('recovery.png'), fullPage: true })
    expectNoBrowserErrors(errors)
  })

  test('keeps a generic debit 500 pending without deleting or exposing the code', async ({ page, environment }) => {
    const errors = collectBrowserErrors(page)
    environment.mock.setMode('insufficient')
    await page.goto(environment.authenticatedUrl())

    await openConfirmation(page)
    await page.getByTestId('confirm-conversion').click()

    await expect(page.getByTestId('resume-pending')).toBeVisible()
    await expect(page.getByText('兑换结果待确认')).toBeVisible()
    await expect(page.getByText('TEST-CODE-1')).toHaveCount(0)
    expect(environment.mock.totalSuccessfulDebits()).toBe(0)
    expect(environment.mock.totalDeletedCodes()).toBe(0)
    expectNoBrowserErrors(errors)
  })
})
