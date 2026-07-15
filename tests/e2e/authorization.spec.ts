import {
  collectBrowserErrors,
  expectNoBrowserErrors,
} from './fixtures/browser-assertions.js'
import { expect, test } from './fixtures/test-server.js'

test.describe('redemption group authorization', () => {
  test('allows a denied first visit after group membership is granted', async ({ page, environment }) => {
    environment.mock.setAllowedGroups([])

    await page.goto(environment.authenticatedUrl())

    await expect(page.getByRole('heading', { name: '暂无余额兑换权限' })).toBeVisible()
    await expect(page.getByLabel('兑换金额')).toHaveCount(0)
    expect(environment.mock.totalGenerateRequests()).toBe(0)
    expect(environment.mock.totalDebitRequests()).toBe(0)

    const errors = collectBrowserErrors(page)
    environment.mock.setAllowedGroups([24])
    await page.getByTestId('retry-access').click()

    await expect(page.getByText('测试用户')).toBeVisible()
    await expect(page.getByLabel('兑换金额')).toBeVisible()
    expectNoBrowserErrors(errors)
  })

  test('removes and restores access when group membership changes during a session', async ({
    page,
    environment,
  }) => {
    await page.goto(environment.authenticatedUrl())
    await expect(page.getByText('测试用户')).toBeVisible()

    environment.mock.setAllowedGroups([])
    await page.getByLabel('刷新账户信息').click()

    await expect(page.getByRole('heading', { name: '暂无余额兑换权限' })).toBeVisible()
    await expect(page.getByLabel('兑换金额')).toHaveCount(0)
    expect(environment.mock.totalGenerateRequests()).toBe(0)
    expect(environment.mock.totalDebitRequests()).toBe(0)

    const errors = collectBrowserErrors(page)
    environment.mock.setAllowedGroups([24])
    await page.getByTestId('retry-access').click()

    await expect(page.getByText('测试用户')).toBeVisible()
    await expect(page.getByLabel('兑换金额')).toBeVisible()
    expectNoBrowserErrors(errors)
  })
})
