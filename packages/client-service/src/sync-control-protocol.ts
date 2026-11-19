import { timingSafeEqual } from 'node:crypto';
import { parseRevisionId, PROTOCOL_ERROR_CODES } from '@nanosync/protocol';
import { RemoteError } from '@nanosync/sync-core';
import { ClientError } from './errors.ts';
import type { SyncEvent } from './events.ts';

export const MAX_BODY = 16384;
export const MAX_FRAME = 2048;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const NONCE = /^[0-9a-f]{32}$/;
export type Head = { revisionId: string; sequence: number };
export type Operation = 'sync' | 'watch' | 'stop-for-removal';
export type ControlRequest = {
  version: 1; id: string; root: string; binding: string; instance: string; operation: Operation;
};
export type Outcome = {
  head: Head | null; events: SyncEvent[]; error: { code: string; exitCode: number } | null;
};
const LOCAL_ERRORS = {
  OWNER_UNAVAILABLE: 'Sync owner unavailable; stop it and retry with a compatible client.',
  OWNER_TEMPORARY: 'A temporary sync owns this folder; retry watch after it finishes or start continuous sync in its owner.',
  OWNER_STOPPED: 'Sync owner stopped; explicitly start syncing again.',
  OWNER_BUSY: 'Sync owner is busy; retry the request.',
  OPERATION_FAILED: 'Synchronization failed; inspect the owning client and retry.',
};
export function failure(code: keyof typeof LOCAL_ERRORS): ClientError {
  return new ClientError(code, LOCAL_ERRORS[code]);
}
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw failure('OWNER_UNAVAILABLE');
  return value as Record<string, unknown>;
}
export function authorized(value: string | null, capability: string): boolean {
  const candidate = value ?? '';
  return /^[0-9a-f]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate), Buffer.from(capability));
}
export function event(value: unknown): SyncEvent {
  if (value && typeof value === 'object' && 'type' in value && value.type === 'transfer') {
    const transfer = object(value, ['type', 'direction', 'count', 'bytes']);
    if (!['upload', 'download'].includes(transfer.direction as string) ||
        !Number.isSafeInteger(transfer.count) || (transfer.count as number) < 0 ||
        !Number.isSafeInteger(transfer.bytes) || (transfer.bytes as number) < 0)
      throw failure('OWNER_UNAVAILABLE');
  } else {
    const phase = object(value, ['type']);
    if (!['checking', 'scanning', 'complete'].includes(phase.type as string))
      throw failure('OWNER_UNAVAILABLE');
  }
  return value as SyncEvent;
}
export function progressResponse(onFinish: () => void) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let latest: Uint8Array | undefined, terminal: Uint8Array | undefined;
  let finished = false, completed = false;
  const encode = (type: 'event' | 'result', value: unknown): Uint8Array => {
    const frame = new TextEncoder().encode(JSON.stringify({ type, value }) + '\n');
    if (frame.length > MAX_FRAME) throw failure('OWNER_UNAVAILABLE');
    return frame;
  };
  const finish = () => {
    if (finished) return;
    finished = true; latest = undefined; terminal = undefined;
    onFinish();
  };
  const flush = () => {
    if (finished) return;
    // Bun's HTTP consumer can pull synchronously from enqueue: clear pending state first.
    if (latest && (controller.desiredSize ?? 0) > 0) {
      const frame = latest;
      latest = undefined;
      controller.enqueue(frame);
    }
    if (terminal && (controller.desiredSize ?? 0) > 0) {
      const frame = terminal;
      terminal = undefined;
      controller.enqueue(frame);
      controller.close();
      finish();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, pull: flush, cancel: finish,
  }, { highWaterMark: 1 });
  return {
    body,
    publish(value: SyncEvent) {
      if (finished || completed) return;
      latest = encode('event', event(value));
      flush();
    },
    complete(value: unknown) {
      if (finished || completed) return;
      terminal = encode('result', outcome(value));
      completed = true;
      flush();
    },
    fail() {
      if (finished) return;
      controller.error(failure('OWNER_UNAVAILABLE'));
      finish();
    },
  };
}
export async function streamedOutcome(
  body: ReadableStream<Uint8Array> | null, onEvent?: (event: SyncEvent) => void,
): Promise<Outcome> {
  if (!body) throw failure('OWNER_UNAVAILABLE');
  const reader = body.getReader();
  let size = 0, buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let completed: Outcome | undefined;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let offset = 0;
      while (offset < chunk.value.length) {
        if (completed) throw failure('OWNER_UNAVAILABLE');
        const newline = chunk.value.indexOf(10, offset);
        const end = newline < 0 ? chunk.value.length : newline;
        size += end - offset + (newline < 0 ? 0 : 1);
        if (size > MAX_FRAME) throw failure('OWNER_UNAVAILABLE');
        buffer += decoder.decode(chunk.value.subarray(offset, end), { stream: true });
        offset = end + 1;
        if (newline < 0) break;
        buffer += decoder.decode();
        const frame = object(JSON.parse(buffer), ['type', 'value']);
        buffer = ''; size = 0;
        if (frame.type === 'event') {
          const checked = event(frame.value);
          onEvent?.(checked);
        } else if (frame.type === 'result') completed = outcome(frame.value);
        else throw failure('OWNER_UNAVAILABLE');
      }
    }
    if (!completed || size) throw failure('OWNER_UNAVAILABLE');
    return completed;
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
export async function boundedJson(
  body: ReadableStream<Uint8Array> | null, signal?: AbortSignal,
): Promise<unknown> {
  if (!body) throw failure('OWNER_UNAVAILABLE');
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_BODY) throw failure('OWNER_UNAVAILABLE');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel(); reader.releaseLock();
  }
}
export function request(value: unknown): ControlRequest {
  const record = object(value, ['version', 'id', 'root', 'binding', 'instance', 'operation']);
  if (record.version !== 1 || typeof record.id !== 'string' || !UUID.test(record.id) ||
      typeof record.root !== 'string' || record.root.length > 4096 ||
      typeof record.binding !== 'string' || !UUID.test(record.binding) ||
      typeof record.instance !== 'string' || !UUID.test(record.instance) ||
      !['sync', 'watch', 'stop-for-removal'].includes(record.operation as string))
    throw failure('OWNER_UNAVAILABLE');
  return record as ControlRequest;
}
export function safeError(error: unknown): Outcome['error'] {
  if (error instanceof RemoteError && (PROTOCOL_ERROR_CODES as readonly string[]).includes(error.code))
    return { code: error.code, exitCode: 5 };
  if (error instanceof ClientError && Object.hasOwn(LOCAL_ERRORS, error.code))
    return { code: error.code, exitCode: 2 };
  return { code: 'OPERATION_FAILED', exitCode: 2 };
}
export function outcome(value: unknown): Outcome {
  const record = object(value, ['head', 'events', 'error']);
  if (record.head !== null) {
    const head = object(record.head, ['revisionId', 'sequence']);
    parseRevisionId(head.revisionId);
    if (!Number.isSafeInteger(head.sequence) || (head.sequence as number) < 0)
      throw failure('OWNER_UNAVAILABLE');
  }
  if (!Array.isArray(record.events) || record.events.length > 64) throw failure('OWNER_UNAVAILABLE');
  for (const item of record.events) event(item);
  if (record.error !== null) {
    const error = object(record.error, ['code', 'exitCode']);
    const local = typeof error.code === 'string' && Object.hasOwn(LOCAL_ERRORS, error.code);
    const remote = (PROTOCOL_ERROR_CODES as readonly unknown[]).includes(error.code);
    if (!(local && error.exitCode === 2) && !(remote && error.exitCode === 5))
      throw failure('OWNER_UNAVAILABLE');
  }
  if ((record.head === null) === (record.error === null)) throw failure('OWNER_UNAVAILABLE');
  return record as Outcome;
}
export function result(value: Outcome, onEvent?: (event: SyncEvent) => void): Head {
  for (const event of value.events) onEvent?.(event);
  if (value.error) {
    if (value.error.exitCode === 5)
      throw new ClientError(value.error.code, 'Remote synchronization failed; inspect the owning client and retry.', 5);
    throw failure(value.error.code as keyof typeof LOCAL_ERRORS);
  }
  return value.head!;
}
