import { expect, test } from 'bun:test';
import { MAX_BODY, MAX_FRAME, progressResponse, streamedOutcome } from '../src/sync-control-protocol.ts';

const failed = { head: null, events: [], error: { code: 'OPERATION_FAILED', exitCode: 2 } };
function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value) + '\n');
}

test('stream events are validated even when no progress callback is installed', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoded({ type: 'event', value: { type: 'checking', token: 'must-not-pass' } }));
    controller.enqueue(encoded({ type: 'result', value: failed }));
    controller.close();
  } });
  const error = await streamedOutcome(body).catch(error => error);
  expect(error).toMatchObject({ code: 'OWNER_UNAVAILABLE' });
});

test('decoder accepts late progress after more than 64 events and MAX_BODY total bytes', async () => {
  let count = 0, bytes = 0, latest = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    const value = count < 1000
      ? { type: 'event', value: { type: 'transfer', direction: 'upload', count: ++count, bytes: count * 4194304 } }
      : { type: 'result', value: failed };
    const frame = encoded(value);
    bytes += frame.length;
    controller.enqueue(frame);
    if (value.type === 'result') controller.close();
  } });
  expect(await streamedOutcome(body, event => {
    if (event.type === 'transfer') latest = event.count;
  })).toEqual(failed);
  expect(latest).toBe(1000);
  expect(bytes).toBeGreaterThan(MAX_BODY);
});

test('a live progress response keeps delivering beyond lifetime event and byte thresholds', async () => {
  let finished = 0, total = 0, latest = 0;
  const response = progressResponse(() => { finished++; });
  const reader = response.body.getReader();
  for (let count = 1; count <= 1000; count++) {
    response.publish({ type: 'transfer', direction: 'upload', count, bytes: count * 4194304 });
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value!.length).toBeLessThanOrEqual(MAX_FRAME);
    total += chunk.value!.length;
    latest = JSON.parse(new TextDecoder().decode(chunk.value)).value.count;
  }
  response.complete(failed);
  expect(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type).toBe('result');
  expect((await reader.read()).done).toBe(true);
  expect(latest).toBe(1000);
  expect(total).toBeGreaterThan(MAX_BODY);
  expect(finished).toBe(1);
});

test('slow readers retain one queued frame and coalesce only the latest pending progress', async () => {
  let finished = 0;
  const response = progressResponse(() => { finished++; });
  for (let count = 1; count <= 10000; count++) {
    response.publish({ type: 'transfer', direction: 'upload', count, bytes: count * 4194304 });
  }
  response.complete(failed);
  const reader = response.body.getReader(), counts: number[] = [];
  let frames = 0, bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    frames++; bytes += chunk.value.length;
    const frame = JSON.parse(new TextDecoder().decode(chunk.value));
    if (frame.type === 'event') counts.push(frame.value.count);
    else expect(frame.value).toEqual(failed);
  }
  expect(counts).toEqual([1, 10000]);
  expect(frames).toBe(3);
  expect(bytes).toBeLessThanOrEqual(3 * MAX_FRAME);
  expect(finished).toBe(1);
});

test('decoder bounds each unfinished frame, not a coalesced transport chunk', async () => {
  const frames = Array.from({ length: 1000 }, () => encoded({ type: 'event', value: { type: 'checking' } }));
  frames.push(encoded({ type: 'result', value: failed }));
  const chunk = Buffer.concat(frames);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(chunk); controller.close();
  } });
  expect(chunk.length).toBeGreaterThan(MAX_BODY);
  expect(await streamedOutcome(body)).toEqual(failed);
});

test('an unfinished oversized frame is cancelled after bounded input without waiting for a newline', async () => {
  let produced = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { produced += 128; controller.enqueue(new Uint8Array(128).fill(32)); },
    cancel() { cancelled = true; },
  });
  expect(await streamedOutcome(body).catch(error => error)).toMatchObject({ code: 'OWNER_UNAVAILABLE' });
  expect(produced).toBeLessThanOrEqual(MAX_FRAME + 256);
  expect(cancelled).toBe(true);
});

test('cancelling a backpressured progress response releases its subscriber once', async () => {
  let finished = 0;
  const response = progressResponse(() => { finished++; });
  response.publish({ type: 'checking' });
  response.publish({ type: 'scanning' });
  await response.body.cancel();
  response.publish({ type: 'complete' });
  response.complete(failed);
  response.fail();
  expect(finished).toBe(1);
});
