import type { EnrollmentEvent, SyncEvent } from '@nanosync/client-service';
import type { CliOutput } from './output.ts';

export function enrollmentEvent(presentation: CliOutput, event: EnrollmentEvent): void {
  switch (event.type) {
    case 'connecting': presentation.progress('Connecting to server…'); break;
    case 'verification':
      presentation.info(`nanosync server devices approve --device-id ${event.deviceId}`);
      presentation.info(`Verification code: ${event.verificationCode}`);
      break;
    case 'administration': presentation.info(`Administration: ${event.url}`); break;
    case 'waiting':
      presentation.info('Waiting for approval; Ctrl-C preserves this request for resume.');
      if (event.progress) presentation.progress('Waiting for device approval…');
      break;
    case 'retrying':
      presentation.info(`Temporary outage; retrying in ${event.delayMs}ms (request retained)`);
      break;
    case 'outage-retained':
      presentation.info('Temporary outage; pending request retained. Retry the same command.');
      break;
    case 'approved':
      presentation.info('Approved. Next: nanosync client vaults connect (no files transferred).');
      break;
    case 'terminal':
      presentation.info(`Enrollment ${event.status}; review with the owner, then explicitly use --fresh for a new identity.`);
      break;
  }
}

export function syncEvent(presentation: CliOutput, event: SyncEvent, watch: boolean): void {
  let message: string;
  switch (event.type) {
    case 'checking': message = 'Connecting to server and checking sync state...'; break;
    case 'scanning': message = 'Scanning local files for changes...'; break;
    case 'complete': message = 'Sync complete.'; break;
    case 'transfer': {
      const verb = event.direction === 'download' ? 'Downloaded' : 'Uploaded';
      message = `${verb} ${event.count} encrypted objects (${(event.bytes / 1_048_576).toFixed(1)} MiB).`;
      break;
    }
  }
  presentation.syncProgress(message, watch);
}
