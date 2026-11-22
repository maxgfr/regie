import { defineConfig, devices } from '@playwright/test'

/** `E2E_PORT` serves the build elsewhere when another app already listens on 4173 (its pages would be tested). */
const port = Number(process.env.E2E_PORT ?? 4173)

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${port}`, viewport: { width: 1440, height: 900 }, locale: 'en-US' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: { command: `PORT=${port} bun scripts/serve.ts`, port, reuseExistingServer: !process.env.CI },
})
