import { dlopen, FFIType, ptr, CString, type Pointer } from 'bun:ffi';
import { constants } from 'node:os';
import type { NativeEffect } from './lifecycle';
import { unavailable } from './lifecycle';

declare const NANOSYNC_LIBSYSTEMD: string;

export type SessionFacts = {
  id: string;
  uid: number;
  type: string;
  display: string;
  state: string;
  remote: number;
};
export function validateSession(
  facts: SessionFacts,
  uid: number,
  display: string,
  backend = 'x11',
  association: 'pid' | 'inherited' = 'pid',
): NativeEffect {
  const graphical = facts.type === 'x11' || facts.type === 'wayland';
  const displayMatches =
    facts.display === display ||
    (facts.type === 'wayland' && association === 'pid' && !facts.display);
  if (
    facts.uid !== uid ||
    facts.remote !== 0 ||
    !graphical ||
    !display ||
    !displayMatches ||
    backend !== 'x11'
  )
    return unavailable(
      'Session association or the app X11/XWayland backend is unproven. Desktop work is blocked. Native GTK Wayland is not yet validated.',
    );
  if (!['active', 'online'].includes(facts.state))
    return unavailable(
      'The associated graphical session ended or is closing. Desktop work is stopped.',
    );
  return {
    available: true,
    applied: true,
    message: `Associated local ${facts.type === 'wayland' ? 'Wayland session with XWayland app backend' : 'X11 session'} monitored through logind. Switching VTs or locking does not stop sync. Installed-session validation remains required.`,
  };
}

export function associatedSession(
  ownSession: () => string,
  inherited: string | undefined,
): { id: string; source: 'pid' | 'inherited' } {
  try {
    return { id: ownSession(), source: 'pid' };
  } catch (error) {
    if (
      (error as { code?: number }).code !== -constants.errno.ENODATA ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(inherited ?? '')
    )
      throw error;
    return { id: inherited!, source: 'inherited' };
  }
}

export function sessionMonitor(
  inspect: () => NativeEffect,
  flush: () => boolean,
  onLost: () => void,
) {
  let status: NativeEffect;
  try {
    status = inspect();
  } catch {
    status = unavailable(
      'Graphical-session association is unavailable. Desktop work is blocked.',
    );
  }
  let lost = false;
  return {
    get status() {
      return status;
    },
    check() {
      if (lost || !status.applied) return;
      try {
        if (!flush()) throw Error('SESSION_MONITOR_LOST');
        status = inspect();
      } catch {
        status = unavailable(
          'Graphical-session monitoring was lost. Desktop work is stopped; relaunch from the associated session.',
        );
      }
      if (!status.applied) {
        lost = true;
        onLost();
      }
    },
  };
}

/** libsystemd owns the sd-login protocol and monitor, not application D-Bus wire code. */
export function linuxSession(onLost: () => void) {
  const symbols = {
    sd_pid_get_session: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    sd_session_get_uid: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
    sd_session_get_type: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
    sd_session_get_display: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
    sd_session_get_state: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
    sd_session_is_remote: { args: [FFIType.cstring], returns: FFIType.i32 },
    sd_login_monitor_new: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
    sd_login_monitor_flush: { args: [FFIType.ptr], returns: FFIType.i32 },
    sd_login_monitor_unref: { args: [FFIType.ptr], returns: FFIType.ptr },
    free: { args: [FFIType.ptr], returns: FFIType.void },
  } as const;
  let library: ReturnType<typeof dlopen<typeof symbols>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let monitor: Pointer | undefined;
  let status = unavailable(
    'No proven graphical-session association. Desktop work is blocked; CLI work remains independent.',
  );
  let id = '';
  let check = () => {};
  function close() {
    clearInterval(timer);
    if (monitor) library?.symbols.sd_login_monitor_unref(monitor);
    monitor = undefined;
    library?.close();
    library = undefined;
    if (status.applied)
      status = unavailable(
        'Graphical-session monitoring stopped. Desktop synchronization is stopped.',
      );
  }
  try {
    const libraryPath =
      typeof NANOSYNC_LIBSYSTEMD === 'string'
        ? NANOSYNC_LIBSYSTEMD
        : (process.env.NANOSYNC_LIBSYSTEMD ?? 'libsystemd.so.0');
    library = dlopen(libraryPath, symbols);
    const api = library.symbols;
    function stringResult(
      call: (output: ReturnType<typeof ptr>) => number,
      optional = false,
    ): string {
      const output = new BigUint64Array(1);
      const result = call(ptr(output));
      if (optional && result === -constants.errno.ENODATA) return '';
      if (result < 0 || !output[0])
        throw Object.assign(Error('SESSION_UNAVAILABLE'), { code: result });
      const address = Number(output[0]) as Pointer;
      try {
        return new CString(address).toString();
      } finally {
        api.free(address);
      }
    }
    // Own PID only. A user-manager process is not assigned an arbitrary UID session.
    // User-manager launches need an explicitly inherited ID, revalidated below;
    // never enumerate/pick another UID session or fall back after a permission failure.
    const association = associatedSession(
      () => stringResult((output) => api.sd_pid_get_session(process.pid, output)),
      process.env.XDG_SESSION_ID,
    );
    id = association.id;
    const session = Buffer.from(`${id}\0`);
    const output = new BigUint64Array(1);
    if (api.sd_login_monitor_new(Buffer.from('session\0'), ptr(output)) < 0 || !output[0])
      throw Error('SESSION_MONITOR_UNAVAILABLE');
    monitor = Number(output[0]) as Pointer;
    function inspect(): NativeEffect {
      const uid = new Uint32Array(1);
      if (api.sd_session_get_uid(session, ptr(uid)) < 0) throw Error('SESSION_LOST');
      return validateSession(
        {
          id,
          uid: uid[0]!,
          remote: api.sd_session_is_remote(session),
          type: stringResult((output) => api.sd_session_get_type(session, output)),
          display: stringResult((output) => api.sd_session_get_display(session, output), true),
          state: stringResult((output) => api.sd_session_get_state(session, output)),
        },
        process.getuid!(),
        process.env.DISPLAY ?? '',
        process.env.GDK_BACKEND ?? '',
        association.source,
      );
    }
    const monitored = sessionMonitor(
      inspect,
      () => api.sd_login_monitor_flush(monitor!) >= 0,
      onLost,
    );
    status = monitored.status;
    if (status.applied) {
      check = () => {
        monitored.check();
        status = monitored.status;
        if (!status.applied) clearInterval(timer);
      };
      timer = setInterval(check, 1000);
    }
  } catch {
    close();
  }
  return {
    // Unknown callers may activate only their matching display, never another login's window.
    identity: status.applied
      ? id
      : `unassociated:${process.env.DISPLAY ?? ''}:${process.env.WAYLAND_DISPLAY ?? ''}`,
    get status() {
      return status;
    },
    check() {
      if (library) check();
    },
    close,
  };
}
