import { expect, test, spyOn, jest } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { enrollmentRequest } from '../src/enrollment.ts';
import { setupRequest } from '../src/setup-network.ts';

test('shared enrollment wire identity is stable and protocol validated', () => {
  const id = randomUUID(), fingerprint = randomBytes(32).toString('base64url');
  expect(enrollmentRequest(id,'desktop',fingerprint)).toEqual(enrollmentRequest(id,'desktop',fingerprint));
  expect(() => enrollmentRequest('../bad','desktop',fingerprint)).toThrow();
  expect(() => enrollmentRequest(id,'name\n',fingerprint)).toThrow();
});

test('network rejects redirects rather than forwarding credentials to another origin', async () => {
  let foreignCalls = 0;
  const foreign = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>{foreignCalls++;return Response.json({});}});
  const source = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.redirect(foreign.url.href,307)});
  try {
    await expect(setupRequest(source.url.href,'/v1/auth/password',{method:'POST',body:'private-password'},'private-token')).rejects.toThrow('check the URL and network');
    expect(foreignCalls).toBe(0);
  } finally {await source.stop(true);await foreign.stop(true);}
});

test('network bounds response bytes and never includes server bodies in errors', async () => {
  let mode = 'large';
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>mode==='large'?new Response('x'.repeat(1_048_577)):new Response('PRIVATE SERVER BODY',{status:500})});
  try {
    await expect(setupRequest(server.url.href,'/v1/vaults')).rejects.toThrow('invalid response');
    mode = 'error';
    try {await setupRequest(server.url.href,'/v1/vaults');throw new Error('expected failure');}
    catch (error) { expect((error as Error).message).not.toContain('PRIVATE'); }
  } finally {await server.stop(true);}
});

test('deadline covers a stalled response body, not just response headers', async () => {
  jest.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>(resolve=>{entered=resolve;});
  const mocked = spyOn(globalThis,'fetch').mockImplementation(Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const body = new ReadableStream({start(controller) {
      init!.signal!.addEventListener('abort',()=>controller.error(new Error('aborted')));
      entered();
    }});
    return new Response(body);
  }, {preconnect:fetch.preconnect}));
  try {
    const result = setupRequest('https://example.com','/v1/vaults');
    await started;
    jest.advanceTimersByTime(10_000);
    await expect(result).rejects.toThrow('check the URL and network');
  } finally {mocked.mockRestore();jest.useRealTimers();}
});
