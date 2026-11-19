import type { ElectrobunConfig } from "electrobun";
import { realpathSync } from "node:fs";
import { sdkAliases, sdkDefines } from "../../build/desktop/security";

const fixture = process.env.NANOSYNC_DESKTOP_SECURITY_FIXTURE === "1";
const alias = sdkAliases();
const xdgOpen = realpathSync(process.env.NANOSYNC_XDG_OPEN ?? Bun.which("xdg-open") ?? "");
if (!xdgOpen.startsWith("/nix/store/")) throw Error("Build requires trusted Nix xdg-open; use nix develop");

export default {
  app: {
    name: fixture ? "Nanosync SDK Security" : "Nanosync Spike",
    identifier: fixture ? "org.nanosync.sdk-security" : "org.nanosync.validation",
    version: "0.0.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: fixture ? "tests/native/bootstrap.ts" : "src/bootstrap.ts", alias,
      define: { ...sdkDefines(), NANOSYNC_XDG_OPEN: JSON.stringify(xdgOpen) },
    },
    views: { main: { entrypoint: fixture ? "tests/native/view.ts" : "src/view.ts", alias } },
    copy: {
      [fixture ? "tests/native/index.html" : "src/index.html"]: "views/main/index.html",
      "src/tray.svg": "views/main/tray.svg",
      ...(fixture ? {
        "tests/native/failure.html": "views/main/failure.html",
        "tests/native/transport.html": "views/main/transport.html",
      } : {}),
    },
  },
  scripts: {
    preBuild: "../../build/desktop/pre-build.ts",
    postBuild: "../../build/desktop/post-build.ts",
    postPackage: "../../build/desktop/post-package.ts",
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
