#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { parseDeviceId } from "@nanosync/protocol";
import { RemoteError } from "@nanosync/sync-core";
import { api, bootstrap, credentials, joinVault, readPassword } from "./client.ts";
import { privateDirectory, secureCreate, secureRead } from "./security.ts";
import { runServer } from "./server.ts";
import { SyncRunner } from "./sync-runner.ts";

type CliOptions = { clientDir?: string; syncDir?: string; continuous?: boolean; serverDir?: string; url?: string; proofFile?: string;
  deviceId?: string; recoveryFile?: string; host?: string; port?: string; acknowledgeExposure?: boolean;
  json?: boolean };
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
      "--acknowledge-exposure");
    const opts = (command: Command): CliOptions => command.optsWithGlobals<CliOptions>();
    const directory = (command: Command) => opts(command).clientDir ?? join(process.env.HOME ?? "", ".local/share/nanosync");
    let result: unknown, code = 0;
    const server = flags(
      program.command("server").description("Server provisioning and runtime"),
      "--server-dir <dir>", "--host <host>", "--port <port>", "--acknowledge-exposure", ...common);
    flags(
      server.command("init").description("Create private pepper and bootstrap proof"),
      "--server-dir <dir>",
      ...common,
    )
      .action((_options: CliOptions, command: Command) => {
        const dir = privateDirectory(required(opts(command).serverDir, "--server-dir"));
        secureCreate(join(dir, "pepper.hex"), randomBytes(32).toString("hex"));
        secureCreate(join(dir, "bootstrap.hex"), randomBytes(32).toString("hex"));
        result = {
          initialized: true,
          bootstrapProofFile: join(dir, "bootstrap.hex"),
        };
      });
    flags(
      server.command("run").description("Run server until SIGINT or SIGTERM"),
      "--server-dir <dir>", "--host <host>", "--port <port>", "--acknowledge-exposure", ...common,
    )
      .action(async (_options: CliOptions, command: Command) => {
        const config = opts(command);
        const running = await runServer({
          directory: required(config.serverDir, "--server-dir"),
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
      program.command("enroll").description("Request or finish enrollment (password on stdin for first request)"),
      "--url <url>", "--device-id <uuid>", "--recovery-file <file>", ...common,
    )
      .action(async (_options: CliOptions, command: Command) => {
        const config = opts(command), dir = directory(command);
        const url = required(config.url, "--url"), id = parseDeviceId(required(config.deviceId, "--device-id"));
        const recovery = config.recoveryFile ? secureRead(config.recoveryFile, 128).toString("utf8").trim() : undefined;
        result = await joinVault(dir, url, id, existsSync(join(dir, "enrollment.json")) ? undefined : readPassword(), recovery);
        if ((result as { status?: string }).status === "pending") code = 3;
      });
    flags(
      program.command("sync").description("Synchronize once, or watch and synchronize continuously in the foreground"),
      "--sync-dir <dir>", "--continuous", ...common,
    ).action(async (_options: CliOptions, command: Command) => {
      const dir = directory(command);
      const syncDirectory = required(opts(command).syncDir, "--sync-dir");
      const creds = credentials(dir);
      const masterKey = Buffer.from(creds.masterKey, "hex");
      let runner: SyncRunner;
      try {
        runner = SyncRunner.start({
          clientDirectory: dir,
          syncDirectory,
          vaultId: creds.vaultId,
          deviceId: creds.deviceId,
          masterKey,
          baseUrl: creds.baseUrl,
          token: creds.token,
        });
      } finally {
        masterKey.fill(0);
      }
      try {
        if (!opts(command).continuous) {
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
    flags(program.command("devices").description("List devices (administrator)"), ...common)
      .action(async (_options: CliOptions, command: Command) => {
        const creds = credentials(directory(command)); result = await api(creds.baseUrl, "/v1/admin/devices", {}, creds.token);
      });
    for (const name of ["approve", "revoke"] as const) {
      flags(program.command(name).description(`${name} device (administrator)`).argument("<device-id>"), ...common)
        .action(async (deviceId: string, _options: CliOptions, command: Command) => {
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
      flags(admin.command(name).description(`Administrator ${name} report`), ...common)
        .action(async (_options: CliOptions, command: Command) => {
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
