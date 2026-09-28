import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open as openFile,
  readdir,
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
  | "SIZE_LIMIT_EXCEEDED";

export class ObjectStorageError extends Error {
  readonly code: ObjectStorageErrorCode;
  readonly key?: string;

  constructor(code: ObjectStorageErrorCode, message: string, key?: string, options?: ErrorOptions) {
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
  putIfAbsent(key: string, stream: ReadableStream<Uint8Array>, expectedChecksum: string): Promise<PutResult>;
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
const DEFAULT_MAXIMUM_OBJECT_SIZE = 64 * 1024 * 1024 * 1024;
const IO_CHUNK_SIZE = 64 * 1024;

export class LocalFilesystem implements Filesystem {
  private readonly root: string;
  private readonly tempDirectory: string;
  private readonly maximumObjectSize: number;
  private readonly ready: Promise<void>;

  constructor(root: string, options: LocalFilesystemOptions = {}) {
    this.root = resolve(root);
    this.tempDirectory = join(this.root, TEMP_DIRECTORY);
    this.maximumObjectSize = options.maximumObjectSize ?? DEFAULT_MAXIMUM_OBJECT_SIZE;
    if (!Number.isSafeInteger(this.maximumObjectSize) || this.maximumObjectSize < 0) {
      throw new TypeError("maximumObjectSize must be a non-negative safe integer");
    }
    this.ready = this.initialize();
  }

  async putIfAbsent(key: string, source: ReadableStream<Uint8Array>, expectedChecksum: string): Promise<PutResult> {
    await this.ready;
    const parts = validateKey(key);
    const checksum = validateChecksum(expectedChecksum);
    await this.ensureParents(parts.slice(0, -1), key);
    const destination = join(this.root, ...parts);

    const existing = await this.inspectObject(destination, key, true);
    if (existing) return this.verifyExisting(key, destination, checksum, existing.size);

    const temporaryPath = join(this.tempDirectory, randomUUID());
    let temporary: FileHandle | undefined;
    const reader = source.getReader();
    let size = 0;
    let sourceComplete = false;
    try {
      temporary = await openFile(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
        0o600,
      );
      const hash = createHash("sha256");
      while (true) {
        const next = await reader.read();
        if (next.done) {
          sourceComplete = true;
          break;
        }
        if (!(next.value instanceof Uint8Array)) throw new TypeError("Object stream must yield Uint8Array chunks");
        size += next.value.byteLength;
        if (size > this.maximumObjectSize) {
          throw new ObjectStorageError(
            "SIZE_LIMIT_EXCEEDED",
            `Object exceeds the ${this.maximumObjectSize} byte limit`,
            key,
          );
        }
        hash.update(next.value);
        await writeAll(temporary, next.value);
      }
      await temporary.sync();
      await temporary.close();
      temporary = undefined;

      const actualChecksum = hash.digest("hex");
      if (actualChecksum !== checksum) {
        throw new ObjectStorageError(
          "CHECKSUM_MISMATCH",
          `Ciphertext checksum mismatch for ${key}`,
          key,
        );
      }

      try {
        // A hard link is the publication point: unlike rename, it cannot replace destination.
        await link(temporaryPath, destination);
        await syncDirectory(dirname(destination));
        return { status: "stored", size, checksum };
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        return await this.verifyExisting(key, destination, checksum);
      }
    } finally {
      if (!sourceComplete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      if (temporary) await temporary.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }
  }

  async open(key: string, requestedRange?: ByteRange): Promise<OpenObject> {
    await this.ready;
    const path = await this.existingObjectPath(key);
    const handle = await openFile(path, constants.O_RDONLY | noFollowFlag());
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object is not a regular file: ${key}`, key);
      const range = validateRange(requestedRange ?? { start: 0, endExclusive: stats.size }, stats.size, key);
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
      if (!stats.isFile()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object is not a regular file: ${key}`, key);
      return { size: stats.size, modifiedAtMs: stats.mtimeMs };
    } finally {
      await handle.close();
    }
  }

  async existsBatch(keys: readonly string[]): Promise<boolean[]> {
    await this.ready;
    return Promise.all(keys.map(async (key) => {
      const parts = validateKey(key);
      const path = join(this.root, ...parts);
      try {
        await this.assertSafePath(parts, key);
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) throw symlinkError(key);
        if (!stats.isFile()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object is not a regular file: ${key}`, key);
        return true;
      } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      }
    }));
  }

  async delete(key: string): Promise<{ deleted: boolean }> {
    await this.ready;
    const parts = validateKey(key);
    const path = join(this.root, ...parts);
    try {
      await this.assertSafePath(parts, key);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw symlinkError(key);
      if (!stats.isFile()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object is not a regular file: ${key}`, key);
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
      throw new RangeError("list limit must be an integer from 1 through 1,000");
    }
    if (options.cursor !== undefined) {
      validateKey(options.cursor);
      if (!options.cursor.startsWith(prefix)) throw new ObjectStorageError("INVALID_KEY", "List cursor does not match prefix");
    }

    const keys: string[] = [];
    await this.collectKeys(this.root, "", keys);
    const matching = keys
      .filter((key) => key.startsWith(prefix) && (options.cursor === undefined || key > options.cursor))
      .sort();
    const page = matching.slice(0, limit);
    return {
      keys: page,
      cursor: matching.length > limit ? page.at(-1)! : null,
    };
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStats = await lstat(this.root);
    if (rootStats.isSymbolicLink()) throw symlinkError("<root>");
    if (!rootStats.isDirectory()) throw new Error(`Object storage root is not a directory: ${this.root}`);
    if (await realpath(this.root) !== this.root) {
      throw new Error(`Object storage root resolves through a symbolic link: ${this.root}`);
    }
    await chmod(this.root, 0o700);
    await mkdir(this.tempDirectory, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, "EEXIST")) throw error;
    });
    const tempStats = await lstat(this.tempDirectory);
    if (tempStats.isSymbolicLink()) throw symlinkError(TEMP_DIRECTORY);
    if (!tempStats.isDirectory()) throw new Error(`Temporary object path is not a directory: ${this.tempDirectory}`);
    await chmod(this.tempDirectory, 0o700);
  }

  private async ensureParents(parts: string[], key: string): Promise<void> {
    let current = this.root;
    for (const part of parts) {
      const parent = current;
      current = join(current, part);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) throw symlinkError(key);
        if (!stats.isDirectory()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object parent is not a directory: ${key}`, key);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        await mkdir(current, { mode: 0o700 }).catch((mkdirError: unknown) => {
          if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
        });
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) throw symlinkError(key);
        if (!stats.isDirectory()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object parent is not a directory: ${key}`, key);
        await syncDirectory(parent);
      }
    }
  }

  private async assertSafePath(parts: string[], key: string): Promise<void> {
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw symlinkError(key);
    }
  }

  private async existingObjectPath(key: string): Promise<string> {
    const parts = validateKey(key);
    const path = join(this.root, ...parts);
    try {
      await this.assertSafePath(parts, key);
      const stats = await lstat(path);
      if (!stats.isFile()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object is not a regular file: ${key}`, key);
      return path;
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new ObjectStorageError("NOT_FOUND", `Object not found: ${key}`, key, { cause: error });
      throw error;
    }
  }

  private async inspectObject(path: string, key: string, missingAllowed: boolean): Promise<{ size: number } | undefined> {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw symlinkError(key);
      if (!stats.isFile()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object is not a regular file: ${key}`, key);
      return { size: stats.size };
    } catch (error) {
      if (missingAllowed && hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async verifyExisting(key: string, path: string, checksum: string, knownSize?: number): Promise<PutResult> {
    const actual = await hashFile(path, key);
    if (actual.checksum !== checksum) {
      throw new ObjectStorageError(
        "OBJECT_CONFLICT",
        `An object already exists at ${key} with a different checksum`,
        key,
      );
    }
    return { status: "already-present", size: knownSize ?? actual.size, checksum };
  }

  private async collectKeys(directory: string, prefix: string, output: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!prefix && entry.name === TEMP_DIRECTORY) continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw symlinkError(key);
      if (stats.isDirectory()) await this.collectKeys(path, key, output);
      else if (stats.isFile()) output.push(key);
      else throw new ObjectStorageError("NOT_REGULAR_FILE", `Unsupported object-store entry: ${key}`, key);
    }
  }
}

function validateKey(key: string): string[] {
  if (!key || key.startsWith("/") || key.includes("\\") || key.includes("\0")) {
    throw new ObjectStorageError("INVALID_KEY", `Invalid object key: ${JSON.stringify(key)}`, key);
  }
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts[0] === TEMP_DIRECTORY) {
    throw new ObjectStorageError("INVALID_KEY", `Invalid object key: ${JSON.stringify(key)}`, key);
  }
  return parts;
}

function validatePrefix(prefix: string): void {
  if (prefix === "") return;
  validateKey(prefix);
}

function validateChecksum(checksum: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
    throw new ObjectStorageError("INVALID_CHECKSUM", "Expected checksum must be a 64-character SHA-256 hex digest");
  }
  return checksum.toLowerCase();
}

function validateRange(range: ByteRange, size: number, key: string): ByteRange {
  if (
    !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.endExclusive)
    || range.start < 0
    || range.endExclusive < range.start
    || range.endExclusive > size
  ) {
    throw new ObjectStorageError(
      "RANGE_NOT_SATISFIABLE",
      `Range [${range.start}, ${range.endExclusive}) is invalid for a ${size}-byte object`,
      key,
    );
  }
  return { start: range.start, endExclusive: range.endExclusive };
}

function fileStream(handle: FileHandle, range: ByteRange): ReadableStream<Uint8Array> {
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
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) throw new Error("Object was truncated while being read");
        position += bytesRead;
        controller.enqueue(bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead));
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
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten === 0) throw new Error("Unable to make progress writing object");
    offset += bytesWritten;
  }
}

async function hashFile(path: string, key: string): Promise<{ checksum: string; size: number }> {
  const handle = await openFile(path, constants.O_RDONLY | noFollowFlag());
  const hash = createHash("sha256");
  const buffer = new Uint8Array(IO_CHUNK_SIZE);
  let size = 0;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new ObjectStorageError("NOT_REGULAR_FILE", `Object is not a regular file: ${key}`, key);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
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
  return new ObjectStorageError("SYMLINK", `Symbolic links are not permitted in object storage: ${key}`, key);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
