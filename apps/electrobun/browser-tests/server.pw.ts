import { expect, test } from '@playwright/test';

test('browser harness serves only mainview assets, never repository files', async ({ request }) => {
  for (const path of ['/', '/index.html', '/index.css', '/index.js']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
  }
  expect((await request.get('/index.css')).headers()['content-type']).toContain('text/css');
  expect((await request.get('/index.js')).headers()['content-type']).toContain('javascript');
  for (const path of ['/package.json', '/src/mainview/index.ts', '/.git/config', '/unknown', '/index.ts', '/%2e%2e/package.json', '/index.css/../../package.json']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  const head = await request.head('/index.css');
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  const method = await request.post('/');
  expect(method.status()).toBe(405);
  expect(method.headers()['allow']).toBe('GET, HEAD');
});
