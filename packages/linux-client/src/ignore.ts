import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const IGNORE_FILE = ".nanosyncignore";

/** Local-only root control file. Patterns are deliberately one-way (no negation). */
export class IgnoreRules {
  readonly signature: string;
  private readonly patterns: { regex: RegExp; directory: boolean }[] = [];
  constructor(root: string) {
    const path = join(root, IGNORE_FILE);
    let stat: Stats;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.signature = "absent"; return;
    }
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1 || stat.mode & 0o022 || stat.size > 64 * 1024)
      throw new Error("unsafe .nanosyncignore control file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs)
        throw new Error(".nanosyncignore changed during read");
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
      const after = fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1)
        throw new Error(".nanosyncignore changed during read");
    } finally { closeSync(fd); }
    this.signature = createHash("sha256").update(text).digest("hex");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("!") || line.includes("\\") || line.includes("[")) throw new Error(`unsupported .nanosyncignore pattern: ${line}`);
      const directory = line.endsWith("/");
      const pattern = line.replace(/^\//, "").replace(/\/$/, "");
      if (!pattern || pattern.split("/").some(part => !part || part === "." || part === "..") || pattern.includes("***"))
        throw new Error(`invalid .nanosyncignore pattern: ${line}`);
      const anchored = line.startsWith("/") || pattern.includes("/");
      const glob = pattern.replace(/[.+^${}()|]/g, "\\$&").replace(/\*\*\//g, "\u0001")
        .replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
        .replace(/\u0001/g, "(?:.*/)?").replace(/\u0000/g, ".*");
      this.patterns.push({ regex: new RegExp(`^(?:${anchored ? "" : "(?:.*/)?"}${glob})$`), directory });
    }
  }
  ignores(path: string, directory = false): boolean {
    // The root marker is local connection metadata, never vault content. A
    // user ignore file cannot opt it back into the synchronized tree.
    if (path === IGNORE_FILE || path === ".nanosync") return true;
    const parts = path.split("/");
    return parts.some((_, i) => {
      const prefix = parts.slice(0, i + 1).join("/");
      return this.patterns.some(rule => (!rule.directory || i < parts.length - 1 || directory) && rule.regex.test(prefix));
    });
  }
}
