export const IGNORE_FILE = ".nanosyncignore";

/** Pure local-only ignore policy. Input is decoded UTF-8 text; loading, byte
 * limits, file identity checks, and recovery signatures belong to adapters. */
export class IgnoreMatcher {
  private readonly patterns: { regex: RegExp; directory: boolean }[] = [];
  constructor(text: string) {
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
