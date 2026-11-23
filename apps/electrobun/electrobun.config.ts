import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "nanosync",
    identifier: "dev.nanosync.mock",
    version: "0.0.1",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/live.ts",
      },
    },
    copy: {
      "src/mainview/live.html": "views/mainview/live.html",
      "src/mainview/index.css": "views/mainview/index.css",
    },
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
