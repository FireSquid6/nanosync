import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { IGNORE_FILE, IgnoreMatcher } from "@nanosync/sync-core";
export { IGNORE_FILE } from "@nanosync/sync-core";

/** Local-only root control file. Patterns are deliberately one-way (no negation). */
export class IgnoreRules {
  readonly signature: string;
  private readonly matcher: IgnoreMatcher;
  constructor(root: string) {
    const path = join(root, IGNORE_FILE);
    let stat: Stats;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.signature = "absent"; this.matcher = new IgnoreMatcher(""); return;
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
    this.matcher = new IgnoreMatcher(text);
  }
  ignores(path: string, directory = false): boolean {
    return this.matcher.ignores(path, directory);
  }
}
