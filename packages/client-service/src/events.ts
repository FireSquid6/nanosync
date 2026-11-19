export type EnrollmentEvent =
  | { type: 'connecting' }
  | { type: 'verification'; deviceId: string; verificationCode: string }
  | { type: 'administration'; url: string }
  | { type: 'waiting'; progress: boolean }
  | { type: 'retrying'; delayMs: number }
  | { type: 'outage-retained' }
  | { type: 'approved' }
  | { type: 'terminal'; status: 'denied' | 'expired' };

export type SyncEvent =
  | { type: 'checking' | 'scanning' | 'complete' | 'paused' }
  | { type: 'transfer'; direction: 'upload' | 'download'; count: number; bytes: number };
