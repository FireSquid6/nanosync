import { expect, spyOn, test } from 'bun:test';
import { ClientError, type EnrollmentEvent } from '@nanosync/client-service';
import { CliError } from '../src/prompts.ts';
import { enrollmentEvent, syncEvent } from '../src/client-events.ts';
import { CliOutput } from '../src/output.ts';

test('shared errors retain CLI identity and exit codes', () => {
  const error = new ClientError('INTERRUPTED', 'interrupted', 130);
  expect(error).toBeInstanceOf(CliError);
  expect(error.exitCode).toBe(130);
});

test('enrollment event adapter preserves messages and JSON stderr routing', () => {
  const presentation = new CliOutput(true);
  const stdout = spyOn(console, 'log').mockImplementation(() => {});
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  const events: EnrollmentEvent[] = [
    { type: 'connecting' },
    { type: 'verification', deviceId: 'device', verificationCode: 'code' },
    { type: 'administration', url: 'https://example.test/admin' },
    { type: 'waiting', progress: true },
    { type: 'retrying', delayMs: 250 },
    { type: 'outage-retained' },
    { type: 'approved' },
    { type: 'terminal', status: 'denied' },
    { type: 'terminal', status: 'expired' },
  ];
  try {
    for (const event of events) enrollmentEvent(presentation, event);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(call => call[0])).toEqual([
      'nanosync server devices approve --device-id device',
      'Verification code: code',
      'Administration: https://example.test/admin',
      'Waiting for approval; Ctrl-C preserves this request for resume.',
      'Temporary outage; retrying in 250ms (request retained)',
      'Temporary outage; pending request retained. Retry the same command.',
      'Approved. Next: nanosync client vaults connect (no files transferred).',
      'Enrollment denied; review with the owner, then explicitly use --fresh for a new identity.',
      'Enrollment expired; review with the owner, then explicitly use --fresh for a new identity.',
    ]);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});

test('sync adapter preserves transfer rounding and human progress text', () => {
  const presentation = new CliOutput(false);
  const progress = spyOn(presentation, 'syncProgress').mockImplementation(() => {});
  try {
    syncEvent(presentation, { type: 'checking' }, false);
    syncEvent(presentation, { type: 'scanning' }, false);
    syncEvent(presentation, { type: 'transfer', direction: 'upload', count: 25, bytes: 1_048_576 }, true);
    syncEvent(presentation, { type: 'transfer', direction: 'download', count: 1, bytes: 1 }, true);
    syncEvent(presentation, { type: 'complete' }, false);
    expect(progress.mock.calls).toEqual([
      ['Connecting to server and checking sync state...', false],
      ['Scanning local files for changes...', false],
      ['Uploaded 25 encrypted objects (1.0 MiB).', true],
      ['Downloaded 1 encrypted objects (0.0 MiB).', true],
      ['Sync complete.', false],
    ]);
  } finally { progress.mockRestore(); }
});
