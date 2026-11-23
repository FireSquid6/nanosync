import { join } from 'node:path';

const view = join(import.meta.dir, 'src/mainview');
const result = await Bun.build({
  entrypoints: [join(view, 'index.ts')],
  target: 'browser',
});
if (!result.success) throw new AggregateError(result.logs, 'Mainview browser build failed');
const script = await result.outputs[0]!.text();
const assets = new Map([
  ['/', { body: Bun.file(join(view, 'index.html')), type: 'text/html; charset=utf-8' }],
  ['/index.html', { body: Bun.file(join(view, 'index.html')), type: 'text/html; charset=utf-8' }],
  ['/index.css', { body: Bun.file(join(view, 'index.css')), type: 'text/css; charset=utf-8' }],
  ['/index.js', { body: script, type: 'text/javascript; charset=utf-8' }],
]);

Bun.serve({
  hostname: '127.0.0.1',
  port: 3101,
  fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const asset = assets.get(new URL(request.url).pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-store' },
    });
  },
});
