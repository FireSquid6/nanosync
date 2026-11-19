import type { ElectrobunConfig } from "electrobun";
import { realpathSync } from "node:fs";
import { sdkAliases, sdkDefines } from "../../build/desktop/security";

const lifecycleFixture = process.env.NANOSYNC_DESKTOP_LIFECYCLE_FIXTURE === "1";
const fixture = process.env.NANOSYNC_DESKTOP_SECURITY_FIXTURE === "1";
const alias = sdkAliases();
const xdgOpen = realpathSync(process.env.NANOSYNC_XDG_OPEN ?? Bun.which("xdg-open") ?? "");
if (!xdgOpen.startsWith("/nix/store/")) throw Error("Build requires trusted Nix xdg-open; use nix develop");
const systemdLibrary = realpathSync(process.env.NANOSYNC_LIBSYSTEMD ?? "");
if (!systemdLibrary.startsWith("/nix/store/")) throw Error("Build requires project Nix libsystemd; use nix develop");
const gdbus = realpathSync(Bun.which('gdbus') ?? '');
const systemctl = realpathSync(Bun.which('systemctl') ?? '');
if (![gdbus, systemctl].every(path => path.startsWith('/nix/store/'))) throw Error('Build requires project Nix session tools; use nix develop');

const notifyPython = realpathSync(process.env.NANOSYNC_NOTIFY_PYTHON ?? '');
const notifyTypelibs = process.env.NANOSYNC_NOTIFY_TYPELIB ?? '';
if (!notifyPython.startsWith('/nix/store/') || !notifyTypelibs || !notifyTypelibs.split(':').every(path => path.startsWith('/nix/store/')))
  throw Error('Build requires project Nix libnotify/PyGObject; use nix develop');

export default {
  app: {
    name: lifecycleFixture ? "Nanosync Lifecycle Fixture" : fixture ? "Nanosync SDK Security" : "Nanosync Spike",
    identifier: fixture ? "org.nanosync.sdk-security" : "org.nanosync.validation",
    version: "0.0.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: lifecycleFixture ? "tests/native/lifecycle-bootstrap.ts" : fixture ? "tests/native/bootstrap.ts" : "src/bootstrap.ts", alias,
      define: { ...sdkDefines(), NANOSYNC_NOTIFY_PYTHON: JSON.stringify(notifyPython), NANOSYNC_NOTIFY_TYPELIB: JSON.stringify(notifyTypelibs), NANOSYNC_XDG_OPEN: JSON.stringify(xdgOpen), NANOSYNC_LIBSYSTEMD: JSON.stringify(systemdLibrary), NANOSYNC_GDBUS: JSON.stringify(gdbus), NANOSYNC_SYSTEMCTL: JSON.stringify(systemctl) },
    },
    views: { main: { entrypoint: fixture ? "tests/native/view.ts" : "src/view.ts", alias } },
    copy: {
      [fixture ? "tests/native/index.html" : "src/index.html"]: "views/main/index.html",
      "src/tray.svg": "views/main/tray.svg",
      "src/tray-attention.svg": "views/main/tray-attention.svg",
      "../../packages/admin-ui/PAPER-UI-NOTICE.md": "views/main/PAPER-UI-NOTICE.md",
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
