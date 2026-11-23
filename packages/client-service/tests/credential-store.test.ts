import { expect, test } from "bun:test";
import { CredentialStoreError, SecretToolStore, type SecretToolCommand } from "../src/credential-store.ts";
test('Secret Service uses attribute arguments and sends secrets only through stdin', () => {
  const calls: { args: string[]; input?: string }[] = [];
  const run: SecretToolCommand = (args, input) => { calls.push({ args, input }); return { status: 0, stdout: args[0] === 'lookup' ? 'the-secret\n' : '' }; };
  const store = new SecretToolStore(run);
  store.set('identity', 'the-secret'); expect(store.get('identity')).toBe('the-secret'); store.delete('identity');
  expect(calls.map(c => c.args[0])).toEqual(['store', 'lookup', 'clear']);
  expect(calls[0]?.input).toBe('the-secret');
  expect(JSON.stringify(calls.map(c => c.args))).not.toContain('the-secret');
});
test('missing entry is null but timeouts, locked sessions and tool failures are sanitized', () => {
  expect(new SecretToolStore(() => ({ status: 1 })).get('id')).toBeNull();
  for (const run of [
    () => ({ status: 1, stderr: 'private tool output' }),
    () => ({ status: null, error: new Error('private timeout detail') }),
    () => { throw new Error('private spawn detail'); },
  ]) {
    try { new SecretToolStore(run).get('id'); throw new Error('expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as CredentialStoreError).code).toBe('CREDENTIAL_STORE_LOCKED');
      expect(String(error)).not.toContain('private');
    }
  }
});
test('clear must positively succeed, not treat a missing/locked result as deleted', () => {
  expect(() => new SecretToolStore(() => ({ status: 1 })).delete('id')).toThrow(CredentialStoreError);
});
