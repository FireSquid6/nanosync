import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const IGNORE_FILE = '.nanosyncignore';
export const ignoreStage = /^\.nanosyncignore\.[0-9a-f]{32}\.stage$/;
export class IgnoreError extends Error {
  constructor(
    readonly code: 'IGNORE_INVALID' | 'CONFLICT',
    readonly line = 0,
  ) {
    super(
      code === 'CONFLICT'
        ? 'Ignore rules changed; refresh before saving.'
        : `Invalid ignore rules at line ${line}; use the exclusions-only syntax.`,
    );
  }
}
function patterns(text: string) {
  if (
    Buffer.byteLength(text) > 65536 ||
    text !== new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(text))
  )
    throw new IgnoreError('IGNORE_INVALID');
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return [];
    if (line.startsWith('!') || line.includes('\\') || line.includes('['))
      throw new IgnoreError('IGNORE_INVALID', index + 1);
    const directory = line.endsWith('/');
    const pattern = line.replace(/^\//, '').replace(/\/$/, '');
    if (
      !pattern ||
      pattern.split('/').some((part) => !part || part === '.' || part === '..') ||
      pattern.includes('***')
    )
      throw new IgnoreError('IGNORE_INVALID', index + 1);
    const anchored = line.startsWith('/') || pattern.includes('/');
    const glob = pattern
      .replace(/[.+^${}()|]/g, '\\$&')
      .replace(/\*\*\//g, '\u0001')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0001/g, '(?:.*/)?')
      .replace(/\u0000/g, '.*');
    return [
      {
        regex: new RegExp(`^(?:${anchored ? '' : '(?:.*/)?'}${glob})$`),
        directory,
      },
    ];
  });
}
export function validateIgnoreText(
  text: string,
): { valid: true } | { valid: false; code: string; line: number } {
  try {
    patterns(text);
    return { valid: true };
  } catch (error) {
    if (error instanceof IgnoreError) return { valid: false, code: error.code, line: error.line };
    throw error;
  }
}
export function readIgnoreFile(
  path: string,
  protectedInput = false,
): { text: string; fileSignature: string } {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (!protectedInput && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return { text: '', fileSignature: 'absent' };
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid!() ||
    stat.nlink !== 1 ||
    stat.mode & (protectedInput ? 0o177 : 0o022) ||
    stat.size > 65536
  )
    throw new Error('unsafe ignore input file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = fstatSync(fd);
    if (
      !current.isFile() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.size !== stat.size ||
      current.mtimeMs !== stat.mtimeMs ||
      current.ctimeMs !== stat.ctimeMs
    )
      throw new Error('ignore file changed during read');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd));
    const after = fstatSync(fd);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.nlink !== 1
    )
      throw new Error('ignore file changed during read');
    return {
      text,
      fileSignature: createHash('sha256').update(text).digest('hex'),
    };
  } finally {
    closeSync(fd);
  }
}
/** Local-only root control file. Patterns are deliberately one-way (no negation). */
export class IgnoreRules {
  readonly signature: string;
  private readonly patterns;
  constructor(root: string) {
    const input = readIgnoreFile(join(root, IGNORE_FILE));
    this.signature = input.fileSignature;
    this.patterns = patterns(input.text);
  }
  ignores(path: string, directory = false): boolean {
    if (path === IGNORE_FILE || path === '.nanosync' || ignoreStage.test(path)) return true;
    const parts = path.split('/');
    return parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join('/');
      return this.patterns.some(
        (rule) =>
          (!rule.directory || index < parts.length - 1 || directory) && rule.regex.test(prefix),
      );
    });
  }
}
/** Caller owns the replica and checks the saved root before entering this synchronous commit. */
export function saveIgnoreFile(
  root: string,
  text: string,
  expected: string,
  checkpoint?: (phase: string) => void,
): string {
  patterns(text);
  if (!/^(absent|[0-9a-f]{64})$/.test(expected)) throw new IgnoreError('IGNORE_INVALID');
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const anchor = `/proc/self/fd/${fd}`;
  const checkedRoot = () => {
    const current = lstatSync(root),
      opened = fstatSync(fd);
    if (
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      !current.isDirectory() ||
      current.uid !== process.getuid!()
    )
      throw new Error('sync root changed');
  };
  const target = join(anchor, IGNORE_FILE),
    stage = join(anchor, `${IGNORE_FILE}.${randomBytes(16).toString('hex')}.stage`);
  let staged: Stats | undefined;
  try {
    checkedRoot();
    if (readIgnoreFile(target).fileSignature !== expected) throw new IgnoreError('CONFLICT');
    for (const name of readdirSync(anchor).filter((name) => ignoreStage.test(name))) {
      const path = join(anchor, name),
        stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        stat.nlink !== 1 ||
        stat.mode & 0o177 ||
        stat.size > 65536
      )
        throw new Error('unsafe ignore stage; inspect preserved control file');
      unlinkSync(path);
    }
    const output = openSync(
      stage,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      staged = fstatSync(output);
      writeFileSync(output, text);
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
    checkpoint?.('ignore-staged');
    checkedRoot();
    if (readIgnoreFile(target).fileSignature !== expected) throw new IgnoreError('CONFLICT');
    const published = lstatSync(stage);
    if (
      published.dev !== staged!.dev ||
      published.ino !== staged!.ino ||
      published.mode & 0o177 ||
      readIgnoreFile(stage).fileSignature !== createHash('sha256').update(text).digest('hex')
    )
      throw new Error('ignore stage changed before commit');
    // POSIX rename is atomic, not a conditional exchange with noncooperating raw-file editors.
    renameSync(stage, target);
    staged = undefined;
    checkpoint?.('ignore-renamed');
    fsyncSync(fd);
    checkedRoot();
    return createHash('sha256').update(text).digest('hex');
  } finally {
    try {
      if (staged) {
        let current: Stats | undefined;
        try {
          current = lstatSync(stage);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (
          current &&
          current.dev === staged.dev &&
          current.ino === staged.ino &&
          current.nlink === 1
        )
          unlinkSync(stage);
      }
    } finally {
      closeSync(fd);
    }
  }
}
