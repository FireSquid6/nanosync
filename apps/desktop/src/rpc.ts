import type {
  OnboardingSnapshot,
  RemoteVault,
  LifecyclePreferences,
  EnrollmentResult,
} from '@nanosync/client-service';

export type DesktopCommand =
  | { type: 'snapshot' | 'initialize' | 'cancel-enrollment' | 'pick-folder' | 'quit' }
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
  | { type: 'settings'; lifecycle: LifecyclePreferences; expectedRevision: number }
  | { type: 'start'; binding: string }
  | { type: 'administration'; urlIdentity: string };
export type DesktopSnapshot = OnboardingSnapshot & {
  clientRoot: string;
  administration: string[];
  runtimeErrors: Record<string, string>;
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
    }
  | { ok: false; code: string; message: string };
export type DesktopRPC = {
  bun: { requests: { client: { params: DesktopCommand; response: DesktopReply } }; messages: {} };
  webview: { requests: {}; messages: {} };
};
