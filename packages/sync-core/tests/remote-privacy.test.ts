import { expect, test } from 'bun:test';
import { HttpRemote, RemoteError } from '../src/index.ts';

const sentinel = 'synthetic-password-token-key-sentinel';
const envelope = (code: string) => ({ protocolVersion: 1, code, message: sentinel });

const capabilities = {
  protocolVersions: [1], revisionFormatVersions: [1], objectFormatVersions: [1],
  objectTypes: ['chunk', 'manifest'], webAdministration: { enabled: false },
  limits: { maximumObjectCiphertextBytes: 4194412, maximumReferencesPerRevision: 1000,
    maximumParents: 2, maximumPresenceQuery: 1000, maximumPageSize: 1000,
    maximumJsonMetadataBytes: 1048576, maximumIdempotencyKeyLength: 128, chunkSizeBytes: 4194304 },
};

function remote(response: () => Response, signal?: AbortSignal) {
  return new HttpRemote({ baseUrl: 'https://example.test', token: 'A'.repeat(43),
    fetch: async () => response(), signal });
}

test('remote errors never expose wire messages, unknown codes, or unknown field names', async () => {
  for (const [body, code] of [
    [envelope(sentinel), 'ERROR'],
    [envelope('UNAUTHORIZED'), 'UNAUTHORIZED'],
    [{ ...envelope('UNAUTHORIZED'), [sentinel]: true }, 'ERROR'],
    [{ ...envelope('UNAUTHORIZED'), protocolVersion: 2 }, 'ERROR'],
    [{ ...envelope('RATE_LIMITED'), retryAfterSeconds: -1 }, 'ERROR'],
  ] as const) {
    const error = await remote(() => Response.json(body, { status: 401 })).head().catch(error => error);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ status: 401, code });
    expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
  }
});

test('HTML, empty bodies and invalid JSON do not expose response snippets', async () => {
  for (const status of [200, 429, 503]) {
    for (const body of [`<html>${sentinel}</html>`, '', `{"${sentinel}": invalid}`, `{"${sentinel}\\uINVALID": 1}`]) {
      const error = await remote(() => new Response(body, { status, headers: { 'content-type': 'application/json' } }))
        .head().catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
      if (status !== 200) expect(error).toMatchObject({ status, code: 'ERROR' });
      else expect(['invalid remote JSON response', 'invalid JSON value']).toContain(error.message);
    }
  }
});

test('known protocol codes retain status and retry metadata; deleted vault guidance stays actionable', async () => {
  const { PROTOCOL_ERROR_CODES } = await import('@nanosync/protocol');
  for (const code of PROTOCOL_ERROR_CODES) {
    const error = await remote(() => Response.json({ ...envelope(code), retryAfterSeconds: 30 }, { status: 429 }))
      .head().catch(error => error);
    expect(error).toMatchObject({ status: 429, code, retryAfterSeconds: 30 });
    expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
    if (code === 'VAULT_DELETED') expect(error.message).toContain('Local files and keys are preserved');
    else expect(error.message).toBe(`server 429: ${code}`);
  }
});

test('cancellation during an HTTP error body read remains cancellation', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const reason = new DOMException('cancelled', 'AbortError');
  const client = remote(() => new Response(new ReadableStream({
    start(stream) {
      controller.signal.addEventListener('abort', () => stream.error(reason), { once: true });
      started.resolve();
    },
  }), { status: 503, headers: { 'content-type': 'application/json' } }), controller.signal);
  const pending = client.head();
  await started.promise;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

test('validated retryable codes still retry, while unknown envelopes and revocation remain terminal', async () => {
  const { encryptChunk } = await import('../src/index.ts');
  const vaultId = '123e4567-e89b-42d3-a456-426614174000';
  const object = await encryptChunk(new Uint8Array([1]), new Uint8Array(32).fill(7), vaultId);

  for (const code of ['RATE_LIMITED', 'UNAVAILABLE', 'UNAUTHORIZED', sentinel]) {
    let attempts = 0;
    const client = new HttpRemote({ baseUrl: 'https://example.test', token: 'A'.repeat(43), retries: 2,
      fetch: async input => {
        if ((input as Request).method !== 'PUT') return Response.json(capabilities);
        attempts++;
        return Response.json({ ...envelope(code), retryAfterSeconds: 30 }, { status: 503 });
      },
    });
    const error = await client.upload(object, vaultId, 'a'.repeat(32)).catch(error => error);
    expect(attempts).toBe(['RATE_LIMITED', 'UNAVAILABLE'].includes(code) ? 3 : 1);
    expect(error).toMatchObject({ status: 503, code: code === sentinel ? 'ERROR' : code });
    expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
  }
});

test('successful structured responses cannot expose unknown field names through validation errors', async () => {
  const error = await remote(() => Response.json({ ...capabilities, [sentinel]: true })).capabilities().catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(`${error}\n${JSON.stringify(error)}`).not.toContain(sentinel);
  expect(error.message).toBe('invalid remote response');
});
