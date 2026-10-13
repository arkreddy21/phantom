import { randomUUID } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

// Each invocation gets a new database, so the fresh-history assertions are true
// and no developer data can be read or changed by the browser suite.
const dataDir = `/tmp/opencode/persona-e2e-${randomUUID()}`;
const vitePort = Number(process.env.E2E_VITE_PORT || 5174);
const apiPort = Number(process.env.E2E_API_PORT || 3002);
const production = process.env.E2E_PRODUCTION === '1';
const command = process.env.E2E_COMMAND || (production
  ? 'node dist/server/server/index.js --production'
  : `pnpm exec concurrently -k -n server,client "pnpm exec tsx watch server/index.ts" "pnpm exec vite --host 127.0.0.1 --port ${vitePort} --strictPort"`);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${vitePort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command,
    url: `http://127.0.0.1:${vitePort}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      AUTH_USERNAME: process.env.AUTH_USERNAME || 'phantom-e2e',
      AUTH_PASSWORD: process.env.AUTH_PASSWORD || 'phantom-e2e-password',
      PORT: String(production ? vitePort : apiPort),
      HOST: '127.0.0.1',
      PUBLIC_ORIGIN: `http://127.0.0.1:${vitePort}`,
    },
  },
});
