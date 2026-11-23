import { spawnSync } from "node:child_process";
import { CliError } from "./errors.ts";

/** Synchronous so existing CLI server/key callers retain their signatures. */
export interface CredentialStore {
  get(id: string): string | null;
  set(id: string, secret: string): void;
  delete(id: string): void;
}
export class CredentialStoreError extends CliError {
  constructor() {
    super("CREDENTIAL_STORE_LOCKED", "OS credential store unavailable or locked; unlock the login keyring and ensure secret-tool and the Secret Service session are available, then retry", 5);
  }
}
export type SecretToolCommand = (args: string[], input?: string) => {
  status: number | null; stdout?: string; stderr?: string; error?: unknown;
};
const execute: SecretToolCommand = (args, input) => spawnSync("secret-tool", args, {
  input, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1_048_576,
  shell: false, stdio: ["pipe", "pipe", "pipe"],
});
export class SecretToolStore implements CredentialStore {
  constructor(private readonly run: SecretToolCommand = execute) {}
  private command(args: string[], input?: string, missing = false): string | null {
    let result: ReturnType<SecretToolCommand>;
    try { result = this.run(args, input); } catch { throw new CredentialStoreError(); }
    if (missing && result.status === 1 && !result.error && !result.stderr && !result.stdout) return null;
    if (result.error || result.status !== 0) throw new CredentialStoreError();
    return (result.stdout ?? "").replace(/\n$/, "");
  }
  get(id: string): string | null { return this.command(["lookup", "application", "nanosync", "credential-id", id], undefined, true); }
  set(id: string, secret: string): void {
    this.command(["store", "--label=Nanosync credentials", "application", "nanosync", "credential-id", id], secret);
  }
  delete(id: string): void { this.command(["clear", "application", "nanosync", "credential-id", id]); }
}
export const defaultCredentialStore: CredentialStore = new SecretToolStore();
