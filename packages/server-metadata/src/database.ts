import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  constants,
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { METADATA_MIGRATIONS, type MetadataMigration } from "./migrations.ts";
import {
  MAX_SQLITE_TIMESTAMP_MS,
  METADATA_SCHEMA_VERSION,
  type MigrationLedgerRow,
} from "./schema.ts";

export type MetadataErrorCode =
  | "UNSAFE_PATH"
  | "UNSUPPORTED_SCHEMA"
  | "CORRUPT_SCHEMA"
  | "MIGRATION_FAILURE"
  | "NESTED_TRANSACTION"
  | "ASYNC_TRANSACTION"
  | "CLOSED_DATABASE"
  | "INVARIANT"
  | "SQLITE_FAILURE";

export class MetadataError extends Error {
  readonly code: MetadataErrorCode;
  constructor(
    code: MetadataErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MetadataError";
    this.code = code;
  }
}

export type SqlValue = SQLQueryBindings;
export interface MutationResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
export interface MetadataPragmas {
  foreignKeys: number;
  busyTimeoutMs: number;
  journalMode: string;
  synchronous: number;
  userVersion: number;
}

export interface MetadataTransaction {
  run(sql: string, parameters?: readonly SqlValue[]): MutationResult;
  get<T>(sql: string, parameters?: readonly SqlValue[]): T | null;
  all<T>(sql: string, parameters?: readonly SqlValue[]): T[];
}

export class ServerMetadataDatabase {
  private readonly database: Database;
  private closed = false;
  private writing = false;

  constructor(path: string) {
    this.database = openDatabase(path, METADATA_MIGRATIONS);
  }

  /** SELECT only. Mutations and compound repository work must use writeTransaction. */
  all<T>(sql: string, parameters: readonly SqlValue[] = []): T[] {
    this.assertOpen();
    assertReadSql(sql);
    return executeAll<T>(this.database, sql, parameters);
  }

  get<T>(sql: string, parameters: readonly SqlValue[] = []): T | null {
    this.assertOpen();
    assertReadSql(sql);
    return executeGet<T>(this.database, sql, parameters);
  }

  pragmas(): MetadataPragmas {
    this.assertOpen();
    return readPragmas(this.database);
  }

  writeTransaction<T>(callback: (transaction: MetadataTransaction) => T): T {
    this.assertOpen();
    if (this.writing || this.database.inTransaction) {
      throw new MetadataError(
        "NESTED_TRANSACTION",
        "Nested metadata write transactions are not permitted",
      );
    }
    this.writing = true;
    let active = true;
    const transaction: MetadataTransaction = {
      run: (sql, parameters = []) => {
        if (!active)
          throw new MetadataError(
            "INVARIANT",
            "Metadata transaction is no longer active",
          );
        assertNoTransactionControl(sql);
        return executeRun(this.database, sql, parameters);
      },
      get: <R>(sql: string, parameters: readonly SqlValue[] = []) => {
        if (!active)
          throw new MetadataError(
            "INVARIANT",
            "Metadata transaction is no longer active",
          );
        assertNoTransactionControl(sql);
        return executeGet<R>(this.database, sql, parameters);
      },
      all: <R>(sql: string, parameters: readonly SqlValue[] = []) => {
        if (!active)
          throw new MetadataError(
            "INVARIANT",
            "Metadata transaction is no longer active",
          );
        assertNoTransactionControl(sql);
        return executeAll<R>(this.database, sql, parameters);
      },
    };
    try {
      try {
        this.database.run("BEGIN IMMEDIATE");
      } catch (cause) {
        throw new MetadataError(
          "SQLITE_FAILURE",
          "Unable to begin metadata transaction",
          { cause },
        );
      }
      let result: T;
      try {
        result = callback(transaction);
      } catch (error) {
        rollback(this.database);
        throw error;
      }
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        rollback(this.database);
        throw new MetadataError(
          "ASYNC_TRANSACTION",
          "Metadata write transactions must use a synchronous callback",
        );
      }
      try {
        this.database.run("COMMIT");
      } catch (cause) {
        rollback(this.database);
        throw new MetadataError(
          "SQLITE_FAILURE",
          "Unable to commit metadata transaction",
          { cause },
        );
      }
      return result;
    } finally {
      rollback(this.database);
      active = false;
      this.writing = false;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.writing || this.database.inTransaction) {
      throw new MetadataError(
        "INVARIANT",
        "Cannot close the metadata database during a transaction",
      );
    }
    try {
      this.database.close(true);
      this.closed = true;
    } catch (cause) {
      throw new MetadataError(
        "SQLITE_FAILURE",
        "Unable to close metadata database",
        { cause },
      );
    }
  }

  private assertOpen(): void {
    if (this.closed)
      throw new MetadataError("CLOSED_DATABASE", "Metadata database is closed");
  }
}

/** Test-only hook for exercising migration failure and compatibility behavior. */
export function __unsafeOpenWithMigrationsForTests(
  path: string,
  migrations: readonly MetadataMigration[],
): ServerMetadataDatabase {
  const instance = Object.create(
    ServerMetadataDatabase.prototype,
  ) as ServerMetadataDatabase;
  Object.defineProperty(instance, "database", {
    value: openDatabase(path, migrations),
  });
  Object.defineProperty(instance, "closed", { value: false, writable: true });
  Object.defineProperty(instance, "writing", { value: false, writable: true });
  return instance;
}

function openDatabase(
  path: string,
  migrations: readonly MetadataMigration[],
): Database {
  const memory = path === ":memory:";
  let filename = path;
  if (!memory) filename = preparePath(path);
  let database: Database | undefined;
  try {
    database = new Database(filename, {
      create: true,
      readwrite: true,
      strict: true,
      safeIntegers: false,
    });
    configure(database, memory);
    migrate(database, migrations);
    verifyIntegrity(database);
    if (!memory) validateSidecars(filename);
    return database;
  } catch (cause) {
    database?.close();
    if (cause instanceof MetadataError) throw cause;
    throw new MetadataError(
      "SQLITE_FAILURE",
      "Unable to open metadata database",
      { cause },
    );
  }
}

function preparePath(path: string): string {
  if (!path || path.includes("\0"))
    throw new MetadataError("UNSAFE_PATH", "Metadata database path is unsafe");
  const filename = resolve(path);
  const parent = dirname(filename);
  let parentStats;
  try {
    parentStats = lstatSync(parent);
    if (
      !parentStats.isDirectory() ||
      parentStats.isSymbolicLink() ||
      realpathSync(parent) !== parent
    )
      throw new Error();
    validateOwnershipAndMode(parentStats, 0o700);
  } catch (cause) {
    throw new MetadataError(
      "UNSAFE_PATH",
      "Metadata database parent must be a private, owned, real directory",
      { cause },
    );
  }
  try {
    const stats = lstatSync(filename);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
      throw new Error();
    validateOwnershipAndMode(stats, 0o600);
  } catch (cause) {
    if (!hasCode(cause, "ENOENT"))
      throw new MetadataError(
        "UNSAFE_PATH",
        "Existing metadata database path is unsafe",
        { cause },
      );
    try {
      const descriptor = openSync(
        filename,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
    } catch (createCause) {
      throw new MetadataError(
        "UNSAFE_PATH",
        "Unable to create private metadata database file",
        { cause: createCause },
      );
    }
  }
  validateSidecars(filename);
  return filename;
}

function configure(database: Database, memory: boolean): void {
  const version = executeGet<{ version: string }>(
    database,
    "SELECT sqlite_version() AS version",
    [],
  )?.version;
  if (!version || compareVersions(version, "3.37.0") < 0) {
    throw new MetadataError(
      "UNSUPPORTED_SCHEMA",
      "SQLite 3.37.0 or newer with STRICT tables is required",
    );
  }
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA busy_timeout = 5000");
  database.run(`PRAGMA journal_mode = ${memory ? "MEMORY" : "WAL"}`);
  database.run("PRAGMA synchronous = FULL");
  const actual = readPragmas(database);
  const expectedJournal = memory ? "memory" : "wal";
  if (
    actual.foreignKeys !== 1 ||
    actual.busyTimeoutMs !== 5000 ||
    actual.journalMode.toLowerCase() !== expectedJournal ||
    actual.synchronous !== 2
  ) {
    throw new MetadataError(
      "INVARIANT",
      "Required SQLite safety settings could not be established",
    );
  }
}

function migrate(
  database: Database,
  migrations: readonly MetadataMigration[],
): void {
  migrations.forEach((item, index) => {
    if (item.version !== index + 1)
      throw new MetadataError(
        "CORRUPT_SCHEMA",
        "Supported migration list is not contiguous",
      );
  });
  const userVersion = pragmaNumber(database, "user_version");
  if (userVersion > migrations.length)
    throw new MetadataError(
      "UNSUPPORTED_SCHEMA",
      "Metadata schema is newer than this server supports",
    );
  const ledgerExists =
    executeGet<{ count: number }>(
      database,
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'metadata_migrations'",
      [],
    )!.count === 1;
  if (!ledgerExists && userVersion !== 0)
    throw new MetadataError(
      "CORRUPT_SCHEMA",
      "Metadata migration ledger is missing",
    );
  const rows = ledgerExists
    ? executeAll<MigrationLedgerRow>(
        database,
        "SELECT version, name, checksum, applied_at_ms FROM metadata_migrations ORDER BY version",
        [],
      )
    : [];
  if (rows.length !== userVersion)
    throw new MetadataError(
      "CORRUPT_SCHEMA",
      "Metadata migration ledger and schema version disagree",
    );
  rows.forEach((row, index) => {
    const expected = migrations[index];
    if (
      !expected ||
      row.version !== index + 1 ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum
    ) {
      throw new MetadataError(
        "CORRUPT_SCHEMA",
        "Metadata migration ledger is gapped or tampered",
      );
    }
  });
  for (const item of migrations.slice(userVersion))
    applyMigration(database, item);
  if (
    migrations === METADATA_MIGRATIONS &&
    migrations.length !== METADATA_SCHEMA_VERSION
  ) {
    throw new MetadataError(
      "INVARIANT",
      "Metadata schema version constant is inconsistent",
    );
  }
}

function applyMigration(
  database: Database,
  migration: MetadataMigration,
): void {
  // Rebuilding v1 singleton tables while preserving existing ciphertext and
  // revisions requires dropping referenced tables in a single transaction.
  // SQLite cannot change foreign_keys inside that transaction.
  if (migration.version === 5) database.run("PRAGMA foreign_keys = OFF");
  try {
    database.run("BEGIN IMMEDIATE");
    database.exec(migration.sql);
    executeRun(
      database,
      "INSERT INTO metadata_migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      [migration.version, migration.name, migration.checksum, Date.now()],
    );
    database.run(`PRAGMA user_version = ${migration.version}`);
    if (migration.version === 5 && executeAll(database, "PRAGMA foreign_key_check", []).length)
      throw new Error("multi-vault migration violates foreign keys");
    database.run("COMMIT");
  } catch (cause) {
    rollback(database);
    throw new MetadataError(
      "MIGRATION_FAILURE",
      `Metadata migration ${migration.version} failed`,
      { cause },
    );
  } finally {
    if (migration.version === 5) database.run("PRAGMA foreign_keys = ON");
  }
}

function verifyIntegrity(database: Database): void {
  const result = executeGet<{ quick_check: string }>(
    database,
    "PRAGMA quick_check",
    [],
  );
  const foreignKeys = executeAll(database, "PRAGMA foreign_key_check", []);
  if (result?.quick_check !== "ok" || foreignKeys.length !== 0) {
    throw new MetadataError(
      "CORRUPT_SCHEMA",
      "Metadata database integrity check failed",
    );
  }
  if (pragmaNumber(database, "user_version") >= 1) {
    const required = [
      "idempotency_records",
      "metadata_migrations",
      "object_catalog",
      "revision_objects",
      "revision_parents",
      "revisions",
      "server_state",
      "upload_sessions",
      "idempotency_record_immutable",
      "object_catalog_immutable",
      "revision_accept_complete",
      "revision_accept_once",
      "revision_immutable",
      "server_state_valid_head_insert",
      "server_state_valid_head_update",
    ];
    const present = executeAll<{ name: string }>(
      database,
      "SELECT name FROM sqlite_schema WHERE (type = 'table' OR type = 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    ).map((row) => row.name);
    if (required.some((name) => !present.includes(name))) {
      throw new MetadataError(
        "CORRUPT_SCHEMA",
        "Metadata schema is incomplete",
      );
    }
  }
  if (pragmaNumber(database, "user_version") >= 2) {
    const required = [
      "accounts",
      "bootstrap_state",
      "initial_devices",
      "recovery_wraps",
      "account_identity_immutable",
      "account_verifier_transition",
      "bootstrap_identity_immutable",
      "bootstrap_seal_once",
      "initial_device_immutable",
      "recovery_wrap_immutable",
    ];
    const present = executeAll<{ name: string }>(
      database,
      "SELECT name FROM sqlite_schema WHERE (type = 'table' OR type = 'trigger') ORDER BY name",
      [],
    ).map((row) => row.name);
    if (required.some((name) => !present.includes(name)))
      throw new MetadataError(
        "CORRUPT_SCHEMA",
        "Metadata schema is incomplete",
      );
  }
  if (pragmaNumber(database, "user_version") >= 3) {
    const required = [
      "devices",
      "password_sessions",
      "enrollment_requests",
      "authentication_rate_limit",
      "audit_events",
      "one_initial_device",
      "password_sessions_expiry",
      "enrollment_requests_state_created",
      "audit_events_time",
      "device_identity_immutable",
      "device_transition_valid",
      ...(pragmaNumber(database, "user_version") < 6 ? ["device_last_admin"] : []),
      "password_session_digest_immutable",
      "audit_event_immutable",
      "enrollment_identity_immutable",
      "enrollment_transition_valid",
    ];
    const present = executeAll<{ name: string }>(
      database,
      "SELECT name FROM sqlite_schema WHERE type IN ('table', 'index', 'trigger') ORDER BY name",
      [],
    ).map((row) => row.name);
    if (required.some((name) => !present.includes(name)))
      throw new MetadataError(
        "CORRUPT_SCHEMA",
        "Metadata schema is incomplete",
      );
  }
  if (pragmaNumber(database, "user_version") >= 4) {
    const present = executeAll<{ name: string }>(
      database,
      "SELECT name FROM sqlite_schema WHERE type IN ('table', 'index')",
      [],
    ).map((row) => row.name);
    if (
      !present.includes("gc_candidates") ||
      !present.includes("gc_candidates_marked")
    )
      throw new MetadataError(
        "CORRUPT_SCHEMA",
        "Metadata schema is incomplete",
      );
  }
  if (pragmaNumber(database, "user_version") >= 5) {
    const present = executeAll<{ name: string }>(database,
      "SELECT name FROM sqlite_schema WHERE type IN ('index','trigger')", []).map(row => row.name);
    if (["vault_name_unique", "device_name_unique", "vault_identity_immutable"].some(name => !present.includes(name)))
      throw new MetadataError("CORRUPT_SCHEMA", "Multi-vault schema is incomplete");
  }
  if (pragmaNumber(database, "user_version") >= 6) {
    const present = executeAll<{ name: string }>(database, "SELECT name FROM sqlite_schema WHERE type IN ('table','trigger')", []).map(row => row.name);
    if (["vault_creations", "vault_deletions", "vault_creation_immutable", "deletion_identity_immutable", "deletion_terminal", "deletion_durable"].some(name => !present.includes(name))) throw new MetadataError("CORRUPT_SCHEMA", "Owner schema is incomplete");
  }

}

function validateSidecars(filename: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const stats = lstatSync(filename + suffix);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
        throw new Error();
      validateOwnershipAndMode(stats, 0o600);
    } catch (cause) {
      if (!hasCode(cause, "ENOENT"))
        throw new MetadataError(
          "UNSAFE_PATH",
          "SQLite sidecar path is unsafe",
          { cause },
        );
    }
  }
}

function validateOwnershipAndMode(
  stats: { uid: number; mode: number },
  mode: number,
): void {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o777) !== mode)
    throw new Error("unsafe ownership or permissions");
}

function readPragmas(database: Database): MetadataPragmas {
  return {
    foreignKeys: pragmaNumber(database, "foreign_keys"),
    busyTimeoutMs:
      executeGet<{ timeout: number }>(database, "PRAGMA busy_timeout", [])
        ?.timeout ?? -1,
    journalMode:
      executeGet<Record<string, string>>(database, "PRAGMA journal_mode", [])
        ?.journal_mode ?? "",
    synchronous: pragmaNumber(database, "synchronous"),
    userVersion: pragmaNumber(database, "user_version"),
  };
}

function pragmaNumber(database: Database, name: string): number {
  const row = executeGet<Record<string, number>>(
    database,
    `PRAGMA ${name}`,
    [],
  );
  return row?.[name] ?? -1;
}

function executeRun(
  database: Database,
  sql: string,
  parameters: readonly SqlValue[],
): MutationResult {
  // A prepared statement executes only its first SQL statement, unlike Database.run/exec,
  // so callback-provided trailing SQL cannot escape the wrapper's transaction boundary.
  try {
    return database.query<never, SqlValue[]>(sql).run(...parameters);
  } catch (cause) {
    throw new MetadataError("SQLITE_FAILURE", "Metadata statement failed", {
      cause,
    });
  }
}
function executeGet<T>(
  database: Database,
  sql: string,
  parameters: readonly SqlValue[],
): T | null {
  try {
    return database.query<T, SqlValue[]>(sql).get(...parameters);
  } catch (cause) {
    throw new MetadataError("SQLITE_FAILURE", "Metadata query failed", {
      cause,
    });
  }
}
function executeAll<T>(
  database: Database,
  sql: string,
  parameters: readonly SqlValue[],
): T[] {
  try {
    return database.query<T, SqlValue[]>(sql).all(...parameters);
  } catch (cause) {
    throw new MetadataError("SQLITE_FAILURE", "Metadata query failed", {
      cause,
    });
  }
}
function assertReadSql(sql: string): void {
  if (!/^\s*SELECT\b/i.test(sql))
    throw new MetadataError(
      "INVARIANT",
      "Read helpers accept SELECT statements only",
    );
}
function assertNoTransactionControl(sql: string): void {
  let statement = sql;
  while (true) {
    statement = statement.trimStart();
    if (statement.startsWith("--")) {
      const newline = statement.indexOf("\n", 2);
      statement = newline < 0 ? "" : statement.slice(newline + 1);
      continue;
    }
    if (statement.startsWith("/*")) {
      const end = statement.indexOf("*/", 2);
      statement = end < 0 ? "" : statement.slice(end + 2);
      continue;
    }
    break;
  }
  if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)) {
    throw new MetadataError(
      "INVARIANT",
      "Transaction-control SQL is managed by the metadata transaction wrapper",
    );
  }
}
function rollback(database: Database): void {
  if (database.inTransaction) {
    try {
      database.run("ROLLBACK");
    } catch {
      /* Preserve the original failure; state is rechecked on later use. */
    }
  }
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
