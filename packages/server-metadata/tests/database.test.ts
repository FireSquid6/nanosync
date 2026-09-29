import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __unsafeOpenWithMigrationsForTests,
  METADATA_MIGRATIONS,
  MetadataError,
  ServerMetadataDatabase,
  migrationChecksum,
  type MetadataMigration,
} from "../src/index.ts";

const roots: string[] = [];
const vault = "12345678-1234-1234-9234-123456789abc";
const device = "22345678-1234-1234-9234-123456789abc";
const revision = "32345678-1234-1234-9234-123456789abc";
const parentRevision = "42345678-1234-1234-9234-123456789abc";
const objectId = "a".repeat(64);
const checksum = "b".repeat(64);
const mac = "c".repeat(64);
const digest = "d".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function pathFor(name = "metadata.sqlite"): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "nanosync-metadata-"));
  roots.push(root);
  return { root, path: join(root, name) };
}

function insertObject(
  db: ServerMetadataDatabase,
  id = objectId,
  type = "manifest",
  length = type === "chunk" ? 97 : 109,
  ciphertextChecksum = checksum,
): void {
  db.writeTransaction((tx) => tx.run(
    "INSERT OR IGNORE INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)",
    [vault],
  ));
  db.writeTransaction((tx) => tx.run(
    `INSERT INTO object_catalog
      (vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [vault, id, type, ciphertextChecksum, length, 1, 100],
  ));
}

function insertRevision(db: ServerMetadataDatabase, id = revision, manifest = objectId): void {
  db.writeTransaction((tx) => tx.run(
    `INSERT INTO revisions
      (vault_id, revision_id, creating_device_id, client_created_at, manifest_object_id, protocol_version,
       revision_format_version, reference_set_mac, canonical_envelope_json, request_digest, server_created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [vault, id, device, "2026-01-02T03:04:05.006Z", manifest, 1, 1, mac, "{}", digest, 101],
  ));
}

function insertReference(db: ServerMetadataDatabase, id = revision, referencedObject = objectId): void {
  db.writeTransaction((tx) => tx.run(
    `INSERT INTO revision_objects
      (vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
     VALUES (?, ?, ?, 'manifest', ?, 109, 1)`,
    [vault, id, referencedObject, checksum],
  ));
}

describe("metadata initialization", () => {
  test("initializes required schema and settings and reopens without losing data", async () => {
    const { path } = await pathFor();
    let db = new ServerMetadataDatabase(path);
    expect(db.pragmas()).toEqual({
      foreignKeys: 1,
      busyTimeoutMs: 5000,
      journalMode: "wal",
      synchronous: 2,
      userVersion: 1,
    });
    expect(db.get<{ version: number; name: string }>("SELECT version, name FROM metadata_migrations")).toEqual({
      version: 1,
      name: "initial_metadata_schema",
    });
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((row) => row.name)).toEqual([
      "idempotency_records", "metadata_migrations", "object_catalog", "revision_objects", "revision_parents",
      "revisions", "server_state", "upload_sessions",
    ]);
    insertObject(db);
    db.close();

    db = new ServerMetadataDatabase(path);
    expect(db.get<{ object_id: string }>("SELECT object_id FROM object_catalog")?.object_id).toBe(objectId);
    db.close();
  });

  test("creates a private database and private SQLite sidecars", async () => {
    const { path } = await pathFor();
    const db = new ServerMetadataDatabase(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const stats = await lstat(path + suffix);
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o600);
    }
    db.close();
  });

  test("rejects symlinks, non-regular paths, unsafe modes, and unsafe parents", async () => {
    const symlinkCase = await pathFor("link.sqlite");
    const target = join(symlinkCase.root, "target.sqlite");
    await writeFile(target, "", { mode: 0o600 });
    await symlink(target, symlinkCase.path);
    expect(() => new ServerMetadataDatabase(symlinkCase.path)).toThrow(MetadataError);

    const directoryCase = await pathFor("database");
    await mkdir(directoryCase.path, { mode: 0o700 });
    expect(() => new ServerMetadataDatabase(directoryCase.path)).toThrow(MetadataError);

    const modeCase = await pathFor("mode.sqlite");
    await writeFile(modeCase.path, "", { mode: 0o644 });
    expect(() => new ServerMetadataDatabase(modeCase.path)).toThrow(MetadataError);

    const parentCase = await pathFor("parent.sqlite");
    await chmod(parentCase.root, 0o755);
    expect(() => new ServerMetadataDatabase(parentCase.path)).toThrow(MetadataError);
    for (const candidate of [symlinkCase.path, directoryCase.path, modeCase.path, parentCase.path]) {
      try { new ServerMetadataDatabase(candidate); } catch (error) { expect(error).toMatchObject({ code: "UNSAFE_PATH" }); }
    }
  });
});

describe("transactions", () => {
  test("commits successful callbacks and rolls back thrown callbacks", () => {
    const db = new ServerMetadataDatabase(":memory:");
    insertObject(db);
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM object_catalog")?.count).toBe(1);
    expect(() => db.writeTransaction((tx) => {
      tx.run("DELETE FROM object_catalog");
      throw new Error("stop");
    })).toThrow("stop");
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM object_catalog")?.count).toBe(1);
    db.close();
  });

  test("rejects a returned Promise and rolls back synchronously", () => {
    const db = new ServerMetadataDatabase(":memory:");
    expect(() => db.writeTransaction((tx) => {
      tx.run("INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vault]);
      return Promise.resolve("not allowed");
    })).toThrow(expect.objectContaining({ code: "ASYNC_TRANSACTION" }));
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM server_state")?.count).toBe(0);
    db.close();
  });

  test("rejects nested writes and invalidates a retained transaction handle", () => {
    const db = new ServerMetadataDatabase(":memory:");
    let retained: { run(sql: string): unknown } | undefined;
    expect(() => db.writeTransaction((tx) => {
      retained = tx;
      db.writeTransaction(() => undefined);
    })).toThrow(expect.objectContaining({ code: "NESTED_TRANSACTION" }));
    expect(() => retained!.run("SELECT 1")).toThrow(expect.objectContaining({ code: "INVARIANT" }));
    db.close();
  });

  test("rejects callback transaction control and rolls back prior writes", () => {
    const db = new ServerMetadataDatabase(":memory:");
    for (const control of ["COMMIT", "  /* caller */\n-- still caller\nROLLBACK"] as const) {
      expect(() => db.writeTransaction((tx) => {
        tx.run("INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vault]);
        tx.run(control);
      })).toThrow(expect.objectContaining({ code: "INVARIANT" }));
      expect(db.get<{ count: number }>("SELECT count(*) AS count FROM server_state")?.count).toBe(0);
    }
    expect(() => db.writeTransaction((tx) => {
      tx.run("INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0); COMMIT", [vault]);
      throw new Error("rollback prepared first statement");
    })).toThrow("rollback prepared first statement");
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM server_state")?.count).toBe(0);
    db.writeTransaction((tx) => tx.run(
      "INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vault],
    ));
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM server_state")?.count).toBe(1);
    db.close();
  });

  test("wraps a deferred commit failure and leaves the database usable", () => {
    const db = new ServerMetadataDatabase(":memory:");
    expect(() => db.writeTransaction((tx) => {
      tx.run("PRAGMA defer_foreign_keys = ON");
      tx.run(
        `INSERT INTO object_catalog
         (vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms)
         VALUES (?, ?, 'manifest', ?, 109, 1, 0)`,
        [vault, objectId, checksum],
      );
    })).toThrow(expect.objectContaining({ code: "SQLITE_FAILURE", message: "Unable to commit metadata transaction" }));
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM object_catalog")?.count).toBe(0);
    db.writeTransaction((tx) => tx.run(
      "INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vault],
    ));
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM server_state")?.count).toBe(1);
    db.close();
  });

  test("reports all public operations after close", () => {
    const db = new ServerMetadataDatabase(":memory:");
    db.close();
    db.close();
    expect(() => db.get("SELECT 1")).toThrow(expect.objectContaining({ code: "CLOSED_DATABASE" }));
    expect(() => db.all("SELECT 1")).toThrow(expect.objectContaining({ code: "CLOSED_DATABASE" }));
    expect(() => db.pragmas()).toThrow(expect.objectContaining({ code: "CLOSED_DATABASE" }));
    expect(() => db.writeTransaction(() => undefined)).toThrow(expect.objectContaining({ code: "CLOSED_DATABASE" }));
  });
});

describe("schema invariants", () => {
  test("rejects malformed object identity, type, length, and duplicate identity", () => {
    const db = new ServerMetadataDatabase(":memory:");
    db.writeTransaction((tx) => tx.run(
      "INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vault],
    ));
    const insert = (id: string, type: string, length: number) => db.writeTransaction((tx) => tx.run(
      `INSERT INTO object_catalog
       (vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms)
       VALUES (?, ?, ?, ?, ?, 1, 0)`, [vault, id, type, checksum, length],
    ));
    expect(() => insert("A".repeat(64), "chunk", 100)).toThrow();
    expect(() => insert(objectId, "plaintext", 100)).toThrow();
    expect(() => insert(objectId, "chunk", 0)).toThrow();
    expect(() => insert(objectId, "chunk", 64 * 1024 * 1024 * 1024 + 1)).toThrow();
    insert(objectId, "chunk", 100);
    expect(() => insert(objectId, "chunk", 100)).toThrow();
    db.close();
  });

  test("enforces type-specific complete frame lengths in the object catalog", () => {
    const db = new ServerMetadataDatabase(":memory:");
    expect(() => insertObject(db, "1".repeat(64), "chunk", 96)).toThrow();
    insertObject(db, "2".repeat(64), "chunk", 97);
    insertObject(db, "3".repeat(64), "chunk", 4_194_400);
    expect(() => insertObject(db, "4".repeat(64), "chunk", 4_194_401)).toThrow();
    expect(() => insertObject(db, "5".repeat(64), "manifest", 108)).toThrow();
    insertObject(db, "6".repeat(64), "manifest", 109);
    insertObject(db, "7".repeat(64), "revision-private", 68_719_476_736);
    expect(() => insertObject(db, "8".repeat(64), "revision-private", 68_719_476_737)).toThrow();
    db.close();
  });

  test("rejects noncanonical UUIDs even when separators and length look plausible", () => {
    const db = new ServerMetadataDatabase(":memory:");
    const extraHyphen = "-2345678-1234-1234-9234-123456789abc";
    expect(extraHyphen).toHaveLength(36);
    expect(() => db.writeTransaction((tx) => tx.run(
      "INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)",
      [extraHyphen],
    ))).toThrow();
    db.close();
  });

  test("enforces reference catalog equality, parent uniqueness/positions, and foreign keys", () => {
    const db = new ServerMetadataDatabase(":memory:");
    insertObject(db);
    insertRevision(db, parentRevision);
    insertRevision(db);
    db.writeTransaction((tx) => tx.run(
      "INSERT INTO revision_parents(vault_id, revision_id, position, parent_revision_id) VALUES (?, ?, 0, ?)",
      [vault, revision, parentRevision],
    ));
    expect(() => db.writeTransaction((tx) => tx.run(
      "INSERT INTO revision_parents(vault_id, revision_id, position, parent_revision_id) VALUES (?, ?, 1, ?)",
      [vault, revision, parentRevision],
    ))).toThrow();
    expect(() => db.writeTransaction((tx) => tx.run(
      "INSERT INTO revision_parents(vault_id, revision_id, position, parent_revision_id) VALUES (?, ?, 2, ?)",
      [vault, revision, parentRevision],
    ))).toThrow();
    expect(() => db.writeTransaction((tx) => tx.run(
      `INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
       VALUES (?, ?, ?, 'manifest', ?, 110, 1)`, [vault, revision, objectId, checksum],
    ))).toThrow();
    expect(() => db.writeTransaction((tx) => tx.run(
      `INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
       VALUES (?, ?, ?, 'chunk', ?, 109, 1)`, [vault, revision, objectId, checksum],
    ))).toThrow();
    expect(() => db.writeTransaction((tx) => tx.run(
      `INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
       VALUES (?, ?, ?, 'manifest', ?, 109, 1)`, [vault, revision, objectId, "f".repeat(64)],
    ))).toThrow();
    insertReference(db);
    expect(() => insertReference(db)).toThrow();

    const chunk = "9".repeat(64);
    insertObject(db, chunk, "chunk", 97);
    for (const invalidLength of [96, 4_194_401]) {
      expect(() => db.writeTransaction((tx) => tx.run(
        `INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
         VALUES (?, ?, ?, 'chunk', ?, ?, 1)`, [vault, revision, chunk, checksum, invalidLength],
      ))).toThrow();
    }
    db.writeTransaction((tx) => tx.run(
      `INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
       VALUES (?, ?, ?, 'chunk', ?, 97, 1)`, [vault, revision, chunk, checksum],
    ));
    db.close();
  });

  test("does not accept a revision whose manifest catalog object is type-confused", () => {
    const db = new ServerMetadataDatabase(":memory:");
    insertObject(db, objectId, "chunk", 97);
    insertRevision(db);
    db.writeTransaction((tx) => tx.run(
      `INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
       VALUES (?, ?, ?, 'chunk', ?, 97, 1)`, [vault, revision, objectId, checksum],
    ));
    expect(() => db.writeTransaction((tx) => tx.run(
      "UPDATE revisions SET accepted_sequence = 1 WHERE revision_id = ?", [revision],
    ))).toThrow();
    expect(db.get<{ accepted_sequence: number | null }>(
      "SELECT accepted_sequence FROM revisions WHERE revision_id = ?", [revision],
    )?.accepted_sequence).toBeNull();
    db.close();
  });

  test("allows prepared revisions but only accepted revisions at the matching head sequence", () => {
    const db = new ServerMetadataDatabase(":memory:");
    insertObject(db);
    insertRevision(db);
    expect(() => db.writeTransaction((tx) => tx.run(
      "UPDATE server_state SET current_head_revision_id = ?, current_sequence = 1 WHERE vault_id = ?",
      [revision, vault],
    ))).toThrow();
    expect(() => db.writeTransaction((tx) => tx.run("UPDATE revisions SET accepted_sequence = 1 WHERE revision_id = ?", [revision]))).toThrow();
    insertReference(db);
    db.writeTransaction((tx) => tx.run("UPDATE revisions SET accepted_sequence = 1 WHERE revision_id = ?", [revision]));
    db.writeTransaction((tx) => tx.run(
      "UPDATE server_state SET current_head_revision_id = ?, current_sequence = 1 WHERE vault_id = ?",
      [revision, vault],
    ));
    const secondObject = "e".repeat(64);
    insertObject(db, secondObject);
    insertRevision(db, parentRevision, secondObject);
    insertReference(db, parentRevision, secondObject);
    expect(() => db.writeTransaction((tx) => tx.run(
      "UPDATE revisions SET accepted_sequence = 1 WHERE revision_id = ?", [parentRevision],
    ))).toThrow();
    expect(() => db.writeTransaction((tx) => tx.run("UPDATE server_state SET current_sequence = 2"))).toThrow();
    expect(() => db.writeTransaction((tx) => tx.run("UPDATE revisions SET accepted_sequence = 2 WHERE revision_id = ?", [revision]))).toThrow();
    db.close();
  });
});

describe("migration safety", () => {
  test("rolls schema, ledger, and user_version back after a migration failure", async () => {
    const { path } = await pathFor();
    new ServerMetadataDatabase(path).close();
    const sql = "CREATE TABLE should_rollback(value TEXT) STRICT; INSERT INTO table_that_does_not_exist VALUES (1);";
    const failing: MetadataMigration = { version: 2, name: "injected_failure", sql, checksum: migrationChecksum(2, "injected_failure", sql) };
    expect(() => __unsafeOpenWithMigrationsForTests(path, [...METADATA_MIGRATIONS, failing])).toThrow(
      expect.objectContaining({ code: "MIGRATION_FAILURE" }),
    );
    const db = new ServerMetadataDatabase(path);
    expect(db.pragmas().userVersion).toBe(1);
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM metadata_migrations")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'should_rollback'")?.count).toBe(0);
    db.close();
  });

  test("refuses future, gapped, and tampered migration metadata", async () => {
    const future = await pathFor("future.sqlite");
    let db = new ServerMetadataDatabase(future.path);
    db.writeTransaction((tx) => tx.run("PRAGMA user_version = 2"));
    db.close();
    expect(() => new ServerMetadataDatabase(future.path)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_SCHEMA" }));

    const gapped = await pathFor("gapped.sqlite");
    db = new ServerMetadataDatabase(gapped.path);
    db.writeTransaction((tx) => tx.run(
      "INSERT INTO metadata_migrations(version, name, checksum, applied_at_ms) VALUES (3, 'gap', ?, 0)", ["e".repeat(64)],
    ));
    db.close();
    expect(() => new ServerMetadataDatabase(gapped.path)).toThrow(expect.objectContaining({ code: "CORRUPT_SCHEMA" }));

    const tampered = await pathFor("tampered.sqlite");
    db = new ServerMetadataDatabase(tampered.path);
    db.writeTransaction((tx) => tx.run("UPDATE metadata_migrations SET checksum = ? WHERE version = 1", ["f".repeat(64)]));
    db.close();
    expect(() => new ServerMetadataDatabase(tampered.path)).toThrow(expect.objectContaining({ code: "CORRUPT_SCHEMA" }));
  });

  test("refuses a ledger/version pair whose required schema is incomplete", async () => {
    const { path } = await pathFor("partial.sqlite");
    const db = new ServerMetadataDatabase(path);
    db.writeTransaction((tx) => tx.run("DROP TRIGGER server_state_valid_head_update"));
    db.close();
    expect(() => new ServerMetadataDatabase(path)).toThrow(expect.objectContaining({ code: "CORRUPT_SCHEMA" }));
  });
});
