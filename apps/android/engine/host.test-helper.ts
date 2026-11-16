// Real filesystem host for adapter contract tests; never imported by index.ts.
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmdirSync, statSync, lstatSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { install, type RunContext } from "./runtime.ts";
import type { NativeHost } from "./bridge.ts";
import type { Metadata } from "./journal.ts";
// Native HTTP runs outside the WebView: its wire transport must not inherit a
// simulated legacy WebView Request constructor installed by compatibility tests.
const WireRequest = globalThis.Request;
export class TestHost implements NativeHost {
  readonly target: { Nanosync?: unknown; NanosyncBridge?: { complete(id: string, result: unknown): void } } = {};
  readonly runtime: ReturnType<typeof install>;
  calls: { method: string; args: any }[] = [];
  failure?: (method: string, args: any) => void;
  result: any; error?: string; availableBytes = 1e12;
  constructor(readonly root: string, readonly privateRoot: string, readonly http: (request: Request) => Promise<Response>, readonly baseUrl = "http://local") {
    mkdirSync(root, { recursive: true }); mkdirSync(privateRoot, { recursive: true });
    this.runtime = install(this, this.target);
  }
  sync(method: string, json: string): string {
    try {
      const args = JSON.parse(json); let value;
      if (method === "journalRead") value = existsSync(join(this.privateRoot, "state")) ? JSON.parse(readFileSync(join(this.privateRoot, "state"), "utf8")) : {};
      else if (method === "journalWrite") { writeFileSync(join(this.privateRoot, "state.tmp"), JSON.stringify(args.state)); renameSync(join(this.privateRoot, "state.tmp"), join(this.privateRoot, "state")); value = {}; }
      else throw new Error(`unknown sync method ${method}`);
      return JSON.stringify({ ok: true, value });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  }
  request(method: string, json: string, id: string) {
    const args = JSON.parse(json); this.calls.push({ method, args });
    void (async () => {
      try { this.failure?.(method, args); const value = await this.operation(method, args); this.target.NanosyncBridge!.complete(id, { ok: true, value }); }
      catch (e) { this.target.NanosyncBridge!.complete(id, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
    })();
  }
  private metadata(path: string): Metadata {
    const s = lstatSync(join(this.root, path));
    return { path, directory: s.isDirectory(), size: s.size, modified: s.mtimeMs, fileKey: `${s.dev}:${s.ino}`, symlink: s.isSymbolicLink() };
  }
  private checkExpected(path: string, expected: any) {
    if (!expected) throw new Error("unguarded destructive operation");
    const exists = existsSync(join(this.root, path));
    if (expected.missing) { if (exists) throw new Error("destination appeared"); return; }
    const actual = this.metadata(path);
    if (actual.size !== expected.size || actual.modified !== expected.modified) throw new Error("destination changed");
  }
  private async digest(path: string) {
    const hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.alloc(65536); let size = 0;
    try { while (true) { const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); size += count; } }
    finally { closeSync(fd); }
    return { sha256: hash.digest("hex"), size };
  }
  private read(path: string, offset: number, length: number) {
    if (length > 4194304) throw new Error("read exceeds chunk size");
    const fd = openSync(path, "r"), buffer = Buffer.alloc(length); let count;
    try { count = readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); }
    const size = statSync(path).size;
    return { dataBase64: buffer.subarray(0, count).toString("base64"), eof: offset + count >= size, size };
  }
  private async operation(method: string, a: any): Promise<any> {
    const path = a.path === undefined ? "" : join(this.root, a.path), stage = a.id ? join(this.privateRoot, a.id) : "";
    switch (method) {
      case "http": {
        const response = await this.http(new WireRequest(this.baseUrl.replace(/\/$/, "") + a.path, { method: a.method, headers: a.headers, body: a.bodyBase64 ? Buffer.from(a.bodyBase64, "base64") : undefined }));
        return { status: response.status, headers: Object.fromEntries(response.headers), bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64") };
      }
      case "stat": return existsSync(path) ? this.metadata(a.path) : { missing: true };
      case "listDirectory": return readdirSync(path).map(name => this.metadata(a.path ? `${a.path}/${name}` : name));
      case "digest": return { ...await this.digest(path), ...this.metadata(a.path) };
      case "read": return { ...this.read(path, a.offset, a.length), modified: this.metadata(a.path).modified };
      case "stageRead": return this.read(stage, a.offset, a.length);
      case "stageDigest": return this.digest(stage);
      case "stageWrite": {
        const fd = openSync(stage, existsSync(stage) ? "r+" : "w+");
        try { writeSync(fd, Buffer.from(a.dataBase64, "base64"), 0, Buffer.from(a.dataBase64, "base64").length, a.offset); }
        finally { closeSync(fd); } return {};
      }
      case "stageCommit": this.checkExpected(a.path, a.expected); copyFileSync(stage, path); return {};
      case "stageDelete": if (existsSync(stage)) unlinkSync(stage); return {};
      case "mkdir": mkdirSync(path); return {};
      case "remove": this.checkExpected(a.path, a.expected); if (statSync(path).isDirectory()) rmdirSync(path); else unlinkSync(path); return {};
      case "capacity": return { availableBytes: this.availableBytes };
      default: throw new Error(`unknown native method ${method}`);
    }
  }
  event(_json: string) {}
  finish(json: string) { this.result = JSON.parse(json); }
  fail(message: string) { this.error = message; }
  async run(context: RunContext) {
    this.result = undefined; this.error = undefined;
    await this.runtime.run(structuredClone(context));
    if (this.error) throw new Error(this.error);
    if (!this.result) throw new Error("missing result"); return this.result;
  }
}
