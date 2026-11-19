import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { sdk } from '../../../build/desktop/security';

function fatalHandler(native: boolean) {
  const source = readFileSync(join(sdk, 'source/package/src/sdks/main/proc/native.ts'), 'utf8');
  const start = source.indexOf('process.on("uncaughtException"');
  const end = source.indexOf('process.on("unhandledRejection"', start);
  if (start < 0 || end <= start) throw Error('SDK_FATAL_HANDLER_MISSING');
  const calls: unknown[] = [];
  let handler: (error: Error) => void = () => { throw Error('SDK_FATAL_HANDLER_NOT_REGISTERED'); };
  const unsafeStop = () => { throw Error('FATAL_STATUS_NOT_RECORDED_BEFORE_STOP'); };
  runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end)), {
    native,
    native_: { symbols: { stopEventLoop: unsafeStop, waitForShutdownComplete: unsafeStop, forceExit: unsafeStop } },
    core_: { symbols: { quitGracefully: (code: number, timeout: number) => calls.push({ code, timeout }) } },
    console: { error: (...args: unknown[]) => calls.push(args) },
    process: { on: (_name: string, callback: typeof handler) => { handler = callback; }, exit: (code: number) => calls.push({ code }) },
  });
  handler(Error('SYNTH_PASSWORD_71_SYNTH_RECOVERY_83'));
  return calls;
}

test('actual SDK fatal hook records nonzero through the core graceful API before native shutdown', () => {
  expect(fatalHandler(true)).toEqual([['SDK_SDKS_MAIN_PROC_NATIVE_TS_2650'], { code: 1, timeout: 5000 }]);
});

test('actual SDK fatal hook keeps its non-native nonzero exit and never logs the exception', () => {
  expect(fatalHandler(false)).toEqual([['SDK_SDKS_MAIN_PROC_NATIVE_TS_2650'], { code: 1 }]);
});
