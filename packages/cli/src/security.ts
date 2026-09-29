import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) mkdirSync(absolute, { mode: 0o700 });
  const st = lstatSync(absolute);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid!() || st.mode & 0o077 || realpathSync(absolute) !== absolute)
    throw new Error("directory must be owned, real, and mode 0700");
  return absolute;
}
export function secureRead(path: string, limit = 4096): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || st.mode & 0o177 || st.size > limit || st.size === 0)
      throw new Error("secret file must be owned, regular, mode 0600 and bounded");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function secureCreate(path: string, value: string): void {
  const parent = privateDirectory(dirname(resolve(path)));
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  syncPrivateDirectory(parent);
}
export function syncPrivateDirectory(path: string): void {
  const fd = openSync(privateDirectory(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Fully fsynced content, then a no-replace publish. Retain an interrupted stage for replay. */
export function secureInstall(path: string, value: string): void {
  const parent = privateDirectory(dirname(resolve(path))), stage = `${path}.stage`;
  if (existsSync(stage)) {
    if (secureRead(stage, Math.max(4096, Buffer.byteLength(value))).toString("utf8") !== value) throw new Error("private installation stage differs; operator inspection required");
  } else secureCreate(stage, value);
  linkSync(stage, path); // EEXIST never replaces credentials (including a symlink).
  syncPrivateDirectory(parent);
  unlinkSync(stage); syncPrivateDirectory(parent);
}
export function provisionSecret(path: string): string {
  if (!existsSync(path)) secureCreate(path, randomBytes(32).toString("hex"));
  const value = secureRead(path, 64).toString("utf8");
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("secret file must contain 32 hex-encoded random bytes");
  return value;
}
