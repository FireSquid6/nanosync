import { expect, test } from 'bun:test';
import { parseOwnerActor, parseOwnerEnrollmentAction, enrollmentVerificationCode, OWNER_GENESIS_AUTHOR_ID, parseDeviceId } from '../src/index.ts';
const id = '123e4567-e89b-12d3-a456-426614174000';
test('owner authority and exact enrollment identity are strict', () => {
  expect(parseOwnerActor({ origin: 'browser', actorId: null })).toEqual({ origin: 'browser', actorId: null });
  expect(() => parseOwnerActor({ origin: 'device', actorId: id })).toThrow();
  expect(() => parseOwnerEnrollmentAction({ protocolVersion: 1, deviceId: 'Phone', decision: 'approve' })).toThrow();
  expect(() => parseOwnerEnrollmentAction({ protocolVersion: 1, deviceId: id, decision: 'deny', name: 'Phone' })).toThrow();
  expect(parseDeviceId(OWNER_GENESIS_AUTHOR_ID)).toBe(OWNER_GENESIS_AUTHOR_ID);
});
test('verification codes bind immutable request identity, not display names', () => {
  const fingerprint = Buffer.alloc(32, 1).toString('base64url');
  expect(enrollmentVerificationCode(id, fingerprint)).toBe(enrollmentVerificationCode(id, fingerprint));
  expect(enrollmentVerificationCode(id, fingerprint)).not.toBe(enrollmentVerificationCode(id, Buffer.alloc(32, 2).toString('base64url')));
});
