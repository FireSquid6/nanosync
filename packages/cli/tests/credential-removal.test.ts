import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultCredentialStore } from "@nanosync/client-service/credential-store";
import { privateDirectory, secureCreate } from "../src/security.ts";
import { main } from "../src/main.ts";

test("explicit CLI UUID replays OS removal after registration was already deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "nanosync-remove-replay-"));
  const id = randomUUID();
  const journal = join(privateDirectory(join(root, "credential-removals")), `${id}.json`);
  secureCreate(journal, JSON.stringify({ version: 1, serverId: id, credentialMode: "os" }));
  const secrets = new Map<string, string>();
  const get = spyOn(defaultCredentialStore, "get").mockImplementation(key => secrets.get(key) ?? null);
  const set = spyOn(defaultCredentialStore, "set").mockImplementation((key, value) => { secrets.set(key, value); });
  const remove = spyOn(defaultCredentialStore, "delete").mockImplementation(key => { secrets.delete(key); });
  try {
    expect(await main(["client", "connections", "remove", "--client-dir", root, "--server", id, "--force", "--yes", "--non-interactive", "--json"])).toBe(0);
    expect(existsSync(journal)).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(secrets.size).toBe(0);
  } finally {
    get.mockRestore(); set.mockRestore(); remove.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
