import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { sdk } from '../../../build/desktop/security';

const { createRPC, defineElectrobunRPC } = await import(join(sdk, 'source/package/src/shared/rpc.ts'));
const sentinel = 'SYNTH_PASSWORD_71_SYNTH_RECOVERY_83';

async function checkListeners(combined: boolean) {
  const release = Promise.withResolvers<void>();
  const logged = Promise.withResolvers<void>();
  const errors: unknown[][] = [];
  const orphans: unknown[] = [];
  const called: string[] = [];
  const expectedErrors = combined ? 2 : 6;
  const logger = spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args);
    if (errors.length === expectedErrors) logged.resolve();
  });
  const unhandled = (error: unknown) => { orphans.push(error); };
  process.on('unhandledRejection', unhandled);
  const asynchronous = (name: string) => async () => {
    called.push(name);
    await release.promise;
    throw Error(sentinel);
  };
  const synchronous = (name: string) => () => { called.push(name); throw Error(sentinel); };
  let receive: (packet: unknown) => Promise<void> = async () => { throw Error('FIXTURE_TRANSPORT_MISSING'); };
  const transport = { send() {}, registerHandler(handler: typeof receive) { receive = handler; } };
  try {
    if (combined) {
      const rpc = defineElectrobunRPC('webview', { handlers: { messages: {
        '*': asynchronous('configured-wildcard'), notice: synchronous('configured-named'),
      } } });
      rpc.setTransport(transport);
    } else {
      const rpc = createRPC({ transport });
      for (const kind of ['*', 'notice']) {
        rpc.addMessageListener(kind, asynchronous(`${kind}-first`));
        rpc.addMessageListener(kind, synchronous(`${kind}-middle`));
        rpc.addMessageListener(kind, asynchronous(`${kind}-last`));
      }
    }
    const dispatch = await Promise.race([
      receive({ type: 'message', id: 'notice', payload: null }).then(() => 'dispatched', () => 'rejected'),
      new Promise<string>((_resolve, reject) => AbortSignal.timeout(5000).addEventListener('abort', () => reject(Error('LISTENER_FIXTURE_DEADLINE')))),
    ]);
    // Async notification work is still pending; dispatch must not wait for it.
    expect(dispatch).toBe('dispatched');
    expect(called.length).toBe(expectedErrors);
    release.resolve();
    await logged.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(orphans).toEqual([]);
    expect(errors).toEqual(Array.from({ length: expectedErrors }, () => ['RPC_MESSAGE_HANDLER_FAILED']));
    expect(JSON.stringify(errors)).not.toContain(sentinel);
  } finally {
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);
    logger.mockRestore();
  }
}

test('actual SDK isolates mixed async/sync failures for every wildcard and named listener', () => checkListeners(false));
test('actual SDK also consumes configured global/named message handler failures', () => checkListeners(true));
