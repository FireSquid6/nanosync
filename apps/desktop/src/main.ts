import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/main";
import type { SpikeRPC } from "./rpc";
import { checkLocalDatabase } from "./selfcheck";
import { openCheckedFolder } from "./open-native";

console.log("SQLite PASS", checkLocalDatabase(), "Bun", Bun.version);
console.log("Credential-store validation is explicit; no keyring accessed at startup");

const directory = mkdtempSync(join(tmpdir(), "nanosync-desktop-open-"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const rpc = BrowserView.defineRPC<SpikeRPC>({
  handlers: {
    requests: {
      action: async (action) => {
        switch (action) {
          case "hide":
            window.requestClose();
            return "Close requested";
          case "picker": {
            const paths = await Utils.openFileDialog({
              startingFolder: directory,
              canChooseFiles: false,
              canChooseDirectory: true,
              allowsMultipleSelection: false,
            });
            console.log("Picker returned", paths.length, "selection(s); paths not logged");
            return `Picker returned ${paths.length} selection(s)`;
          }
          case "open":
            assert.ok((await openCheckedFolder(directory)).ok, "system file manager could not open disposable folder");
            console.log("Trusted argv opener accepted disposable directory");
            return "Opened disposable folder";
          case "quit":
            console.log("Explicit Quit");
            tray.remove();
            rmSync(directory, { recursive: true, force: true });
            Utils.quit();
            return "Quit requested";
          default:
            throw new Error("Unknown spike action");
        }
      },
    },
  },
});
const window = new BrowserWindow({
  title: "Nanosync Linux validation spike",
  url: "about:blank",
  frame: { width: 580, height: 400, x: 120, y: 120 },
  rpc,
  allowedProtocols: { views: true, appData: false },
  navigationRules: JSON.stringify(["^*", "views://main/index.html"]),
});
window.webview.setNavigationRules(["^*", "views://main/index.html"]);
window.webview.loadURL("views://main/index.html");
window.on("will-close", (event: unknown) => {
  (event as { response: { allow: boolean } }).response = { allow: false };
  window.hide();
  assert.equal(window.isVisible(), false);
  console.log("Close intercepted; hidden, process remains alive");
});
const tray = new Tray({
  title: "Nanosync validation — no sync running",
  image: "views://main/tray.svg",
  template: false,
});
tray.setMenu([{ type: "normal", label: "Open Nanosync", action: "open" }]);
tray.on("tray-clicked", (event: unknown) => {
  const { action } = (event as { data: { action: string } }).data;
  if (action === "open" || action === "") {
    window.show();
    window.activate();
    assert.equal(window.isVisible(), true);
    console.log("Tray reopened window");
  }
});
console.log("Native window created; tray visible:", tray.visible);
