import { lstat, mkdir, readdir, stat as fsStat } from "node:fs/promises";
import { dirname, normalize, relative, resolve, sep } from "node:path";

export interface FileStat {
  size: number;
  mtime: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export type FileData = string | Uint8Array | ReadableStream<Uint8Array>;

export interface Filesystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  writeFile(path: string, data: FileData): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStat>;
  getHash(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

type MockEntry =
  | { kind: "directory"; mtime: number }
  | { kind: "file"; data: Uint8Array; mtime: number };

export class MockFilesystem implements Filesystem {
  private readonly entries = new Map<string, MockEntry>([
    ["/", { kind: "directory", mtime: Date.now() }],
  ]);

  constructor(files: Record<string, string | Uint8Array> = {}) {
    for (const [path, data] of Object.entries(files)) {
      this.setFile(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    }
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
    const entry = this.getEntry(path);
    if (entry.kind !== "file") throw filesystemError("EISDIR", path);

    const data = entry.data.slice();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }

  async writeFile(path: string, data: FileData): Promise<void> {
    this.setFile(path, await toBytes(data));
  }

  async listDirectory(path: string): Promise<string[]> {
    const directory = mockPath(path);
    const entry = this.getEntry(directory);
    if (entry.kind !== "directory") throw filesystemError("ENOTDIR", path);

    const prefix = directory === "/" ? "/" : `${directory}/`;
    const children = new Set<string>();
    for (const candidate of this.entries.keys()) {
      if (candidate.startsWith(prefix)) {
        const child = candidate.slice(prefix.length).split("/", 1)[0];
        if (child) children.add(child);
      }
    }
    return [...children].sort();
  }

  async stat(path: string): Promise<FileStat> {
    const entry = this.getEntry(path);
    const isFile = entry.kind === "file";
    return {
      size: isFile ? entry.data.byteLength : 0,
      mtime: entry.mtime,
      isFile: () => isFile,
      isDirectory: () => !isFile,
    };
  }

  async getHash(path: string): Promise<string> {
    const entry = this.getEntry(path);
    if (entry.kind !== "file") throw filesystemError("EISDIR", path);
    return sha256(entry.data);
  }

  async exists(path: string): Promise<boolean> {
    return this.entries.has(mockPath(path));
  }

  private getEntry(path: string): MockEntry {
    const entry = this.entries.get(mockPath(path));
    if (!entry) throw filesystemError("ENOENT", path);
    return entry;
  }

  private setFile(path: string, data: Uint8Array): void {
    const normalized = mockPath(path);
    if (normalized === "/") throw filesystemError("EISDIR", path);
    if (this.entries.get(normalized)?.kind === "directory") {
      throw filesystemError("EISDIR", path);
    }

    const now = Date.now();
    let parent = dirname(normalized);
    while (!this.entries.has(parent)) {
      this.entries.set(parent, { kind: "directory", mtime: now });
      if (parent === "/") break;
      parent = dirname(parent);
    }
    if (this.entries.get(parent)?.kind === "file") throw filesystemError("ENOTDIR", parent);
    this.entries.set(normalized, { kind: "file", data: data.slice(), mtime: now });
  }
}

export class BunFilesystem implements Filesystem {
  private readonly root: string;

  constructor(root = ".") {
    this.root = resolve(root);
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
    return Bun.file(await this.resolveExistingPath(path)).stream();
  }

  async writeFile(path: string, data: FileData): Promise<void> {
    const destination = this.resolvePath(path);
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true });
    await this.assertNoSymlinks(destination, path, true);

    if (data instanceof ReadableStream) {
      await Bun.write(destination, new Response(data));
    } else {
      await Bun.write(destination, data);
    }
  }

  async listDirectory(path: string): Promise<string[]> {
    return (await readdir(await this.resolveExistingPath(path))).sort();
  }

  async stat(path: string): Promise<FileStat> {
    const stats = await fsStat(await this.resolveExistingPath(path));
    return {
      size: stats.size,
      mtime: stats.mtimeMs,
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
    };
  }

  async getHash(path: string): Promise<string> {
    return sha256(new Uint8Array(await Bun.file(await this.resolveExistingPath(path)).arrayBuffer()));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolveExistingPath(path);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private resolvePath(path: string): string {
    const relativePath = path.replaceAll("\\", "/").replace(/^\/+/, "");
    const resolved = resolve(this.root, relativePath);
    this.assertContained(resolved, path);
    return resolved;
  }

  private async resolveExistingPath(path: string): Promise<string> {
    const resolved = this.resolvePath(path);
    await this.assertNoSymlinks(resolved, path, false);
    return resolved;
  }

  private async assertNoSymlinks(resolved: string, path: string, allowMissingLeaf: boolean): Promise<void> {
    const fromRoot = relative(this.root, resolved);
    const parts = fromRoot ? fromRoot.split(sep) : [];
    let current = this.root;

    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]!);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Path contains a symbolic link: ${path}`);
        }
      } catch (error) {
        if (allowMissingLeaf && index === parts.length - 1 && isNotFound(error)) return;
        throw error;
      }
    }
  }

  private assertContained(resolved: string, path: string): void {
    const fromRoot = relative(this.root, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error(`Path escapes filesystem root: ${path}`);
    }
  }
}

async function toBytes(data: FileData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data.slice();
  return new Uint8Array(await new Response(data).arrayBuffer());
}

function mockPath(path: string): string {
  const normalized = normalize(`/${path}`).replaceAll("\\", "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function sha256(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

function filesystemError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code, path });
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
