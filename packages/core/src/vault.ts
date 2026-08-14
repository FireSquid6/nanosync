import { deserializeFileMap, serializeFileMap, type FileMap } from "./filemap";
import type { Filesystem } from "./filesystem";
import nodepath from "path";


export const SIMPLESYNC_DIR = ".simplesync";
export const FILEMAP_PATH = nodepath.join(SIMPLESYNC_DIR, "filemap.json");

export class ServerVault {
  private queue = Promise.resolve();
  private fs: Filesystem;

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;

    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
  }

  constructor(filesystem: Filesystem) {
    this.fs = filesystem;
  }


  async readFile(filepath: string) {
    return this.exclusive(async () => {
      if (!isLegalPath(filepath)) {
        throw new Error(`${filepath} is an illegal path`);
      }
      if (await this.fs.exists(filepath)) {
        return await this.fs.readFile(filepath);
      }
    });
  }

  async writeFile(filepath: string, data: string | ReadableStream<Uint8Array>) {
    return this.exclusive(async () => {
      const fileMap = await this.getFileMap();
      await this.fs.writeFile(filepath, data);

      const newHash = await this.fs.getHash(filepath);
      const newTime = (new Date()).toISOString();

      fileMap[filepath] = {
        hash: newHash,
        lastEdited: newTime,
      }

      await this.setFileMap(fileMap);
    });

  }

  async listDirectory(filepath: string, recursive: boolean = false) {
    return this.exclusive(async () => {
      if (!isLegalPath(filepath)) {
        throw new Error(`${filepath} is an illegal path`);
      }

      const entries = (await this.fs.listDirectory(filepath)).filter((entry) =>
        isLegalPath(nodepath.join(filepath, entry))
      );
      if (!recursive) {
        return entries;
      }

      const result: string[] = [];
      const pending = entries.map((entry) => ({ path: entry, fullPath: nodepath.join(filepath, entry) })).reverse();
      while (pending.length > 0) {
        const entry = pending.pop()!;
        result.push(entry.path);
        if ((await this.fs.stat(entry.fullPath)).isDirectory()) {
          const children = (await this.fs.listDirectory(entry.fullPath)).filter((child) =>
            isLegalPath(nodepath.join(entry.fullPath, child))
          );
          for (let index = children.length - 1; index >= 0; index--) {
            const child = children[index]!;
            pending.push({
              path: nodepath.join(entry.path, child),
              fullPath: nodepath.join(entry.fullPath, child),
            });
          }
        }
      }
      return result;
    });
  }

  private async getFileMap(): Promise<FileMap> {
    // ugly, but we have to deal with this for the case where we have big files to stream back
    const data = await (await this.fs.readFile(FILEMAP_PATH)).text();
    const fileMap = deserializeFileMap(data);
    return fileMap;
  }

  private async setFileMap(fileMap: FileMap) {
    const serialized = serializeFileMap(fileMap);
    await this.fs.writeFile(FILEMAP_PATH, serialized);
  }

}

function isLegalPath(path: string): boolean {
  const normalized = nodepath.normalize(path).replaceAll("\\", "/");
  const parts = normalized.split("/");
  while (parts[0] === "") {
    parts.shift();
  }

  if (parts[0] === ".." || parts[0] === SIMPLESYNC_DIR) {
    return false;
  }

  return true;
}
