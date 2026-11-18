import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Nanosync Spike",
    identifier: "org.nanosync.validation",
    version: "0.0.0",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/main.ts" },
    views: { main: { entrypoint: "src/view.ts" } },
    copy: {
      "src/index.html": "views/main/index.html",
      "src/tray.svg": "views/main/tray.svg",
    },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
