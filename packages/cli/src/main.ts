#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { daemonCommand, startDaemon } from "@nanosync/linux-daemon";
import { parseDeviceId } from "@nanosync/protocol";
import { api, bootstrap, credentials, joinVault, readPassword } from "./client.ts";
import { privateDirectory, secureCreate, secureRead } from "./security.ts";
import { runServer } from "./server.ts";

const HELP = `nanosync [--client-dir DIR] COMMAND [arguments]
  daemon --sync-dir DIR           Run the single-owner Linux sync daemon
  status [--json]                 Query local daemon
  sync | pause | resume           Control local daemon
  history [PATH]                  Authenticated revision history
  restore REVISION [PATH]         Restore a historical tree or file as a new revision
  resolve PATH --confirm-discard   Tombstone this named file conflict copy (history retains bytes)
  evict PATH | download PATH      Change local hydration without publishing
  conflicts | doctor             Inspect local daemon
  devices                         List devices (administrator)
  approve DEVICE_ID | revoke DEVICE_ID   Administrator actions
  bootstrap --url URL --proof-file FILE  First device (password from stdin, recovery to TTY)
  enroll --url URL --device-id UUID    Request enrollment (password from stdin)
  enroll --url URL --device-id UUID --recovery-file FILE  Finish approved enrollment
  server init --server-dir DIR    Create private pepper and bootstrap proof
  server run --server-dir DIR [--host HOST] [--port PORT] [--acknowledge-exposure]
  help
Secrets must never be passed as command-line values. See packages/cli/README.md.
`;
function options(args: string[], names: string[]): { flags: Record<string, string | boolean>; rest: string[] } {
  const flags: Record<string, string | boolean> = {}, rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { rest.push(arg); continue; }
    if (!names.includes(arg) || Object.hasOwn(flags, arg)) throw new Error(`unknown or duplicate flag: ${arg}`);
    if (["--json", "--acknowledge-exposure", "--confirm-discard"].includes(arg)) flags[arg] = true;
    else { const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`missing ${arg} value`); flags[arg] = value; }
  }
  return { flags, rest };
}
function required(value: string | boolean | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`required ${label}`); return value;
}
function count(rest: string[], min: number, max = min) { if (rest.length < min || rest.length > max) throw new Error("invalid command arguments; see nanosync help"); }
function output(value: unknown, json = false) { console.log(json || typeof value !== "string" ? JSON.stringify(value) : value); }
export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) { process.stdout.write(HELP); return 0; }
    const global = options(args, ["--client-dir", "--sync-dir", "--server-dir", "--url", "--proof-file", "--device-id", "--recovery-file", "--host", "--port", "--acknowledge-exposure", "--confirm-discard", "--json"]);
    const [command, ...rest] = global.rest, flags = global.flags;
    const directory = typeof flags["--client-dir"] === "string" ? flags["--client-dir"] : join(process.env.HOME ?? "", ".local/share/nanosync");
    const url = flags["--url"] as string | undefined;
    let result: unknown;
    switch (command) {
      case undefined: case "help": case "--help": count(rest, 0); process.stdout.write(HELP); return 0;
      case "server": {
        count(rest, 1);
        const root = required(flags["--server-dir"], "--server-dir");
        if (rest[0] === "init") {
          const dir = privateDirectory(root);
          secureCreate(join(dir, "pepper.hex"), randomBytes(32).toString("hex"));
          secureCreate(join(dir, "bootstrap.hex"), randomBytes(32).toString("hex"));
          result = { initialized: true, bootstrapProofFile: join(dir, "bootstrap.hex") }; break;
        }
        if (rest[0] !== "run") throw new Error("expected server init or server run");
        const port = flags["--port"] === undefined ? undefined : Number(flags["--port"]);
        const server = await runServer({ directory: root, host: flags["--host"] as string | undefined, port,
          acknowledgeExposure: flags["--acknowledge-exposure"] === true });
        console.error(`Server listening at ${server.url}`);
        await new Promise<void>(resolveStop => {
          process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop);
        });
        await server.stop(); return 0;
      }
      case "bootstrap": count(rest, 0); result = await bootstrap(directory, required(url, "--url"), required(flags["--proof-file"], "--proof-file")); break;
      case "enroll": {
        count(rest, 0);
        const server = required(url, "--url"), id = parseDeviceId(required(flags["--device-id"], "--device-id"));
        const recovery = flags["--recovery-file"] ? secureRead(required(flags["--recovery-file"], "--recovery-file"), 128).toString("utf8").trim() : undefined;
        result = await joinVault(directory, server, id, existsSync(join(directory, "enrollment.json")) ? undefined : readPassword(), recovery); break;
      }
      case "daemon": {
        count(rest, 0);
        const creds = credentials(directory);
        const daemon = await startDaemon({ clientDirectory: directory, syncDirectory: required(flags["--sync-dir"], "--sync-dir"),
          vaultId: creds.vaultId, deviceId: creds.deviceId, masterKey: Buffer.from(creds.masterKey, "hex"), baseUrl: creds.baseUrl, token: creds.token });
        console.error("Daemon started");
        await new Promise<void>(resolveStop => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
        await daemon.stop(); return 0;
      }
      case "status": case "sync": case "pause": case "resume": case "conflicts": case "doctor":
        count(rest, 0); result = await daemonCommand(directory, command); break;
      case "history": count(rest, 0, 1); result = await daemonCommand(directory, "history", rest[0] ? { path: rest[0] } : {}); break;
      case "restore": count(rest, 1, 2); result = await daemonCommand(directory, "restore", { revision: rest[0], ...(rest[1] === undefined ? {} : { path: rest[1] }) }); break;
      case "resolve": count(rest, 1); if (flags["--confirm-discard"] !== true) throw new Error("resolve requires --confirm-discard; the named conflict copy will be removed from the live tree (retained in history)"); result = await daemonCommand(directory, "resolve", { path: rest[0] }); break;
      case "devices": count(rest, 0); { const creds = credentials(directory); result = await api(creds.baseUrl, "/v1/admin/devices", {}, creds.token); break; }
      case "approve": case "revoke": {
        count(rest, 1); const id = parseDeviceId(rest[0]); const creds = credentials(directory);
        result = await api(creds.baseUrl, command === "approve" ? `/v1/admin/enrollments/${id}/approve` : `/v1/admin/devices/${id}/revoke`,
          { method: "POST", body: JSON.stringify({ protocolVersion: 1 }) }, creds.token); break;
      }
      case "evict": case "download": count(rest, 1); result = await daemonCommand(directory, command, { path: rest[0] }); break;
      default: throw new Error(`unknown command: ${command}; see nanosync help`);
    }
    output(result, flags["--json"] === true); return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "command failed";
    const code = /unauthorized|server 401|server 403/i.test(message) ? 3 : /pending|approval/i.test(message) ? 4 : /not available/i.test(message) ? 5 : 2;
    console.error(JSON.stringify({ error: message, exitCode: code }));
    return code;
  }
}
if (import.meta.main) process.exitCode = await main();
