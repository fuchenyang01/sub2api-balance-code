import {
  collectBrowserErrors,
  expectNoBrowserErrors,
  expectNoOverlap,
  expectVisibleBox,
  openConfirmation,
} from './fixtures/browser-assertions.js'
import { expect, test } from './fixtures/test-server.js'

test('keeps confirmation, result, and history readable without horizontal overflow', async ({ page, environment }, testInfo) => {
  const errors = collectBrowserErrors(page)
  await page.goto(environment.authenticatedUrl())
  await openConfirmation(page)
  await expectVisibleBox(page.locator('.dialog-surface'))
  await page.getByTestId('confirm-conversion').click()
  await expect(page.locator('.result-code-list .code-row code')).toHaveText('TEST-CODE-1')
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
