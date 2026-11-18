import { AsyncLocalStorage } from 'node:async_hooks';
import { stripVTControlCharacters } from 'node:util';
import picocolors from 'picocolors';
import ora, { type Ora } from 'ora';
import { formatHumanResult } from './human-results.ts';

const context = new AsyncLocalStorage<CliOutput>();

export function terminalStyle(stream: NodeJS.WriteStream, env = process.env) {
  const terminal = !!stream.isTTY && env.TERM !== 'dumb';
  return { color: terminal && env.NO_COLOR === undefined, animation: terminal };
}

export function readable(message: string): string {
  return stripVTControlCharacters(message)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, '');
}

export class CliOutput {
  command = '';
  private spinner: Ora | undefined;
  private lastProgress: string | undefined;
  private lastRevision: string | undefined;
  private lastSyncError: string | undefined;

  constructor(readonly json: boolean) {}

  get promptStream() { return this.json ? process.stderr : process.stdout; }

  stop() { this.spinner?.stop(); }

  info(message: string) {
    this.stop();
    if (this.json) console.error(message);
    else console.log(readable(message));
  }

  warning(message: string) {
    if (this.json) { this.info(message); return; }
    const colors = picocolors.createColors(terminalStyle(process.stdout).color);
    this.stop();
    console.log(colors.yellow(`Warning: ${readable(message)}`));
  }

  progress(message: string) {
    if (this.json) return;
    const safe = readable(message);
    if (terminalStyle(process.stdout).animation) {
      this.spinner ??= ora({
        stream: process.stdout, isEnabled: true, discardStdin: false,
        color: terminalStyle(process.stdout).color ? 'cyan' : false,
      });
      this.spinner.text = safe;
      this.spinner.start();
    } else if (safe !== this.lastProgress) console.log(safe);
    this.lastProgress = safe;
  }

  syncProgress(message: string, watch: boolean) {
    if (this.json) this.info(JSON.stringify({ event: 'sync-progress', message }));
    else if (!watch || terminalStyle(process.stdout).animation) this.progress(message);
  }

  synced(head: { revisionId: string; sequence: number }) {
    if (this.json) { this.info(JSON.stringify({ event: 'synced', head })); return; }
    if (head.revisionId !== this.lastRevision || this.lastSyncError) {
      this.info(`Synced revision ${head.revisionId} (sequence ${head.sequence}). Watching for changes…`);
    } else this.stop();
    this.lastRevision = head.revisionId;
    this.lastSyncError = undefined;
  }

  syncError(error: unknown) {
    const message = error instanceof Error ? error.message : 'sync failed';
    if (this.json) { this.info(JSON.stringify({ event: 'sync-error', message })); return; }
    if (message !== this.lastSyncError) this.warning(`Sync failed: ${message}`);
    else this.stop();
    this.lastSyncError = message;
  }

  async prompt<T>(operation: () => Promise<T>): Promise<T> {
    const resume = this.spinner?.isSpinning;
    this.stop();
    const result = await operation();
    if (resume) this.spinner?.start();
    return result;
  }

  result(data: unknown, code: string) {
    this.stop();
    if (this.json) { console.log(JSON.stringify({ ok: true, code, data })); return; }
    const colors = picocolors.createColors(terminalStyle(process.stdout).color);
    const [heading = '', ...details] = formatHumanResult(this.command, data).split('\n');
    console.log([colors.bold(colors.cyan(heading)), ...details].join('\n'));
  }

  error(code: string, message: string, exitCode: number) {
    this.stop();
    if (this.json) { console.error(JSON.stringify({ ok: false, code, message, exitCode })); return; }
    const colors = picocolors.createColors(terminalStyle(process.stdout).color);
    console.log(`${colors.red(`Error [${readable(code)}]:`)} ${readable(message)}`);
  }
}

// Direct library callers retain their existing stderr diagnostics without terminal animation.
const libraryOutput = new CliOutput(true);
export function output(): CliOutput { return context.getStore() ?? libraryOutput; }
export function withOutput<T>(presentation: CliOutput, operation: () => T): T {
  return context.run(presentation, operation);
}
