#!/usr/bin/env bun
import { join } from "node:path";
import { existsSync } from "node:fs";
import { isatty } from "node:tty";
import { openSync, closeSync, writeSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { parseDeviceId } from "@nanosync/protocol";
import { RemoteError } from "@nanosync/sync-core";
import { api, bootstrap, credentials, joinVault, readPassword } from "./client.ts";
import { privateDirectory, secureCreate, secureRead, provisionSecret } from "./security.ts";
import { runServer, initializeServerOwner, approveLocalDevice, revokeLocalDevice, localDevices, localAdminReport } from "./server.ts";
import { SyncRunner } from "./sync-runner.ts";
import { createConnection, discoverConnection, repairConnection } from "./connections.ts";
import { createVault, enrollServer, key, prompt, secretPrompt, server as selectServer, servers, unlockVault } from "./vault-client.ts";

type CliOptions = { clientDir?: string; syncDir?: string; continuous?: boolean; serverDir?: string; url?: string; proofFile?: string;
  deviceId?: string; recoveryFile?: string; host?: string; port?: string; acknowledgeExposure?: boolean;
  json?: boolean; env?: boolean; name?: string; server?: string; vault?: string; path?: string; watch?: boolean;
  confirmNonempty?: boolean; repair?: string; recoveryOutput?: string; waitMs?: string };
function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`required ${label}`);
  return value;
}
function output(value: unknown, json = false) { console.log(json || typeof value !== "string" ? JSON.stringify(value) : value); }

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const program = new Command().name("nanosync")
      .description("Nanosync Linux CLI. Secrets must never be passed as command-line values. See packages/cli/README.md.")
      .showHelpAfterError(false).exitOverride()
      .configureOutput({ writeErr: () => {} });
    const seen = new Set<string>();
    function flags(command: Command, ...definitions: string[]): Command {
      for (const definition of definitions) {
        const option = new Option(definition);
        if (command === program && !["--client-dir", "--json"].includes(option.long!)) {
          option.hideHelp();
        }
        if (option.required) {
          option.argParser(value => {
            if (!value) throw new Error(`missing ${option.long} value`);
            return value;
          });
        }
        command.addOption(option);
        command.on(`option:${option.name()}`, () => {
          if (seen.has(option.long!)) {
            throw new Error(`unknown or duplicate flag: ${option.long}`);
          }
          seen.add(option.long!);
        });
      }
      return command;
    }
    const common = ["--client-dir <dir>", "--json"];
    flags(program, ...common, "--sync-dir <dir>", "--continuous", "--server-dir <dir>", "--url <url>", "--proof-file <file>",
      "--device-id <uuid>", "--recovery-file <file>", "--host <host>", "--port <port>",
      "--acknowledge-exposure", "--env", "--name <name>", "--vault <name-or-uuid>", "--server <name-or-id>",
       "--path <directory>", "--watch", "--confirm-nonempty", "--repair <move-or-copy>", "--recovery-output <file>", "--wait-ms <milliseconds>");
    const opts = (command: Command): CliOptions => command.optsWithGlobals<CliOptions>();
    const directory = (command: Command) => opts(command).clientDir ?? join(process.env.HOME ?? "", ".nanosync");
    const serverDirectory = (command: Command) => opts(command).serverDir ?? join(privateDirectory(directory(command)), "server");
    let result: unknown, code = 0;
    const server = flags(
      program.command("server").description("Server provisioning and runtime"),
      "--server-dir <dir>", "--host <host>", "--port <port>", "--acknowledge-exposure", ...common);
    flags(
       server.command("init").description("Initialize owner password without creating a vault"),
       "--server-dir <dir>", "--env",
       ...common,
     )
       .action(async (_options: CliOptions, command: Command) => {
         const dir = privateDirectory(serverDirectory(command));
         const password = opts(command).env ? required(process.env.NANOSYNC_PASSWORD, "NANOSYNC_PASSWORD") : await secretPrompt("Enter owner password");
         if (!opts(command).env && password !== await secretPrompt("Confirm owner password")) throw new Error("password confirmation does not match");
         provisionSecret(join(dir, "pepper.hex"));
         provisionSecret(join(dir, "bootstrap.hex"));
         await initializeServerOwner(dir, password);
         result = { initialized: true };
      });
    flags(
      server.command("run").description("Run server until SIGINT or SIGTERM"),
      "--server-dir <dir>", "--host <host>", "--port <port>", "--acknowledge-exposure", ...common,
    )
      .action(async (_options: CliOptions, command: Command) => {
        const config = opts(command);
        const running = await runServer({
           directory: serverDirectory(command),
          host: config.host,
          port: config.port === undefined ? undefined : Number(config.port),
          acknowledgeExposure: config.acknowledgeExposure === true,
        });
        console.error(`Server listening at ${running.url}`);
        await new Promise<void>(resolveStop => {
          process.once("SIGINT", resolveStop);
          process.once("SIGTERM", resolveStop);
        });
        await running.stop();
      });
    flags(
      program.command("bootstrap").description("Initialize first device (password on stdin, recovery on TTY)"),
      "--url <url>", "--proof-file <file>", ...common,
    )
      .action(async (_options: CliOptions, command: Command) => {
        const config = opts(command);
        result = await bootstrap(directory(command), required(config.url, "--url"), required(config.proofFile, "--proof-file"));
      });
    flags(
       program.command("enroll").description("Enroll a named device; resume a pending request on retry"),
       "--url <url>", "--device-id <uuid>", "--recovery-file <file>", "--name <name>", "--env", "--wait-ms <milliseconds>", ...common,
    )
      .action(async (_options: CliOptions, command: Command) => {
        const config = opts(command), dir = directory(command);
         if (config.deviceId) {
           const url = required(config.url, "--url"), id = parseDeviceId(config.deviceId);
           const recovery = config.recoveryFile ? secureRead(config.recoveryFile, 128).toString("utf8").trim() : undefined;
           result = await joinVault(dir, url, id, existsSync(join(dir, "enrollment.json")) ? undefined : readPassword(), recovery);
         } else {
           const url = config.env ? required(process.env.NANOSYNC_SERVER, "NANOSYNC_SERVER") : config.url ?? await prompt("Enter remote server");
           const password = existsSync(join(dir, "enrollment.json")) ? undefined : config.env ? required(process.env.NANOSYNC_PASSWORD, "NANOSYNC_PASSWORD") : await secretPrompt("Enter password");
           const name = config.env ? required(process.env.NANOSYNC_DEVICE_NAME, "NANOSYNC_DEVICE_NAME") : config.name ?? await prompt("Enter device name");
           const wait = config.waitMs === undefined ? 60_000 : Number(config.waitMs);
           if (!Number.isSafeInteger(wait) || wait < 0 || wait > 600_000) throw new Error("--wait-ms must be 0..600000");
           result = await enrollServer(dir, url, password, name, wait);
           if ((result as { status: string }).status === "approved") console.error("Approval received! Run `nanosync setup` to start syncing with vaults");
         }
         if ((result as { status?: string }).status === "pending") code = 3;
       });
    const vault = flags(program.command("vault").description("Manage encrypted vaults"), ...common);
    flags(vault.command("list"), "--server <name-or-id>", ...common).action(async (_options: CliOptions, command: Command) => {
      const info = selectServer(directory(command), opts(command).server);
      result = await api(info.baseUrl, "/v1/vaults", {}, info.token);
    });
    flags(vault.command("create"), "--server <name-or-id>", "--name <name>", "--recovery-output <file>", ...common)
      .action(async (_options: CliOptions, command: Command) => {
        const config = opts(command), root = directory(command), info = selectServer(root, config.server);
        if (!config.recoveryOutput) {
          let fd: number;
          try { fd = openSync("/dev/tty", "r+"); }
          catch { throw new Error("vault creation requires a terminal or --recovery-output"); }
          try { if (!isatty(fd)) throw new Error("vault creation requires a terminal or --recovery-output"); }
          finally { closeSync(fd); }
        }
        const name = config.name ?? await prompt("Enter vault name");
        result = await createVault(root, info, name, async secret => {
          if (config.recoveryOutput) {
            if (existsSync(config.recoveryOutput)) {
              if (secureRead(config.recoveryOutput, 256).toString("utf8") !== secret + "\n") throw new Error("recovery output differs from pending vault creation");
            } else secureCreate(config.recoveryOutput, secret + "\n");
          }
          else {
            const fd = openSync("/dev/tty", "r+");
            try {
              if (!isatty(fd)) throw new Error("recovery display requires a terminal or --recovery-output");
              writeSync(fd, `Recovery secret (record offline; shown once): ${secret}\n`);
            } finally { closeSync(fd); }
            if (await secretPrompt("Confirm recovery secret") !== secret) throw new Error("recovery confirmation failed");
          }
        });
      });
    flags(vault.command("rename").argument("<vault>"), "--server <name-or-id>", "--name <name>", ...common)
      .action(async (chosen: string, _options: CliOptions, command: Command) => {
        const info = selectServer(directory(command), opts(command).server);
        const list = await api(info.baseUrl, "/v1/vaults", {}, info.token);
        const matches = list.vaults.filter((entry: {name:string;vaultId:string}) => entry.vaultId === chosen || entry.name === chosen);
        if (matches.length !== 1) throw new Error("vault not found or ambiguous");
        result = await api(info.baseUrl, `/v1/vaults/${matches[0].vaultId}/rename`, { method: "POST",
          body: JSON.stringify({ name: required(opts(command).name, "--name") }) }, info.token);
      });
    flags(program.command("setup").description("Connect a directory to an existing vault"), "--server <name-or-id>", "--vault <name-or-uuid>",
      "--path <directory>", "--confirm-nonempty", "--repair <move-or-copy>", "--env", ...common)
      .action(async (_options: CliOptions, command: Command) => {
        const config = opts(command), root = directory(command);
        const choices = servers(root);
        const chosen = config.server ?? (choices.length === 1 ? choices[0]!.serverId : config.env ? undefined :
          (console.error(choices.map((item,i) => `${i+1}. ${item.name}: ${item.baseUrl}`).join("\n")),
            choices[Number(await prompt("Select server (enter number)"))-1]?.serverId));
        const info = selectServer(root, required(chosen, "--server"));
        const path = config.path ?? (config.env ? undefined : await prompt("Enter sync destination"));
        const destination = required(path, "--path");
        if (config.repair) {
          if (config.repair !== "move" && config.repair !== "copy") throw new Error("--repair must be move or copy");
          result = repairConnection(root, destination, config.repair, config.confirmNonempty);
        } else {
          const list = (await api(info.baseUrl, "/v1/vaults", {}, info.token)).vaults as {vaultId:string;name:string}[];
          if (!list.length) throw new Error("No vaults exist; run `nanosync vault create`");
          const choice = config.vault ?? (config.env ? undefined : (console.error(list.map((item,i) => `${i+1}. ${item.name}`).join("\n")),
            list[Number(await prompt("Select vault (enter number)"))-1]?.vaultId));
          const matches = list.filter(item => item.vaultId === choice || item.name === choice);
          if (matches.length !== 1) throw new Error("select a vault by name or UUID");
          const vaultId = matches[0]!.vaultId;
          if (!key(root, info.serverId, vaultId)) {
            const secret = config.env ? required(process.env.NANOSYNC_RECOVERY_SECRET, "NANOSYNC_RECOVERY_SECRET") : await secretPrompt(`Enter recovery secret for ${matches[0]!.name}`);
            await unlockVault(root, info, vaultId, secret);
          }
          result = createConnection(root, destination, info.serverId, vaultId, info.deviceId, config.confirmNonempty);
        }
        console.error("Setup complete! Run `nanosync sync` to continue syncing!");
      });
    flags(
      program.command("sync").description("Synchronize once or continuously; reads local .nanosyncignore in --sync-dir"),
       "--sync-dir <dir>", "--continuous", "--path <directory>", "--watch", ...common,
    ).action(async (_options: CliOptions, command: Command) => {
       const dir = directory(command);
       const config = opts(command);
       const connection = config.syncDir ? null : discoverConnection(dir, config.path ?? process.cwd());
       const info = connection ? selectServer(dir, connection.serverId) : null;
       if (connection && info!.deviceId !== connection.deviceId) throw new Error("connection device differs from server registration; run setup to repair");
       const syncDirectory = connection?.root ?? required(config.syncDir, "--path");
       const creds = connection ? null : credentials(dir);
       const masterKey = connection ? key(dir, info!.serverId, connection.vaultId) : Buffer.from(creds!.masterKey, "hex");
       if (!masterKey) throw new Error("vault key is missing; run nanosync setup to unlock it");
       let runner: SyncRunner;
       try {
         runner = SyncRunner.start({
           clientDirectory: connection ? privateDirectory(join(privateDirectory(join(privateDirectory(dir), "replicas")), connection.connectionId)) : dir,
           syncDirectory,
           vaultId: connection?.vaultId ?? creds!.vaultId,
           deviceId: connection?.deviceId ?? creds!.deviceId,
           masterKey,
           baseUrl: info?.baseUrl ?? creds!.baseUrl,
           token: info?.token ?? creds!.token,
        });
      } finally {
        masterKey.fill(0);
      }
      try {
         if (!opts(command).continuous && !opts(command).watch) {
          result = await runner.syncOnce();
        } else {
          const controller = new AbortController();
          const stop = () => controller.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          try {
            await runner.watch(controller.signal, head => output(head, true), error => {
              console.error(JSON.stringify({ error: error instanceof Error ? error.message : "sync failed" }));
            });
          } finally {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
          }
        }
      } finally {
        await runner.stop();
      }
    });
    flags(program.command("devices").description("List devices (administrator)"), "--server-dir <dir>", ...common)
       .action(async (_options: CliOptions, command: Command) => {
         if (opts(command).serverDir) { result = { devices: localDevices(serverDirectory(command)) }; return; }
         const creds = credentials(directory(command)); result = await api(creds.baseUrl, "/v1/admin/devices", {}, creds.token);
       });
    for (const name of ["approve", "revoke"] as const) {
       flags(program.command(name).description(`${name} device (administrator)`).argument("<device-id-or-name>"), "--server-dir <dir>", ...common)
         .action(async (deviceId: string, _options: CliOptions, command: Command) => {
           if (opts(command).serverDir || existsSync(join(serverDirectory(command), "metadata.sqlite"))) {
             result = { status: name === "approve" ? "approved" : "revoked",
               deviceId: name === "approve" ? approveLocalDevice(serverDirectory(command), deviceId) : revokeLocalDevice(serverDirectory(command), deviceId) };
             return;
           }
          const id = parseDeviceId(deviceId), creds = credentials(directory(command));
          result = await api(
            creds.baseUrl,
            name === "approve"
              ? `/v1/admin/enrollments/${id}/approve`
              : `/v1/admin/devices/${id}/revoke`,
            { method: "POST", body: JSON.stringify({ protocolVersion: 1 }) },
            creds.token,
          );
        });
    }
    const admin = flags(program.command("admin").description("Aggregate administrator reports"), ...common);
    for (const [name, path] of Object.entries({
      storage: "storage",
      "retention-dry-run": "retention/dry-run",
      "gc-dry-run": "gc/dry-run",
      scan: "integrity/scan",
      diagnostics: "diagnostics",
    })) {
       flags(admin.command(name).description(`Administrator ${name} report`), "--server-dir <dir>", ...common)
         .action(async (_options: CliOptions, command: Command) => {
           if (opts(command).serverDir) { result = await localAdminReport(serverDirectory(command), name); return; }
          const creds = credentials(directory(command));
          result = await api(creds.baseUrl, `/v1/admin/${path}`, name === "scan" ? { method: "POST" } : {}, creds.token);
        });
    }
    if (!args.length) { program.outputHelp(); return 0; }
    await program.parseAsync(args, { from: "user" });
    if (result !== undefined) output(result, seen.has("--json"));
    return code;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0 &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.help")) return 0;
    const message = error instanceof Error ? error.message : "command failed";
    const state = error instanceof RemoteError && (error.status === 401 || error.status === 403) ? "auth_required" : "unknown";
    const code = state === "auth_required" ? 3 : 2;
    console.error(JSON.stringify({ error: message, state, exitCode: code }));
    return code;
  }
}
if (import.meta.main) process.exitCode = await main();
