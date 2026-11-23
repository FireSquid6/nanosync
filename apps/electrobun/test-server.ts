import { join } from 'node:path';

const view = join(import.meta.dir, 'src/mainview');
const result = await Bun.build({
  entrypoints: [join(view, 'index.ts')],
  target: 'browser',
});
if (!result.success) throw new AggregateError(result.logs, 'Mainview browser build failed');
const script = await result.outputs[0]!.text();
const live = await Bun.build({
  entrypoints: [join(view, 'live.ts')],
  target: 'browser',
  plugins: [{
    name: 'live-test-transport',
    setup(build) {
      build.onResolve({ filter: /^electrobun\/view$/ }, () => ({ path: join(import.meta.dir, 'browser-tests/live-transport.ts') }));
    },
  }],
});
if (!live.success) throw new AggregateError(live.logs, 'Live browser build failed');
const assets = new Map([
  ['/', { body: Bun.file(join(view, 'index.html')), type: 'text/html; charset=utf-8' }],
  ['/index.html', { body: Bun.file(join(view, 'index.html')), type: 'text/html; charset=utf-8' }],
  ['/index.css', { body: Bun.file(join(view, 'index.css')), type: 'text/css; charset=utf-8' }],
  ['/index.js', { body: script, type: 'text/javascript; charset=utf-8' }],
  ['/live/live.html', { body: Bun.file(join(view, 'live.html')), type: 'text/html; charset=utf-8' }],
  ['/live/index.js', { body: await live.outputs[0]!.text(), type: 'text/javascript; charset=utf-8' }],
  ['/live/index.css', { body: Bun.file(join(view, 'index.css')), type: 'text/css; charset=utf-8' }],
]);

Bun.serve({
  hostname: '127.0.0.1',
  port: 3101,
  fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const path = new URL(request.url).pathname;
    if (path === '/live.html') return Response.redirect(new URL('/live/live.html', request.url), 302);
    const asset = assets.get(path);
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-store' },
    });
  },
});
