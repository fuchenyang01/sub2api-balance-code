import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
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
      grep: /@desktop/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1_280, height: 800 } },
    },
    {
      name: 'iframe',
      grep: /@iframe/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1_280, height: 800 } },
    },
    {
      name: 'mobile',
      grep: /@mobile/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
})
