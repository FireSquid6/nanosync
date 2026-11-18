import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientLocal } from "@nanosync/client-local";

export function checkLocalDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "nanosync-desktop-validation-"));
  const vault = randomUUID();
  const device = randomUUID();
  const head = { revisionId: randomUUID(), sequence: 1 };
  try {
    const local = new ClientLocal(directory, vault, device);
    try {
      local.recordHead("observed", head);
    } finally {
      local.close();
    }
    const reopened = new ClientLocal(directory, vault, device);
    try {
      assert.deepEqual(reopened.head("observed"), head);
      assert.equal(reopened.pragmas().synchronous, 2);
      return { sequence: head.sequence, synchronous: reopened.pragmas().synchronous };
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function checkCredentialStore() {
  // libsecret's maintained CLI keeps the disposable secret off argv and disk.
  const identity = randomUUID();
  const secret = randomUUID();
  const attributes = ["application", "org.nanosync.validation", "probe", identity];
  const store = Bun.spawn([
    "secret-tool", "store", "--label=Nanosync disposable validation", ...attributes,
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  store.stdin.write(secret);
  store.stdin.end();
  try {
    assert.equal(await store.exited, 0, "Secret Service unavailable/locked; unlock the credential store");
    const lookup = Bun.spawn(["secret-tool", "lookup", ...attributes], {
      stdout: "pipe", stderr: "pipe",
    });
    const retrieved = (await new Response(lookup.stdout).text()).trimEnd();
    assert.equal(await lookup.exited, 0, "credential lookup failed");
    assert.ok(retrieved === secret, "credential roundtrip mismatch");
  } finally {
    const clear = Bun.spawn(["secret-tool", "clear", ...attributes], {
      stdout: "pipe", stderr: "pipe",
    });
    assert.equal(await clear.exited, 0, "disposable credential cleanup failed");
  }
  const missing = Bun.spawn(["secret-tool", "lookup", ...attributes], {
    stdout: "pipe", stderr: "pipe",
  });
  assert.equal(await missing.exited, 1, "disposable credential still exists");
}
