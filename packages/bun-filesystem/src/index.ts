import { lstat, mkdir, readdir, stat as fsStat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { FileData, Filesystem, FileStat } from "core";

export interface NanosyncServerConfig {
  port: number;
}

export function startServer({ port }: NanosyncServerConfig) {
  return Bun.serve({
    port,
    routes: {},
  });
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
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(new Uint8Array(await Bun.file(await this.resolveExistingPath(path)).arrayBuffer()));
    return hasher.digest("hex");
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

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
