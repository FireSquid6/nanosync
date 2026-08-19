import { dirname, normalize } from "node:path";

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
  deleteFile(path: string): Promise<void>;
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

  async deleteFile(path: string): Promise<void> {
    const normalized = mockPath(path);
    const entry = this.getEntry(normalized);
    if (entry.kind !== "file") throw filesystemError("EISDIR", path);
    this.entries.delete(normalized);
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

async function toBytes(data: FileData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data.slice();
  return new Uint8Array(await new Response(data).arrayBuffer());
}

function mockPath(path: string): string {
  const normalized = normalize(`/${path}`).replaceAll("\\", "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function sha256(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice().buffer));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function filesystemError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code, path });
}
