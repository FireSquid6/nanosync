import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.pw.ts',
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3101',
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? '/home/firesquid/.nix-profile/bin/chromium',
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: 'bun test-server.ts',
    url: 'http://127.0.0.1:3101',
    reuseExistingServer: false,
  },
});
