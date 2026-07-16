import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      testMatch: ['**/conversion.spec.ts', '**/authorization.spec.ts'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1_280, height: 800 } },
    },
    {
      name: 'iframe',
      testMatch: '**/iframe.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1_280, height: 800 } },
    },
    {
      name: 'mobile',
      testMatch: '**/mobile.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
})
