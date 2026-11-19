import { Electroview } from 'electrobun/view';
import type { FixtureRPC } from './rpc';
declare global { interface Window { __fixtureLogs: string[] } }

const sentinel = 'SYNTH_PASSWORD_71_SYNTH_RECOVERY_83';
const rpc = Electroview.defineRPC<FixtureRPC>({
  handlers: {
    requests: {
      syncFailure() { throw Error(sentinel); },
      async asyncFailure() { throw Error(sentinel); },
      report(): { href: string; socket: boolean; logs: string[] } { return { href: location.href, socket: view.hostSocketCanSend, logs: window.__fixtureLogs }; },
      popup({ url }) { return { denied: window.open(url, '_blank') === null, href: location.href }; },
    },
    messages: { '*': async () => { throw Error(sentinel); }, notice() { throw Error(sentinel); } },
  },
});
const view = new Electroview({ rpc });
console.log('FIXTURE_RENDERER_INITIALIZED');
const response = await rpc.request.echo(null);
console.log('FIXTURE_RENDERER_ECHO');
if (response.value !== 'PROTECTED_SYNTHETIC_RESULT') throw Error('FIXTURE_ECHO_FAILED');
await rpc.request.ready({ port: window.__electrobunHostSocketPort!, id: window.__electrobunWebviewId! });
