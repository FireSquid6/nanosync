import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureReplace } from '../src/security.ts';
import { main } from '../src/main.ts';
import { pendingEnrollments } from '../src/vault-client.ts';

// Real HTTP boundary: delayed or non-JSON proxy responses must not defeat CLI cancellation.
async function scenario(run: (ctx: { root: string; invoke: (wait: number) => Promise<number>; calls: string[]; setMode: (mode: string) => void }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'enrollment-network-'));
  const calls: string[] = [];
  let mode = '', failed = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (mode === path) await Bun.sleep(800);
    if ((mode === 'html' || mode === 'empty') && path === '/v1/capabilities' && !failed) { failed = true; return new Response(mode === 'html' ? '<html>Unavailable</html>' : null, {status:503}); }
    if (path === '/v1/auth/password') return Response.json({sessionToken:'A'.repeat(43)});
    if (path === '/v1/capabilities') return Response.json({protocolVersions:[1], revisionFormatVersions:[1], objectFormatVersions:[1], objectTypes:['manifest'], webAdministration:{enabled:false}, limits:{maximumObjectCiphertextBytes:8192, maximumReferencesPerRevision:1, maximumParents:1, maximumPresenceQuery:1, maximumPageSize:1, maximumJsonMetadataBytes:1024, maximumIdempotencyKeyLength:32, chunkSizeBytes:4194304}});
    return Response.json({status:'pending'});
  }});
  const out = spyOn(console, 'log').mockImplementation(() => {}), err = spyOn(console, 'error').mockImplementation(() => {});
  const previous = process.env.NANOSYNC_PASSWORD;
  process.env.NANOSYNC_PASSWORD = 'network-test-password';
  try {
    await run({root, calls, setMode: value => { mode = value; }, invoke: wait => main(['client','connections','add','--client-dir',root,'--url',server.url.href,'--alias','test','--wait-ms',String(wait),'--json','--non-interactive'])});
  } finally {
    server.stop(true); out.mockRestore(); err.mockRestore(); rmSync(root,{recursive:true,force:true});
    if (previous === undefined) delete process.env.NANOSYNC_PASSWORD; else process.env.NANOSYNC_PASSWORD = previous;
  }
}

test('Ctrl-C cancels the initial password exchange promptly', async () => {
  await scenario(async ({invoke, calls, setMode}) => {
    setMode('/v1/auth/password');
    const started = Date.now();
    const result = invoke(2000);
    while (!calls.includes('/v1/auth/password')) await Bun.sleep(5);
    process.emit('SIGINT');
    expect(await result).toBe(130);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

for (const path of ['/v1/capabilities', '/v1/auth/enrollments', '/v1/auth/enrollments/status']) {
  test(`finite wait cancels stalled ${path} and retains resumable identity`, async () => {
    await scenario(async ({root, invoke, setMode}) => {
      expect(await invoke(0)).toBe(3);
      const before = pendingEnrollments(root)[0]!;
      setMode(path);
      const started = Date.now();
      expect(await invoke(path.endsWith('/status') ? 1200 : 80)).toBe(3);
      expect(Date.now() - started).toBeLessThan(path.endsWith('/status') ? 1600 : 500);
      expect(pendingEnrollments(root)[0]).toEqual(before);
    });
  });
}

for (const body of ['html', 'empty']) test(`${body} proxy 503 is retried rather than reported as malformed JSON`, async () => {
  await scenario(async ({invoke, calls, setMode}) => {
    setMode(body);
    expect(await invoke(400)).toBe(3);
    expect(calls.filter(path => path === '/v1/capabilities')).toHaveLength(2);
  });
});

test('request expiry cancels an in-flight exchange and durably retains the expired identity', async () => {
  await scenario(async ({root, invoke, setMode}) => {
    expect(await invoke(0)).toBe(3);
    const before = pendingEnrollments(root)[0]!;
    const file = join(root, 'pending', readdirSync(join(root, 'pending'))[0]!);
    secureReplace(file, JSON.stringify({...before, expiresAtMs:Date.now() + 80}));
    setMode('/v1/auth/enrollments');
    const started = Date.now();
    expect(await invoke(2000)).toBe(4);
    expect(Date.now() - started).toBeLessThan(500);
    expect(pendingEnrollments(root)[0]).toMatchObject({deviceId:before.deviceId, token:before.token, status:'expired'});
  });
});
