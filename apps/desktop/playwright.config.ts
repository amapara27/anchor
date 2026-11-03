import { defineConfig } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  outputDir: process.env.ANCHOR_E2E_ARTIFACT_DIR ? path.join(process.env.ANCHOR_E2E_ARTIFACT_DIR, 'browser') : 'test-results',
  testDir: './e2e', fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:1420', viewport: {width: 1000, height: 700}, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {command: 'pnpm dev --host 127.0.0.1', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI},
  reporter: [['list'], ['json', {outputFile: process.env.ANCHOR_E2E_ARTIFACT_DIR ? path.join(process.env.ANCHOR_E2E_ARTIFACT_DIR, 'browser-results.json') : 'test-results/results.json'}]],
});
