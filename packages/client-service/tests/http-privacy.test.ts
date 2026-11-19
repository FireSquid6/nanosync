import { afterEach, expect, spyOn, test } from 'bun:test';
import { RemoteError } from '@nanosync/sync-core';
import { api } from '../src/client.ts';

const sentinel = 'synthetic-password-token-key-sentinel';
afterEach(() => { mockFetch?.mockRestore(); });
let mockFetch: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

test('HTTP errors only expose validated protocol codes, never wire messages or validation paths', async () => {
  const cases = [
    { body: { protocolVersion: 1, code: sentinel, message: sentinel }, code: 'ERROR' },
    { body: { protocolVersion: 1, code: 'UNAUTHORIZED', message: sentinel }, code: 'UNAUTHORIZED' },
    { body: { protocolVersion: 1, code: 'UNAUTHORIZED', message: sentinel, [sentinel]: true }, code: 'ERROR' },
    { body: { code: 'UNAUTHORIZED', message: sentinel }, code: 'ERROR' },
  ];
  for (const entry of cases) {
    mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(entry.body, { status: 401 }));
    const error = await api('https://example.test', '/v1/head').catch(error => error);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ status: 401, code: entry.code });
    expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
    mockFetch.mockRestore();
  }
});

test('HTML, empty bodies and malformed JSON preserve HTTP status without reflecting content', async () => {
  for (const status of [200, 429, 503]) {
    for (const body of [`<html>${sentinel}</html>`, '', `{"${sentinel}": invalid}`]) {
      mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
      const error = await api('https://example.test', '/v1/head').catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
      if (status !== 200) expect(error).toMatchObject({ status, code: 'ERROR' });
      else expect(error.message).toBe('invalid remote JSON response');
      mockFetch.mockRestore();
    }
  }
});

test('known codes and retry metadata retain the CLI RemoteError contract', async () => {
  const { PROTOCOL_ERROR_CODES } = await import('@nanosync/protocol');
  for (const code of PROTOCOL_ERROR_CODES) {
    mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      protocolVersion: 1, code, message: sentinel, retryAfterSeconds: 30,
    }, { status: 429 }));
    const error = await api('https://example.test', '/v1/head').catch(error => error);
    expect(error).toMatchObject({ name: 'RemoteError', status: 429, code, retryAfterSeconds: 30 });
    if (code === 'VAULT_DELETED') {
      expect(error.message).toContain('server 429: VAULT_DELETED');
      expect(error.message).toContain('Local files and keys are preserved');
    } else expect(error.message).toBe(`server 429: ${code}`);
    mockFetch.mockRestore();
  }
});

test('cancellation during error or success body reads is not normalized into a server error', async () => {
  for (const status of [200, 503]) {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const reason = new DOMException('cancelled', 'AbortError');
    mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(stream) {
        controller.signal.addEventListener('abort', () => stream.error(reason), { once: true });
        started.resolve();
      },
    }), { status }));
    const pending = api('https://example.test', '/v1/head', { signal: controller.signal });
    await started.promise;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    mockFetch.mockRestore();
  }
});

test('error bodies are bounded and duplicate-key envelopes are rejected', async () => {
  for (const body of [
    JSON.stringify({ protocolVersion: 1, code: 'UNAUTHORIZED', message: sentinel }) + ' '.repeat(2048),
    `{"protocolVersion":1,"code":"${sentinel}","code":"UNAUTHORIZED","message":"denied"}`,
  ]) {
    mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    const error = await api('https://example.test', '/v1/head').catch(error => error);
    expect(error).toMatchObject({ status: 503, code: 'ERROR' });
    expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
    mockFetch.mockRestore();
  }
});

test('oversized streaming and proxy HTML error bodies are cancelled without draining', async () => {
  for (const contentType of ['application/json', 'text/html']) {
    let cancelled = false, pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) { pulls++; stream.enqueue(new TextEncoder().encode(sentinel.repeat(100))); },
      cancel() { cancelled = true; },
    });
    mockFetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 503, headers: { 'content-type': contentType },
    }));
    await expect(api('https://example.test', '/v1/head')).rejects.toMatchObject({ status: 503, code: 'ERROR' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
    mockFetch.mockRestore();
  }
});
