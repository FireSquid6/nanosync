import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/*.pw.ts',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? '/home/firesquid/.nix-profile/bin/chromium',
      args: ['--no-sandbox'],
    },
  },
  webServer: { command: 'bun run start --port 3100', url: 'http://127.0.0.1:3100', reuseExistingServer: false },
});
