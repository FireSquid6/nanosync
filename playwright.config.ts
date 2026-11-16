import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "**/*.pw.ts",
  workers: 1,
  use: {
    browserName: "chromium",
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ??
        "/home/firesquid/.nix-profile/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
});
