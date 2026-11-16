import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open as openFile,
  opendir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ObjectStorageErrorCode =
  | "INVALID_KEY"
  | "INVALID_CHECKSUM"
  | "NOT_FOUND"
  | "NOT_REGULAR_FILE"
  | "SYMLINK"
  | "CHECKSUM_MISMATCH"
  | "OBJECT_CONFLICT"
  | "RANGE_NOT_SATISFIABLE"
  | "SIZE_LIMIT_EXCEEDED"
  | "UNSAFE_PATH";

export class ObjectStorageError extends Error {
  readonly code: ObjectStorageErrorCode;
  readonly key?: string;

  constructor(
    code: ObjectStorageErrorCode,
    message: string,
    key?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ObjectStorageError";
    this.code = code;
    this.key = key;
  }
}

export interface ByteRange {
  /** Zero-based first byte. */
  start: number;
  /** Zero-based exclusive end. An empty range at the end of an object is valid. */
  endExclusive: number;
}

export interface OpenObject {
  stream: ReadableStream<Uint8Array>;
  size: number;
  range: ByteRange;
}

export interface ObjectStat {
  size: number;
  modifiedAtMs: number;
}

export interface PutResult {
  status: "stored" | "already-present";
  size: number;
  checksum: string;
}

export interface ListOptions {
  /** The last key returned by the previous page; it is excluded from this page. */
  cursor?: string;
  /** Defaults to 100 and may not exceed 1,000. */
  limit?: number;
}

export interface ListResult {
  keys: string[];
  cursor: string | null;
}

/** Server-side immutable ciphertext storage. Keys are opaque, relative, slash-separated names. */
export interface Filesystem {
  putIfAbsent(
    key: string,
    stream: ReadableStream<Uint8Array>,
    expectedChecksum: string,
  ): Promise<PutResult>;
  open(key: string, range?: ByteRange): Promise<OpenObject>;
  stat(key: string): Promise<ObjectStat>;
  existsBatch(keys: readonly string[]): Promise<boolean[]>;
  delete(key: string): Promise<{ deleted: boolean }>;
  list(prefix?: string, options?: ListOptions): Promise<ListResult>;
}

export interface LocalFilesystemOptions {
  /** Maximum accepted ciphertext bytes. The default is 64 GiB. */
  maximumObjectSize?: number;
}

const TEMP_DIRECTORY = ".nanosync-tmp";
// Shared across instances so reopening storage never reclaims an in-process upload.
const activeStagingPaths = new Set<string>();
const DEFAULT_MAXIMUM_OBJECT_SIZE = 64 * 1024 * 1024 * 1024;
const IO_CHUNK_SIZE = 64 * 1024;

export class LocalFilesystem implements Filesystem {
  private readonly root: string;
  private readonly tempDirectory: string;
  private readonly maximumObjectSize: number;
  private readonly ready: Promise<void>;
  private readonly activePublications = new Map<string, number>();

  constructor(root: string, options: LocalFilesystemOptions = {}) {
    this.root = resolve(root);
    this.tempDirectory = join(this.root, TEMP_DIRECTORY);
    this.maximumObjectSize =
      options.maximumObjectSize ?? DEFAULT_MAXIMUM_OBJECT_SIZE;
    if (
      !Number.isSafeInteger(this.maximumObjectSize) ||
      this.maximumObjectSize < 0
    ) {
      throw new TypeError(
        "maximumObjectSize must be a non-negative safe integer",
      );
    }
    this.ready = this.initialize();
  }

  async putIfAbsent(
    key: string,
    source: ReadableStream<Uint8Array>,
    expectedChecksum: string,
  ): Promise<PutResult> {
    await this.ready;
    const parts = validateKey(key);
    const checksum = validateChecksum(expectedChecksum);
    await this.ensureParents(parts.slice(0, -1), key);
    const destination = join(this.root, ...parts);

    const existing = await this.inspectObject(destination, key, true);
    if (existing) {
      cancelStreamWithoutWaiting(source);
      return this.verifyExisting(key, destination, checksum, existing.size);
    }

    const temporaryPath = join(this.tempDirectory, `${process.pid}-${randomUUID()}`);
    let temporary: FileHandle | undefined;
    const reader = source.getReader();
    let size = 0;
    let sourceComplete = false;
    activeStagingPaths.add(temporaryPath);
    try {
      temporary = await openFile(
        temporaryPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          noFollowFlag(),
        0o600,
      );
      while (true) {
        const next = await reader.read();
        if (next.done) {
          sourceComplete = true;
          break;
        }
        if (!(next.value instanceof Uint8Array))
          throw new TypeError("Object stream must yield Uint8Array chunks");
        const incomingLength = next.value.byteLength;
        if (incomingLength > this.maximumObjectSize - size) {
          throw new ObjectStorageError(
            "SIZE_LIMIT_EXCEEDED",
            `Object exceeds the ${this.maximumObjectSize} byte limit`,
            key,
          );
        }
        for (let offset = 0; offset < incomingLength; offset += IO_CHUNK_SIZE) {
          const length = Math.min(IO_CHUNK_SIZE, incomingLength - offset);
          const owned = copyIncomingRange(next.value, offset, length);
          size += owned.byteLength;
          await writeAll(temporary, owned);
        }
      }
      await temporary.sync();
      await temporary.close();
      temporary = undefined;

      const actual = await hashFile(temporaryPath, key, false);
      if (actual.size !== size || actual.size > this.maximumObjectSize) {
        throw new Error(
          "Temporary object size differs from accounted stream bytes",
        );
      }
      if (actual.checksum !== checksum) {
        throw new ObjectStorageError(
          "CHECKSUM_MISMATCH",
          `Ciphertext checksum mismatch for ${key}`,
          key,
        );
      }

      this.beginPublication(destination);
      try {
        // A hard link is the publication point: unlike rename, it cannot replace destination.
        await link(temporaryPath, destination);
        await unlink(temporaryPath);
        await syncDirectory(this.tempDirectory);
        const published = await lstat(destination);
        validateObject(published, key, false);
        await syncDirectory(dirname(destination));
        return { status: "stored", size: actual.size, checksum };
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        return await this.verifyExisting(key, destination, checksum);
      } finally {
        this.endPublication(destination);
      }
    } finally {
      if (temporary) await temporary.close().catch(() => undefined);
      try {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!hasCode(error, "ENOENT")) throw error;
        });
      } finally {
        activeStagingPaths.delete(temporaryPath);
      }
      if (!sourceComplete) cancelReaderWithoutWaiting(reader);
      reader.releaseLock();
    }
  }

  async open(key: string, requestedRange?: ByteRange): Promise<OpenObject> {
    await this.ready;
    const path = await this.existingObjectPath(key);
    const handle = await openFile(path, constants.O_RDONLY | noFollowFlag());
    try {
      const stats = await handle.stat();
      validateObject(stats, key, this.isPublishing(path));
      const range = validateRange(
        requestedRange ?? { start: 0, endExclusive: stats.size },
        stats.size,
        key,
      );
      return { stream: fileStream(handle, range), size: stats.size, range };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async stat(key: string): Promise<ObjectStat> {
    await this.ready;
    const path = await this.existingObjectPath(key);
    const handle = await openFile(path, constants.O_RDONLY | noFollowFlag());
    try {
      const stats = await handle.stat();
      validateObject(stats, key, this.isPublishing(path));
      return { size: stats.size, modifiedAtMs: stats.mtimeMs };
    } finally {
      await handle.close();
    }
  }

  async existsBatch(keys: readonly string[]): Promise<boolean[]> {
    await this.ready;
    return Promise.all(
      keys.map(async (key) => {
        const parts = validateKey(key);
        const path = join(this.root, ...parts);
        try {
          await this.assertSafePath(parts, key);
          const stats = await lstat(path);
          validateObject(stats, key, this.isPublishing(path));
          return true;
        } catch (error) {
          if (hasCode(error, "ENOENT")) return false;
          throw error;
        }
      }),
    );
  }

  async delete(key: string): Promise<{ deleted: boolean }> {
    await this.ready;
    const parts = validateKey(key);
    const path = join(this.root, ...parts);
    try {
      await this.assertSafePath(parts, key);
      const stats = await lstat(path);
      validateObject(stats, key, this.isPublishing(path));
      await unlink(path);
      await syncDirectory(dirname(path));
      return { deleted: true };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { deleted: false };
      throw error;
    }
  }

  async list(prefix = "", options: ListOptions = {}): Promise<ListResult> {
    await this.ready;
    validatePrefix(prefix);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError(
        "list limit must be an integer from 1 through 1,000",
      );
    }
    if (options.cursor !== undefined) {
      validateKey(options.cursor);
      if (!options.cursor.startsWith(prefix))
        throw new ObjectStorageError(
          "INVALID_KEY",
          "List cursor does not match prefix",
        );
    }

    const matches: string[] = [];
    await this.collectPage(
      this.root,
      "",
      prefix,
      options.cursor,
      limit + 1,
      matches,
    );
    const page = matches.slice(0, limit);
    return {
      keys: page,
      cursor: matches.length > limit ? page.at(-1)! : null,
    };
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStats = await lstat(this.root);
    if (rootStats.isSymbolicLink()) throw symlinkError("<root>");
    validateDirectory(rootStats, "<root>");
    if ((await realpath(this.root)) !== this.root) {
      throw new Error(
        `Object storage root resolves through a symbolic link: ${this.root}`,
      );
    }
    await mkdir(this.tempDirectory, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, "EEXIST")) throw error;
    });
    const tempStats = await lstat(this.tempDirectory);
    if (tempStats.isSymbolicLink()) throw symlinkError(TEMP_DIRECTORY);
    validateDirectory(tempStats, TEMP_DIRECTORY);
    await this.reclaimAbandonedStaging();
  }

  private async reclaimAbandonedStaging(): Promise<void> {
    const entries = await opendir(this.tempDirectory);
    for await (const entry of entries) {
      const path = join(this.tempDirectory, entry.name);
      if (activeStagingPaths.has(path)) continue;
      // Older staging names have no owner; server startup requires exclusive
      // runtime ownership. New names also protect uploads in another live process.
      const match = /^(?:(\d+)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(entry.name);
      if (!match) throw new ObjectStorageError("UNSAFE_PATH", "Unrecognized staging entry");
      const pid = match[1] === undefined ? undefined : Number(match[1]);
      if (pid !== undefined && pid !== process.pid) {
        if (!Number.isSafeInteger(pid) || pid < 1) throw new ObjectStorageError("UNSAFE_PATH", "Invalid staging owner");
        let alive = true;
        try { process.kill(pid, 0); }
        catch (error) {
          if (hasCode(error, "ESRCH")) alive = false;
          else if (!hasCode(error, "EPERM")) throw error;
        }
        if (alive) throw new ObjectStorageError("UNSAFE_PATH",
          "Staging belongs to another live process; object storage requires exclusive runtime ownership");
      }
      try {
        const stats = await lstat(path);
        // A crash between link and unlink leaves two links. Removing staging
        // restores the published object's normal single-link invariant.
        validateObject(stats, entry.name, true);
        await unlink(path);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
    await syncDirectory(this.tempDirectory);
  }

  private async ensureParents(parts: string[], key: string): Promise<void> {
    let current = this.root;
    for (const part of parts) {
      const parent = current;
      current = join(current, part);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) throw symlinkError(key);
        validateDirectory(stats, key);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        await mkdir(current, { mode: 0o700 }).catch((mkdirError: unknown) => {
          if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
        });
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) throw symlinkError(key);
        validateDirectory(stats, key);
        await syncDirectory(parent);
      }
    }
  }

  private async assertSafePath(parts: string[], key: string): Promise<void> {
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw symlinkError(key);
      if (index < parts.length - 1) validateDirectory(stats, key);
    }
  }

  private async existingObjectPath(key: string): Promise<string> {
    const parts = validateKey(key);
    const path = join(this.root, ...parts);
    try {
      await this.assertSafePath(parts, key);
      const stats = await lstat(path);
      validateObject(stats, key, this.isPublishing(path));
      return path;
    } catch (error) {
      if (hasCode(error, "ENOENT"))
        throw new ObjectStorageError(
          "NOT_FOUND",
          `Object not found: ${key}`,
          key,
          { cause: error },
        );
      throw error;
    }
  }

  private async inspectObject(
    path: string,
    key: string,
    missingAllowed: boolean,
  ): Promise<{ size: number } | undefined> {
    try {
      const stats = await lstat(path);
      validateObject(stats, key, this.isPublishing(path));
      return { size: stats.size };
    } catch (error) {
      if (missingAllowed && hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async verifyExisting(
    key: string,
    path: string,
    checksum: string,
    knownSize?: number,
  ): Promise<PutResult> {
    const actual = await hashFile(path, key, this.isPublishing(path));
    if (actual.checksum !== checksum) {
      throw new ObjectStorageError(
        "OBJECT_CONFLICT",
        `An object already exists at ${key} with a different checksum`,
        key,
      );
    }
    return {
      status: "already-present",
      size: knownSize ?? actual.size,
      checksum,
    };
  }

  private async collectPage(
    directory: string,
    keyPrefix: string,
    requestedPrefix: string,
    cursor: string | undefined,
    maximum: number,
    output: string[],
  ): Promise<void> {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (!keyPrefix && entry.name === TEMP_DIRECTORY) continue;
      const key = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw symlinkError(key);
      if (stats.isDirectory()) {
        validateDirectory(stats, key);
        if (prefixesCanOverlap(key, requestedPrefix)) {
          await this.collectPage(
            path,
            key,
            requestedPrefix,
            cursor,
            maximum,
            output,
          );
        }
      } else if (stats.isFile()) {
        validateObject(stats, key, this.isPublishing(path));
        if (
          key.startsWith(requestedPrefix) &&
          (cursor === undefined || compareNames(key, cursor) > 0)
        ) {
          output.push(key);
          output.sort(compareNames);
          if (output.length > maximum) output.pop();
        }
      } else {
        throw new ObjectStorageError(
          "NOT_REGULAR_FILE",
          `Unsupported object-store entry: ${key}`,
          key,
        );
      }
    }
  }

  private beginPublication(path: string): void {
    this.activePublications.set(
      path,
      (this.activePublications.get(path) ?? 0) + 1,
    );
  }

  private endPublication(path: string): void {
    const remaining = (this.activePublications.get(path) ?? 1) - 1;
    if (remaining === 0) this.activePublications.delete(path);
    else this.activePublications.set(path, remaining);
  }

  private isPublishing(path: string): boolean {
    return this.activePublications.has(path);
  }
}

function validateKey(key: string): string[] {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new ObjectStorageError(
      "INVALID_KEY",
      `Invalid object key: ${JSON.stringify(key)}`,
      key,
    );
  }
  const parts = key.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] === TEMP_DIRECTORY
  ) {
    throw new ObjectStorageError(
      "INVALID_KEY",
      `Invalid object key: ${JSON.stringify(key)}`,
      key,
    );
  }
  return parts;
}

function validatePrefix(prefix: string): void {
  if (prefix === "") return;
  validateKey(prefix);
}

function validateChecksum(checksum: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
    throw new ObjectStorageError(
      "INVALID_CHECKSUM",
      "Expected checksum must be a 64-character SHA-256 hex digest",
    );
  }
  return checksum.toLowerCase();
}

function validateRange(range: ByteRange, size: number, key: string): ByteRange {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.endExclusive) ||
    range.start < 0 ||
    range.endExclusive < range.start ||
    range.endExclusive > size
  ) {
    throw new ObjectStorageError(
      "RANGE_NOT_SATISFIABLE",
      `Range [${range.start}, ${range.endExclusive}) is invalid for a ${size}-byte object`,
      key,
    );
  }
  return { start: range.start, endExclusive: range.endExclusive };
}

function fileStream(
  handle: FileHandle,
  range: ByteRange,
): ReadableStream<Uint8Array> {
  let position = range.start;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const remaining = range.endExclusive - position;
        if (remaining === 0) {
          await close();
          controller.close();
          return;
        }
        const buffer = new Uint8Array(Math.min(IO_CHUNK_SIZE, remaining));
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          position,
        );
        if (bytesRead === 0)
          throw new Error("Object was truncated while being read");
        position += bytesRead;
        controller.enqueue(
          bytesRead === buffer.byteLength
            ? buffer
            : buffer.subarray(0, bytesRead),
        );
      } catch (error) {
        await close().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (bytesWritten === 0)
      throw new Error("Unable to make progress writing object");
    offset += bytesWritten;
  }
}

function copyIncomingRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
): Uint8Array {
  try {
    const source = new Uint8Array(
      bytes.buffer,
      bytes.byteOffset + offset,
      length,
    );
    const owned = new Uint8Array(length);
    owned.set(source);
    return owned;
  } catch (error) {
    throw new TypeError(
      "Object stream chunk changed size while being consumed",
      { cause: error },
    );
  }
}

async function hashFile(
  path: string,
  key: string,
  allowPublicationLink: boolean,
): Promise<{ checksum: string; size: number }> {
  const handle = await openFile(path, constants.O_RDONLY | noFollowFlag());
  const hash = createHash("sha256");
  const buffer = new Uint8Array(IO_CHUNK_SIZE);
  let size = 0;
  try {
    const stats = await handle.stat();
    validateObject(stats, key, allowPublicationLink);
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { checksum: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await openFile(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function symlinkError(key: string): ObjectStorageError {
  return new ObjectStorageError(
    "SYMLINK",
    `Symbolic links are not permitted in object storage: ${key}`,
    key,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function cancelReaderWithoutWaiting(reader: {
  cancel(reason?: unknown): Promise<void>;
}): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is advisory; storage cleanup has already completed.
  }
}

function cancelStreamWithoutWaiting(stream: ReadableStream<Uint8Array>): void {
  try {
    void stream.cancel().catch(() => undefined);
  } catch {
    // A locked or hostile source must not delay an idempotent result.
  }
}

function validateDirectory(stats: Stats, key: string): void {
  if (!stats.isDirectory())
    throw new ObjectStorageError(
      "NOT_REGULAR_FILE",
      `Object parent is not a directory: ${key}`,
      key,
    );
  validateOwnershipAndMode(stats, key, 0o700);
}

function validateObject(
  stats: Stats,
  key: string,
  allowPublicationLink: boolean,
): void {
  if (stats.isSymbolicLink()) throw symlinkError(key);
  if (!stats.isFile())
    throw new ObjectStorageError(
      "NOT_REGULAR_FILE",
      `Object is not a regular file: ${key}`,
      key,
    );
  validateOwnershipAndMode(stats, key, 0o600);
  const maximumLinks = allowPublicationLink ? 2 : 1;
  if (stats.nlink < 1 || stats.nlink > maximumLinks) {
    throw new ObjectStorageError(
      "UNSAFE_PATH",
      `Unsafe hard-link count for object: ${key}`,
      key,
    );
  }
}

function validateOwnershipAndMode(
  stats: Stats,
  key: string,
  expectedMode: number,
): void {
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    (currentUid !== undefined && stats.uid !== currentUid) ||
    (stats.mode & 0o777) !== expectedMode
  ) {
    throw new ObjectStorageError(
      "UNSAFE_PATH",
      `Unsafe owner or permissions for object-store path: ${key}`,
      key,
    );
  }
}

function prefixesCanOverlap(
  directoryKey: string,
  requestedPrefix: string,
): boolean {
  return (
    requestedPrefix === "" ||
    directoryKey.startsWith(requestedPrefix) ||
    requestedPrefix.startsWith(`${directoryKey}/`)
  );
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
