import type { LifecyclePreferences } from '@nanosync/client-service';
import type { DesktopSnapshot } from './rpc';

export type NativeEffect = { available: boolean | null; applied: boolean; message: string };
export type LifecycleStatus = {
  startup: NativeEffect;
  tray: NativeEffect;
  session: NativeEffect;
  closing: boolean;
  shutdownError?: string;
};
export const unavailable = (message: string): NativeEffect => ({
  available: false,
  applied: false,
  message,
});

/** SDK vetoes are synchronous; never return an async event handler. */
export function createWindowLifecycle(native: {
  preferences(): LifecyclePreferences;
  hide(): void;
  show(): void;
  shutdown(): Promise<void>;
  quit(): void;
  failed(): void;
}) {
  let approved = false;
  let pending: Promise<void> | undefined;
  function quit() {
    if (approved) return;
    pending ??= native
      .shutdown()
      .then(() => {
        approved = true;
        native.quit();
      })
      .catch(() => {
        pending = undefined;
        native.failed();
      });
  }
  return {
    close(event: { response: { allow: boolean } }) {
      if (approved) return;
      event.response = { allow: false };
      if (pending) return;
      try {
        if (native.preferences().keepSyncingAfterClose) native.hide();
        else quit();
      } catch {
        quit();
      }
    },
    beforeQuit(event: { response: { allow: boolean } }) {
      if (approved) return;
      event.response = { allow: false };
      quit();
    },
    reopen() {
      native.show();
    },
    quit,
    get closing() {
      return pending !== undefined;
    },
  };
}

export function trayHealth(snapshot: DesktopSnapshot | undefined) {
  const attention =
    !snapshot ||
    !!snapshot.removal ||
    !!snapshot.credentials.migrationPending ||
    !!snapshot.credentials.cleanupPending ||
    !!snapshot.status?.bindings.some((binding) => binding.attentionRequired);
  return attention
    ? { attention: true, title: 'Nanosync — ◆ Needs attention' }
    : { attention: false, title: 'Nanosync — ● No intervention needed' };
}

export function startupHidden(startup: boolean, preferences: LifecyclePreferences) {
  return startup && preferences.keepSyncingAfterClose;
}

export function reconcileTick(
  pending: Promise<void> | undefined,
  reconcile: () => Promise<void>,
) {
  if (!pending) void reconcile();
}
