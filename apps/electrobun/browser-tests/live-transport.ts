// This module replaces electrobun/view only in the browser test server bundle.
import type { ClientSnapshot, EnrollmentSummary, Result } from '../src/shared/rpc.ts';
type TestWindow = Window & {
  liveState?: ClientSnapshot;
  liveCalls?: { method: string; params?: unknown }[];
  liveFailure?: string;
  liveEnrollments?: EnrollmentSummary[];
  liveReplies?: Record<string, Result<unknown>>;
  liveDeferred?: string[];
  liveResolve?: Record<string, (result: Result<unknown>) => void>;
  livePush?: (snapshot: ClientSnapshot) => void;
  liveCompleteSync?: () => void;
};
const host = window as TestWindow;
export class Electroview {
  constructor(_options: unknown) {}
  static defineRPC(config: { handlers: { messages: { snapshotChanged(snapshot: ClientSnapshot): void } } }) {
    host.livePush = config.handlers.messages.snapshotChanged;
    host.liveCalls = [];
    return { proxy: { request: Object.fromEntries(['snapshot', 'sync', 'migrate', 'quit', 'listEnrollments', 'enroll', 'checkEnrollment', 'listVaults', 'chooseFolder', 'connectFolder', 'openAdministration'].map(method => [method, async (params?: { id: string }) => {
      // Keep credentials out of transport diagnostics as well as UI storage.
      const safe = params ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'password' && key !== 'recoveryKey')) : undefined;
      host.liveCalls!.push({ method, params: safe });
      if (host.liveDeferred?.includes(method)) return await new Promise<Result<unknown>>(resolve => { (host.liveResolve ??= {})[method] = resolve; });
      if (host.liveReplies?.[method]) return structuredClone(host.liveReplies[method]);
      if (method === 'listEnrollments') return { ok: true, value: host.liveEnrollments ?? [] };
      if (host.liveFailure) return { ok: false, error: host.liveFailure };
      if (method === 'snapshot') return { ok: true, value: host.liveState ?? { servers: [], folders: [] } };
      if (method === 'migrate') {
        const server = host.liveState?.servers.find(s => s.id === params?.id);
        if (server) { server.credentialMode = 'os'; delete server.migrationPending; }
      }
      if (method === 'sync') {
        const folder = host.liveState?.folders.find(f => f.id === params?.id);
        if (folder) {
          folder.status = 'Syncing'; folder.owner = 'Desktop'; folder.progress = 'Checking remote state';
          host.livePush!(structuredClone(host.liveState!));
          await new Promise<void>(resolve => { host.liveCompleteSync = resolve; });
          delete host.liveCompleteSync;
          folder.status = 'Up to date'; folder.owner = null; folder.progress = null;
          host.livePush!(structuredClone(host.liveState!));
        }
      }
      return { ok: true, value: null };
    }])) } };
  }
}
