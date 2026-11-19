import { notifyHelper } from './notify-helper';
import type { NotificationBatch, NotificationCategory } from '@nanosync/client-service';

declare const NANOSYNC_NOTIFY_PYTHON: string;
declare const NANOSYNC_NOTIFY_TYPELIB: string;
export type NotificationAvailability = {
  available: boolean | null;
  actions: boolean | null;
  code: null | 'NOTIFICATIONS_UNAVAILABLE' | 'NOTIFICATIONS_STATE_INVALID';
};
export function createNativeNotifications(
  reopen: () => void,
  options: {
    python?: string;
    typelibs?: string;
    delivery(batch: NotificationBatch, id: number, dismissed: boolean): void;
  },
) {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let reading: Promise<void> | undefined;
  let sequence = 0,
    epoch = 0,
    stopped = false;
  let status: NotificationAvailability = { available: null, actions: null, code: null };
  const active = new Map<
    NotificationCategory,
    { batch: NotificationBatch; id: number; epoch: number }
  >();
  let pending:
    | {
        sequence: number;
        batch?: NotificationBatch;
        resolve(value: Record<string, unknown>): void;
        reject(): void;
      }
    | undefined;
  async function kill() {
    const current = child;
    child = undefined;
    active.clear();
    epoch = 0;
    pending?.reject();
    pending = undefined;
    current?.kill('SIGKILL');
    await current?.exited;
  }
  function unavailable() {
    status = { available: false, actions: false, code: 'NOTIFICATIONS_UNAVAILABLE' };
  }
  function event(value: Record<string, unknown>) {
    if (value.event === 'owner') {
      if (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0)
        throw Error('Invalid owner epoch');
      epoch = value.epoch as number;
      active.clear();
      status = { available: null, actions: null, code: null };
      return;
    }
    if (value.sequence !== undefined) {
      if (value.sequence !== pending?.sequence) throw Error('Invalid reply');
      if (
        pending.batch &&
        value.available === true &&
        value.epoch === epoch &&
        Number.isSafeInteger(value.id) &&
        (value.id as number) > 0
      ) {
        const id = value.id as number;
        active.set(pending.batch.category, { batch: pending.batch, id, epoch });
        options.delivery(pending.batch, id, false);
      }
      pending.resolve(value);
      pending = undefined;
      return;
    }
    const category = value.category as NotificationCategory,
      current = active.get(category);
    if (
      !current ||
      current.id !== value.id ||
      current.epoch !== value.epoch ||
      value.epoch !== epoch
    )
      return;
    if (value.event === 'open') reopen();
    else if (value.event === 'closed') {
      // Only protocol reason 2 means user dismissal. Expiry/programmatic/unknown do not.
      if (value.reason === 2) options.delivery(current.batch, current.id, true);
      active.delete(category);
    } else throw Error('Invalid event');
  }
  async function start() {
    if (child) return;
    const python =
      options.python ??
      (typeof NANOSYNC_NOTIFY_PYTHON === 'string'
        ? NANOSYNC_NOTIFY_PYTHON
        : process.env.NANOSYNC_NOTIFY_PYTHON);
    const typelibs =
      options.typelibs ??
      (typeof NANOSYNC_NOTIFY_TYPELIB === 'string'
        ? NANOSYNC_NOTIFY_TYPELIB
        : process.env.NANOSYNC_NOTIFY_TYPELIB);
    if (
      !python?.startsWith('/nix/store/') ||
      !typelibs ||
      !typelibs.split(':').every((path) => path.startsWith('/nix/store/'))
    )
      throw Error('Notification helper unavailable');
    const environment: Record<string, string> = { GI_TYPELIB_PATH: typelibs };
    for (const key of [
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR',
      'HOME',
      'DISPLAY',
      'GDK_BACKEND',
      'LD_LIBRARY_PATH',
    ])
      if (process.env[key]) environment[key] = process.env[key]!;
    const current = Bun.spawn([python, '-I', '-u', '-c', notifyHelper], {
      env: environment,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    child = current;
    reading = (async () => {
      const reader = (current.stdout as ReadableStream<Uint8Array>).getReader();
      let buffer = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done || child !== current) break;
          buffer += new TextDecoder().decode(chunk.value);
          if (Buffer.byteLength(buffer) > 16384) throw Error('Notification reply too large');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const value: unknown = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw Error('Invalid notification reply');
            event(value as Record<string, unknown>);
          }
        }
      } catch {
        if (child === current) unavailable();
      } finally {
        reader.releaseLock();
        if (child === current) {
          if (!stopped) unavailable();
          await kill();
        }
      }
    })();
  }
  async function request(operation: string, batch?: NotificationBatch) {
    if (pending) throw Error('Notification helper busy');
    await start();
    const reply = Promise.withResolvers<Record<string, unknown>>();
    // A pipe/reader can fail while the write is still flushing, before the reply await.
    void reply.promise.catch(() => {});
    const id = ++sequence;
    pending = {
      sequence: id,
      batch,
      resolve: reply.resolve,
      reject: () => reply.reject(Error('Notification helper stopped')),
    };
    const watchdog = setTimeout(() => {
      unavailable();
      void kill();
    }, 5000);
    try {
      const input = child!.stdin;
      if (typeof input === 'number' || !input)
        throw Error('Notification helper input unavailable');
      input.write(
        JSON.stringify({
          sequence: id,
          operation,
          ...(batch ? { category: batch.category, body: batch.body } : {}),
        }) + '\n',
      );
      await input.flush();
      return await reply.promise;
    } catch (error) {
      await kill();
      throw error;
    } finally {
      clearTimeout(watchdog);
    }
  }
  return {
    get status() {
      return { ...status };
    },
    async probe() {
      if (stopped) return false;
      try {
        const reply = await request('probe');
        if (
          reply.available !== true ||
          reply.epoch !== epoch ||
          typeof reply.actions !== 'boolean'
        )
          throw Error('Unavailable');
        status = { available: true, actions: reply.actions, code: null };
        return true;
      } catch {
        unavailable();
        return false;
      }
    },
    async submit(batch: NotificationBatch) {
      if (stopped) return;
      try {
        const reply = await request('submit', batch);
        if (
          reply.available !== true ||
          reply.epoch !== epoch ||
          !Number.isSafeInteger(reply.id) ||
          (reply.id as number) < 1 ||
          typeof reply.actions !== 'boolean'
        )
          throw Error('Not accepted');
        status = { available: true, actions: reply.actions, code: null };
      } catch {
        unavailable();
      }
    },
    async close() {
      stopped = true;
      if (pending) await kill();
      if (child) {
        try {
          await request('stop');
        } catch {
          /* Uncertain native close; kill/reap below. */
        }
      }
      await kill();
      await reading;
    },
  };
}
