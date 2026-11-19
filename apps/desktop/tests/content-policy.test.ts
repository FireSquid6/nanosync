import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('secret-bearing product HTML and real SDK RPC fixture share a restrictive packaged-content policy', () => {
  function policy(path: string) {
    const html = readFileSync(path, 'utf8');
    const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    expect(match).not.toBeNull();
    return match![1]!;
  }
  const product = policy(join(import.meta.dir, '../src/index.html'));
  expect(policy(join(import.meta.dir, 'native/index.html'))).toBe(product);
  expect(product).toBe(
    "default-src 'none'; script-src views:; style-src views: 'unsafe-inline'; connect-src ws://127.0.0.1:*; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  );
  const script = product.split(';').find((directive) => directive.trim().startsWith('script-src'))!;
  expect(script).not.toContain('unsafe-inline');
  expect(script).not.toContain('unsafe-eval');
});
