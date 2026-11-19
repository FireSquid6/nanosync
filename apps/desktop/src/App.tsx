import { useEffect, useState } from 'react';
import { Button } from '../../../packages/admin-ui/src/paper/Button';
import { Onboarding } from './Onboarding';
import { Folders } from './Folders';
import type { DesktopCommand, DesktopReply, DesktopSnapshot } from './rpc';

export type ClientSend = (command: DesktopCommand) => Promise<DesktopReply>;
export function App({ send }: { send: ClientSend }) {
  const [screen, setScreen] = useState<'loading' | 'setup' | 'folders'>('loading');
  const [initial, setInitial] = useState<DesktopSnapshot>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void send({ type: 'snapshot' })
      .then((reply) => {
        if (!active) return;
        if (!reply.ok) {
          setError(reply.message);
          return;
        }
        setInitial(reply.snapshot);
        setScreen(reply.snapshot.removal || reply.snapshot.status?.bindings.length ? 'folders' : 'setup');
      })
      .catch(() => {
        if (active) setError('Client state unavailable. Retry without resetting local state.');
      });
    return () => {
      active = false;
    };
  }, [send, retry]);
  function showFolders() {
    setInitial(undefined);
    setScreen('folders');
  }
  if (screen === 'setup')
    return <Onboarding send={send} onDone={showFolders} onCancel={showFolders} />;
  if (screen === 'folders')
    return <Folders send={send} initial={initial} onConnect={() => setScreen('setup')} />;
  return (
    <main className="nv-root desktop loading">
      <h1>Nanosync</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button
            onClick={() => {
              setError('');
              setRetry((value) => value + 1);
            }}
          >
            Retry loading state
          </Button>
        </>
      ) : (
        <p role="status">Reading client state…</p>
      )}
    </main>
  );
}
