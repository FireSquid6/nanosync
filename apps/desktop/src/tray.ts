import { unavailable, type NativeEffect } from './lifecycle';
export type TrayHandle = {
  id: number;
  setTitle(title: string): void;
  setImage(path: string): void;
  setMenu(menu: { type: 'normal'; label: string; action: string }[]): void;
  on(name: 'tray-clicked', callback: (event: unknown) => void): void;
  remove(): void;
};
export function createTrayEffect(create: () => TrayHandle, open: () => void) {
  let tray: TrayHandle | undefined;
  function remove() {
    try {
      tray?.remove();
      tray = undefined;
      return true;
    } catch {
      return false;
    }
  }
  return {
    reconcile(
      enabled: boolean | null,
      watcher: boolean,
      health: { title: string; attention: boolean },
      registered = false,
    ): NativeEffect {
      if (enabled !== true) {
        if (!remove())
          return unavailable(
            'Tray removal failed. Integration state is uncertain; reopen with the launcher.',
          );
        return {
          available: null,
          applied: false,
          message:
            enabled === null
              ? 'Tray not chosen; no integration constructed.'
              : 'Tray is off. Reopen with the launcher.',
        };
      }
      if (!watcher) {
        if (!remove())
          return unavailable(
            'Tray host was lost and removal failed. Integration state is uncertain; reopen with the launcher.',
          );
        return unavailable(
          'No StatusNotifierWatcher. Tray is unavailable; reopen with the authenticated launcher.',
        );
      }
      try {
        if (!tray) {
          tray = create();
          if (!tray.id) throw Error('TRAY_UNAVAILABLE');
          tray.setMenu([{ type: 'normal', label: 'Open Nanosync', action: 'open' }]);
          tray.on('tray-clicked', (event) => {
            if ((event as { data?: { action?: unknown } })?.data?.action === 'open') open();
          });
        }
        tray.setTitle(health.title);
        tray.setImage(
          health.attention ? 'views://main/tray-attention.svg' : 'views://main/tray.svg',
        );
        if (!registered)
          return {
            available: true,
            applied: false,
            message:
              'Session tray host is available, but this process registration is not yet proven. Reopen with the launcher.',
          };
        return {
          available: true,
          applied: true,
          message:
            'Process registration observed in the session tray host. Linux menu: Open Nanosync only; no primary-icon activation API. Panel presentation is host-controlled.',
        };
      } catch {
        remove();
        return unavailable(
          'Tray construction/update failed. Reopen with the launcher; syncing does not require a tray.',
        );
      }
    },
    get id() {
      return tray?.id;
    },
    close: remove,
  };
}
