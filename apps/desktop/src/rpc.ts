import type {
  OnboardingSnapshot,
  RemoteVault,
  LifecyclePreferences,
  EnrollmentResult,
  listConflicts,
  viewIgnores,
  inspectRemoval,
} from '@nanosync/client-service';

export type DesktopCommand =
  | {
      type: 'snapshot' | 'initialize' | 'cancel-enrollment' | 'pick-folder' | 'quit';
    }
  | {
      type: 'migrate' | 'resume-migration' | 'rollback-migration' | 'resume-cleanup';
      confirmed: true;
    }
  | {
      type: 'enroll';
      url: string;
      alias: string;
      deviceName: string;
      password: string;
      fresh: boolean;
      retryCredentialWrite: boolean;
    }
  | { type: 'vaults'; serverId: string }
  | { type: 'key-status'; serverId: string; vaultId: string }
  | {
      type: 'unlock';
      serverId: string;
      vaultId: string;
      recovery: string;
      retryCredentialWrite: boolean;
    }
  | {
      type: 'connect';
      serverId: string;
      vaultId: string;
      selection: string;
      confirmNonempty: boolean;
    }
  | {
      type: 'settings';
      lifecycle: LifecyclePreferences;
      expectedRevision: number;
    }
  | { type: 'start' | 'sync-now' | 'open-folder'; binding: string }
  | { type: 'pause-all'; paused: boolean; expectedRevision: number }
  | {
      type: 'pause-folder';
      binding: string;
      paused: boolean;
      expectedRevision: number;
    }
  | { type: 'conflicts' }
  | { type: 'open-conflict'; binding: string; conflict: string }
  | { type: 'ignores-view'; binding: string }
  | { type: 'ignores-validate'; text: string }
  | {
      type: 'ignores-set';
      binding: string;
      text: string;
      expectedFileSignature: string;
    }
  | { type: 'inspect-disconnect'; binding: string }
  | { type: 'inspect-server-removal'; serverId: string }
  | {
      type: 'remove';
      selection: string;
      force: boolean;
      stopOwner: boolean;
      confirmed: true;
    }
  | { type: 'resume-removal'; requestId: string; confirmed: true }
  | { type: 'administration'; urlIdentity: string };
export type DesktopSnapshot = Omit<OnboardingSnapshot, 'nativeEffects'> & {
  nativeEffects: {
    startup: 'not-installed' | 'applied' | 'unavailable';
    tray: 'not-installed' | 'applied' | 'unavailable';
    backgroundPolicy: 'not-applied' | 'applied';
  };
  clientRoot: string;
  administration: string[];
  runtimeErrors: Record<string, string>;
  lifecycle?: import('./lifecycle').LifecycleStatus;
};
export type DesktopReply =
  | {
      ok: true;
      snapshot: DesktopSnapshot;
      enrollment?: EnrollmentResult;
      vaults?: RemoteVault[];
      key?: { keyRequired: boolean; credentialWritePending: boolean };
      folder?: { selection: string; path: string; nonempty: boolean };
      cancelled?: boolean;
      binding?: string;
      started?: boolean;
      conflicts?: ReturnType<typeof listConflicts>;
      ignores?: ReturnType<typeof viewIgnores>;
      validation?: { valid: true } | { valid: false; code: string; line: number };
      removalPreview?: Awaited<ReturnType<typeof inspectRemoval>> & {
        selection: string;
      };
    }
  | { ok: false; code: string; message: string };
export type DesktopRPC = {
  bun: {
    requests: { client: { params: DesktopCommand; response: DesktopReply } };
    messages: {};
  };
  webview: { requests: {}; messages: {} };
};
